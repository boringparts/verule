import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  getEngineVersion,
  runCheck,
  type CheckReport,
} from "@verule/sdk";
import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  parseCliInvocation,
  schemaCapability,
  text,
  versionCapability,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import { z } from "zod";

import type { CliCommandIdentity } from "./cli-command-identity.ts";
import { loadProjectConfig } from "./config-loader.ts";

type CliRuntime = {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
};

const locationSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

const evidenceSchema = z.object({
  kind: z.enum(["source", "type", "note"]),
  message: z.string(),
  at: locationSchema.optional(),
});

const gapSchema = z.object({
  kind: z.string(),
  message: z.string(),
  at: locationSchema.optional(),
});

const diagnosticSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  at: locationSchema,
  message: z.string(),
  evidence: z.array(evidenceSchema),
  projects: z.array(z.string()),
});

const projectSummarySchema = z.object({
  projectId: z.string(),
  configFile: z.string(),
  sourceFiles: z.array(z.string()),
});

const checkReportSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  status: z.enum(["clean", "findings"]),
  projects: z.array(projectSummarySchema),
  diagnostics: z.array(diagnosticSchema),
  gaps: z.array(gapSchema),
});

type WireCheckReport = z.infer<typeof checkReportSchema>;

const checkFailureSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  code: z.string(),
  message: z.string(),
});

function toWireReport(report: CheckReport): WireCheckReport {
  return {
    reportVersion: report.reportVersion,
    status: report.status,
    projects: report.projects.map((project) => ({
      projectId: project.projectId,
      configFile: project.configFile,
      sourceFiles: [...project.sourceFiles],
    })),
    diagnostics: report.diagnostics.map((diag) => ({
      id: diag.id,
      ruleId: diag.ruleId,
      at: { ...diag.at },
      message: diag.message,
      evidence: diag.evidence.map((item) => ({
        kind: item.kind,
        message: item.message,
        ...(item.at !== undefined ? { at: { ...item.at } } : {}),
      })),
      projects: [...diag.projects],
    })),
    gaps: report.gaps.map((gap) => ({
      kind: gap.kind,
      message: gap.message,
      ...(gap.at !== undefined ? { at: { ...gap.at } } : {}),
    })),
  };
}

function formatCheckFindingsText(report: WireCheckReport) {
  const lines: string[] = [];
  for (const diag of report.diagnostics) {
    lines.push(
      `${diag.at.file}:${diag.at.line}:${diag.at.column} [${diag.ruleId}] (${diag.id}) ${diag.message}`,
    );
    for (const item of diag.evidence) {
      const locSuffix = item.at
        ? ` (${item.at.file}:${item.at.line}:${item.at.column})`
        : "";
      lines.push(`  evidence (${item.kind}): ${item.message}${locSuffix}`);
    }
  }
  const summary = `Found ${report.diagnostics.length} violation(s).`;
  const [first, ...rest] = lines;
  return first !== undefined
    ? text.lines([first, ...rest, summary])
    : text.line(summary);
}

function createCliContract(
  identity: CliCommandIdentity,
  workingDirectory: string,
) {
  const define = defineCli();
  const versionInput = z.object({});
  const checkInput = z.object({
    config: z.string().min(1).optional(),
  });

  async function executeCheck(configOption?: string): Promise<
    | { readonly ok: true; readonly report: WireCheckReport }
    | {
        readonly ok: false;
        readonly failure: {
          readonly reportVersion: typeof REPORT_SCHEMA_VERSION;
          readonly code: string;
          readonly message: string;
        };
      }
  > {
    try {
      const config = await loadProjectConfig(workingDirectory, configOption);
      const report = await runCheck({ cwd: workingDirectory, config });
      return { ok: true, report: toWireReport(report) };
    } catch (err) {
      if (err instanceof VeruleExecutionError) {
        return {
          ok: false,
          failure: {
            reportVersion: REPORT_SCHEMA_VERSION,
            code: err.code,
            message: err.message,
          },
        };
      }
      return {
        ok: false,
        failure: {
          reportVersion: REPORT_SCHEMA_VERSION,
          code: "ENGINE_ERROR",
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  return define({
    root: "verule",
    help: helpCapability({
      shortAlias: "-h",
      headings: {
        usage: "Usage",
        commands: "Commands",
        options: "Options",
        schema: "Contract Discovery",
      },
      wording: {
        commandPlaceholder: "command",
        choices: "(choices: {choices})",
        default: "(default: {value})",
      },
    }),
    version: versionCapability({
      value: text.line(`${identity.commandName} ${identity.version}`),
      description: "Print the CLI version.",
      shortAlias: "-V",
    }),
    schema: schemaCapability({
      description: text.line("Inspect the command contract."),
    }),
    usageFailureExitCode: 2,
    commands: {
      verule: {
        kind: "rootGroup",
        name: identity.commandName,
        description: "Static analyzer for TypeScript and JavaScript projects.",
      },
      ...define.command("version")({
        kind: "command",
        parent: "verule",
        name: "version",
        description:
          "Show the installed Verule CLI and analysis engine versions.",
        input: versionInput,
        outputs: define.outputModes("version", versionInput, (mode) => ({
          default: "text",
          modes: {
            text: mode.atomic({
              format: "text",
              description: "Display the installed versions.",
              success: {
                kind: "data",
                variants: {
                  versions: {
                    description: "Installed CLI and engine versions.",
                    schema: z.object({ cli: z.string(), engine: z.string() }),
                    exitCode: 0,
                    text: ({ cli, engine }) =>
                      text.line(
                        `${identity.commandName} ${cli} (engine ${engine})`,
                      ),
                  },
                },
              },
              failures: {},
              handler: async ({ outcome }) => {
                return outcome.data.versions({
                  cli: identity.version,
                  engine: await getEngineVersion(),
                });
              },
            }),
          },
        })),
      }),
      ...define.command("check")({
        kind: "command",
        parent: "verule",
        name: "check",
        description: "Run configured project rules and report diagnostics.",
        fields: {
          config: {
            kind: "valueOption",
            longOption: "--config",
            shortAlias: "-c",
            description: "Path to the Verule configuration file.",
          },
        },
        input: checkInput,
        outputs: define.outputModes("check", checkInput, (mode) => ({
          default: "text",
          modes: {
            text: mode.atomic({
              format: "text",
              description: "Display check diagnostics as human-readable text.",
              success: {
                kind: "data",
                variants: {
                  clean: {
                    description: "Analysis completed with zero violations.",
                    schema: checkReportSchema,
                    exitCode: 0,
                    text: (report) =>
                      text.line(
                        `No violations found across ${report.projects.length} project(s).`,
                      ),
                  },
                  findings: {
                    description: "Analysis completed and reported violations.",
                    schema: checkReportSchema,
                    exitCode: 1,
                    text: formatCheckFindingsText,
                  },
                },
              },
              failures: {
                failed: {
                  description:
                    "Configuration, project loading, rule execution, or engine failure.",
                  schema: checkFailureSchema,
                  exitCode: 2,
                  text: ({ code, message }) =>
                    text.line(`Check failed [${code}]: ${message}`),
                },
              },
              handler: async ({ input, outcome }) => {
                const outcomeResult = await executeCheck(input.config);
                if (!outcomeResult.ok) {
                  return outcome.failure.failed(outcomeResult.failure);
                }
                return outcomeResult.report.status === "findings"
                  ? outcome.data.findings(outcomeResult.report)
                  : outcome.data.clean(outcomeResult.report);
              },
            }),
            json: mode.atomic({
              format: "structured",
              description: "Emit a versioned JSON check report.",
              success: {
                kind: "data",
                variants: {
                  clean: {
                    description: "Analysis completed with zero violations.",
                    schema: checkReportSchema,
                    exitCode: 0,
                  },
                  findings: {
                    description: "Analysis completed and reported violations.",
                    schema: checkReportSchema,
                    exitCode: 1,
                  },
                },
              },
              failures: {
                failed: {
                  description:
                    "Configuration, project loading, rule execution, or engine failure.",
                  schema: checkFailureSchema,
                  exitCode: 2,
                },
              },
              handler: async ({ input, outcome }) => {
                const outcomeResult = await executeCheck(input.config);
                if (!outcomeResult.ok) {
                  return outcome.failure.failed(outcomeResult.failure);
                }
                return outcomeResult.report.status === "findings"
                  ? outcome.data.findings(outcomeResult.report)
                  : outcome.data.clean(outcomeResult.report);
              },
            }),
          },
        })),
      }),
    },
  });
}

/** Returns the process status after all output has been written. */
export async function runCli(runtime: CliRuntime): Promise<number> {
  try {
    const workingDirectory = runtime.cwd ?? process.cwd();
    const contract = createCliContract(runtime.identity, workingDirectory);
    const rawArgs = runtime.argv.slice(2);
    const effectiveArgs = rawArgs.length === 0 ? ["version"] : rawArgs;
    const invocation = parseCliInvocation(contract, effectiveArgs);
    const { exitCode } = await executeCli(contract, {
      invocation,
      dependencies: undefined,
      write: runtime.write,
    });
    return exitCode;
  } catch (error) {
    if (error instanceof CliWriteError) {
      if (error.destination === "stderr") return 2;
      if (isNodeBrokenPipe(error)) return 0;
    }
    try {
      await runtime.write({
        destination: "stderr",
        chunk: "Verule could not complete the command.\n",
      });
    } catch {
      // The command still failed if its diagnostic could not be written.
    }
    return 2;
  }
}
