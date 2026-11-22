import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  getEngineVersion,
  runCheck,
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
import {
  checkFailureSchema,
  checkReportSchema,
  formatDiagnosticsLines,
  toWireReport,
  type WireCheckReport,
} from "./report-wire.ts";
import {
  formatWatchReportText,
  streamWatchEvents,
  watchFailureRecordSchema,
  watchReportRecordSchema,
} from "./watch-command.ts";

type CliRuntime = {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly write: WriteCliOutput;
  readonly identity: CliCommandIdentity;
  readonly signal?: AbortSignal;
};

function formatCheckFindingsText(report: WireCheckReport) {
  const lines = formatDiagnosticsLines(report);
  const summary = `Found ${report.diagnostics.length} violation(s).`;
  const [first, ...rest] = lines;
  return first !== undefined
    ? text.lines([first, ...rest, summary])
    : text.line(summary);
}

function createCliContract(
  identity: CliCommandIdentity,
  workingDirectory: string,
  signal?: AbortSignal,
) {
  const define = defineCli();
  const versionInput = z.object({});
  const configInput = z.object({
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
        input: configInput,
        outputs: define.outputModes("check", configInput, (mode) => ({
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
      ...define.command("watch")({
        kind: "command",
        parent: "verule",
        name: "watch",
        description:
          "Watch project files and emit complete reports on every save.",
        fields: {
          config: {
            kind: "valueOption",
            longOption: "--config",
            shortAlias: "-c",
            description: "Path to the Verule configuration file.",
          },
        },
        input: configInput,
        outputs: define.outputModes("watch", configInput, (mode) => ({
          default: "text",
          modes: {
            text: mode.stream({
              format: "text",
              description: "Display watch reports as human-readable text.",
              success: {
                kind: "stream",
                records: {
                  report: {
                    description: "Complete analysis report for a snapshot.",
                    schema: watchReportRecordSchema,
                    text: formatWatchReportText,
                  },
                  failed: {
                    description: "Single-round check failure.",
                    schema: watchFailureRecordSchema,
                    text: ({ sequence, code, message }) =>
                      text.line(
                        `[watch #${sequence}] Check failed [${code}]: ${message}`,
                      ),
                  },
                },
                text: () => text.line("Watch stopped."),
              },
              failures: {},
              handler: ({ input, outcome }) =>
                streamWatchEvents(
                  workingDirectory,
                  input.config,
                  signal,
                  outcome,
                ),
            }),
            ndjson: mode.stream({
              format: "structured",
              description:
                "Emit complete analysis reports as NDJSON stream records.",
              success: {
                kind: "stream",
                records: {
                  report: {
                    description: "Complete analysis report for a snapshot.",
                    schema: watchReportRecordSchema,
                  },
                  failed: {
                    description: "Single-round check failure.",
                    schema: watchFailureRecordSchema,
                  },
                },
              },
              failures: {},
              handler: ({ input, outcome }) =>
                streamWatchEvents(
                  workingDirectory,
                  input.config,
                  signal,
                  outcome,
                ),
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
    const contract = createCliContract(
      runtime.identity,
      workingDirectory,
      runtime.signal,
    );
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
