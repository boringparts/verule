import { performance } from "node:perf_hooks";

import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  getEngineVersion,
  parseObserveLimit,
  runCheck,
  type CheckReport,
  type ExplainResult,
  type ObservationReport,
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

const compilerOptionsSummarySchema = z.object({
  strict: z.boolean(),
  allowJs: z.boolean(),
  checkJs: z.boolean(),
  composite: z.boolean(),
  target: z.string().optional(),
  module: z.string().optional(),
  moduleResolution: z.string().optional(),
  jsx: z.string().optional(),
  paths: z.record(z.string(), z.array(z.string())),
  customConditions: z.array(z.string()),
});

const projectSummarySchema = z.object({
  projectId: z.string(),
  configFile: z.string(),
  entryConfig: z.string(),
  entryChain: z.array(z.string()),
  referencedBy: z.array(z.string()),
  projectReferences: z.array(z.string()),
  compilerOptions: compilerOptionsSummarySchema,
  sourceFiles: z.array(z.string()),
});

const sourceFileProjectOriginSchema = z.object({
  projectId: z.string(),
  configFile: z.string(),
  entryConfig: z.string(),
  entryChain: z.array(z.string()),
});

const sourceFileOriginSchema = z.object({
  file: z.string(),
  projects: z.array(sourceFileProjectOriginSchema),
});

const observationDetailEntrySchema = z.object({
  kind: z.enum(["query", "checkpoint", "engineStep"]),
  ruleId: z.string().optional(),
  projectId: z.string().optional(),
  provider: z.string().optional(),
  name: z.string().optional(),
  outcome: z.enum(["pass", "exclude", "info"]).optional(),
  cacheStatus: z.enum(["computed", "reused"]).optional(),
  candidateCount: z.number().int().nonnegative().optional(),
  durationMs: z.number().nonnegative().optional(),
  at: locationSchema.optional(),
  summary: z.string(),
  detail: z.unknown().optional(),
});

const observationSchema = z.object({
  mode: z.enum(["summary", "detail"]),
  phases: z.object({
    configAndOpenMs: z.number().nonnegative(),
    engineQueryMs: z.number().nonnegative(),
    ruleExecutionMs: z.number().nonnegative(),
    totalMs: z.number().nonnegative(),
  }),
  rpc: z.object({
    batches: z.number().int().nonnegative(),
    queryBatches: z.number().int().nonnegative(),
    bytesSent: z.number().int().nonnegative(),
    bytesReceived: z.number().int().nonnegative(),
  }),
  overhead: z.object({
    checkpointMs: z.number().nonnegative(),
    encodeMs: z.number().nonnegative(),
    writeMs: z.number().nonnegative(),
  }),
  queryCount: z.number().int().nonnegative(),
  computedQueryCount: z.number().int().nonnegative(),
  reusedQueryCount: z.number().int().nonnegative(),
  candidateCount: z.number().int().nonnegative(),
  checkpointCount: z.number().int().nonnegative(),
  providers: z.array(z.string()),
  limit: z
    .object({
      maxItems: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
  truncated: z.boolean(),
  droppedCount: z.number().int().nonnegative(),
  details: z.array(observationDetailEntrySchema).optional(),
});

const explainQueryStepSchema = z.object({
  queryIndex: z.number().int().positive(),
  op: z.string(),
  projectId: z.string(),
  provider: z.string(),
  cacheStatus: z.enum(["computed", "reused"]),
  candidateCount: z.number().int().nonnegative(),
  matchedTarget: z.boolean(),
  durationMs: z.number().nonnegative(),
  summary: z.string().optional(),
  detail: z.unknown().optional(),
});

const explainCheckpointTraceSchema = z.object({
  name: z.string(),
  ruleId: z.string(),
  projectId: z.string(),
  outcome: z.enum(["pass", "exclude", "info"]),
  at: locationSchema.optional(),
  detail: z.unknown().optional(),
});

const explainResultSchema = z.object({
  ruleId: z.string(),
  target: z.object({
    file: z.string(),
    line: z.number().int().positive().optional(),
    column: z.number().int().positive().optional(),
  }),
  status: z.enum([
    "reported",
    "excluded_by_checkpoint",
    "excluded_by_query",
    "not_in_candidates",
    "target_not_in_project",
    "suppressed_by_ignore",
    "blocked_by_gap",
    "covered_by_cleanup",
    "rule_filtered",
  ]),
  inCandidates: z.boolean(),
  summary: z.string(),
  projectsChecked: z.array(z.string()),
  matchingCandidates: z.array(locationSchema),
  excludedByQuery: explainQueryStepSchema.optional(),
  excludedByCheckpoint: explainCheckpointTraceSchema.optional(),
  queries: z.array(explainQueryStepSchema),
  checkpoints: z.array(explainCheckpointTraceSchema),
  gaps: z.array(gapSchema),
  providers: z.array(z.string()),
  cleanupPaths: z.array(z.unknown()),
  inlineIgnore: z
    .object({
      matched: z.boolean(),
      reason: z.string().optional(),
    })
    .optional(),
});

const checkReportSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  status: z.enum(["clean", "findings"]),
  projects: z.array(projectSummarySchema),
  fileOrigins: z.array(sourceFileOriginSchema),
  diagnostics: z.array(diagnosticSchema),
  gaps: z.array(gapSchema),
  observation: observationSchema.optional(),
  explanation: explainResultSchema.optional(),
  explanations: z.array(explainResultSchema).optional(),
});

type WireCheckReport = z.infer<typeof checkReportSchema>;
type WireObservation = z.infer<typeof observationSchema>;
type WireExplainResult = z.infer<typeof explainResultSchema>;

const checkFailureSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  code: z.string(),
  message: z.string(),
});

function toWireObservation(obs: ObservationReport): WireObservation {
  return {
    mode: obs.mode,
    phases: { ...obs.phases },
    rpc: { ...obs.rpc },
    overhead: { ...obs.overhead },
    queryCount: obs.queryCount,
    computedQueryCount: obs.computedQueryCount,
    reusedQueryCount: obs.reusedQueryCount,
    candidateCount: obs.candidateCount,
    checkpointCount: obs.checkpointCount,
    providers: [...obs.providers],
    ...(obs.limit !== undefined
      ? {
          limit: {
            ...(obs.limit.maxItems !== undefined
              ? { maxItems: obs.limit.maxItems }
              : {}),
            ...(obs.limit.maxBytes !== undefined
              ? { maxBytes: obs.limit.maxBytes }
              : {}),
          },
        }
      : {}),
    truncated: obs.truncated,
    droppedCount: obs.droppedCount,
    ...(obs.details !== undefined
      ? {
          details: obs.details.map((entry) => ({
            kind: entry.kind,
            summary: entry.summary,
            ...(entry.ruleId !== undefined ? { ruleId: entry.ruleId } : {}),
            ...(entry.projectId !== undefined
              ? { projectId: entry.projectId }
              : {}),
            ...(entry.provider !== undefined
              ? { provider: entry.provider }
              : {}),
            ...(entry.name !== undefined ? { name: entry.name } : {}),
            ...(entry.outcome !== undefined ? { outcome: entry.outcome } : {}),
            ...(entry.cacheStatus !== undefined
              ? { cacheStatus: entry.cacheStatus }
              : {}),
            ...(entry.candidateCount !== undefined
              ? { candidateCount: entry.candidateCount }
              : {}),
            ...(entry.durationMs !== undefined
              ? { durationMs: entry.durationMs }
              : {}),
            ...(entry.at !== undefined ? { at: { ...entry.at } } : {}),
            ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
          })),
        }
      : {}),
  };
}

function toWireExplainResult(exp: ExplainResult): WireExplainResult {
  return {
    ruleId: exp.ruleId,
    target: {
      file: exp.target.file,
      ...(exp.target.line !== undefined ? { line: exp.target.line } : {}),
      ...(exp.target.column !== undefined ? { column: exp.target.column } : {}),
    },
    status: exp.status,
    inCandidates: exp.inCandidates,
    summary: exp.summary,
    projectsChecked: [...exp.projectsChecked],
    matchingCandidates: exp.matchingCandidates.map((loc) => ({ ...loc })),
    ...(exp.excludedByQuery !== undefined
      ? {
          excludedByQuery: {
            ...exp.excludedByQuery,
          },
        }
      : {}),
    ...(exp.excludedByCheckpoint !== undefined
      ? {
          excludedByCheckpoint: {
            ...exp.excludedByCheckpoint,
            ...(exp.excludedByCheckpoint.at !== undefined
              ? { at: { ...exp.excludedByCheckpoint.at } }
              : {}),
          },
        }
      : {}),
    queries: exp.queries.map((q) => ({ ...q })),
    checkpoints: exp.checkpoints.map((cp) => ({
      ...cp,
      ...(cp.at !== undefined ? { at: { ...cp.at } } : {}),
    })),
    gaps: exp.gaps.map((g) => ({
      kind: g.kind,
      message: g.message,
      ...(g.at !== undefined ? { at: { ...g.at } } : {}),
    })),
    providers: [...exp.providers],
    cleanupPaths: [...exp.cleanupPaths],
    ...(exp.inlineIgnore !== undefined
      ? {
          inlineIgnore: {
            matched: exp.inlineIgnore.matched,
            ...(exp.inlineIgnore.reason !== undefined
              ? { reason: exp.inlineIgnore.reason }
              : {}),
          },
        }
      : {}),
  };
}

function toWireReport(report: CheckReport): WireCheckReport {
  return {
    reportVersion: report.reportVersion,
    status: report.status,
    projects: report.projects.map((project) => ({
      projectId: project.projectId,
      configFile: project.configFile,
      entryConfig: project.entryConfig,
      entryChain: [...project.entryChain],
      referencedBy: [...project.referencedBy],
      projectReferences: [...project.projectReferences],
      compilerOptions: {
        strict: project.compilerOptions.strict,
        allowJs: project.compilerOptions.allowJs,
        checkJs: project.compilerOptions.checkJs,
        composite: project.compilerOptions.composite,
        ...(project.compilerOptions.target !== undefined
          ? { target: project.compilerOptions.target }
          : {}),
        ...(project.compilerOptions.module !== undefined
          ? { module: project.compilerOptions.module }
          : {}),
        ...(project.compilerOptions.moduleResolution !== undefined
          ? { moduleResolution: project.compilerOptions.moduleResolution }
          : {}),
        ...(project.compilerOptions.jsx !== undefined
          ? { jsx: project.compilerOptions.jsx }
          : {}),
        paths: Object.fromEntries(
          Object.entries(project.compilerOptions.paths).map(([key, vals]) => [
            key,
            [...vals],
          ]),
        ),
        customConditions: [...project.compilerOptions.customConditions],
      },
      sourceFiles: [...project.sourceFiles],
    })),
    fileOrigins: report.fileOrigins.map((origin) => ({
      file: origin.file,
      projects: origin.projects.map((proj) => ({
        projectId: proj.projectId,
        configFile: proj.configFile,
        entryConfig: proj.entryConfig,
        entryChain: [...proj.entryChain],
      })),
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
    ...(report.observation !== undefined
      ? { observation: toWireObservation(report.observation) }
      : {}),
    ...(report.explanation !== undefined
      ? { explanation: toWireExplainResult(report.explanation) }
      : {}),
    ...(report.explanations !== undefined
      ? {
          explanations: report.explanations.map(toWireExplainResult),
        }
      : {}),
  };
}

function appendExplanationLines(lines: string[], exp: WireExplainResult): void {
  const linePart = exp.target.line !== undefined ? `:${exp.target.line}` : "";
  const colPart =
    exp.target.column !== undefined ? `:${exp.target.column}` : "";
  lines.push(
    `Explanation [${exp.ruleId}] @ ${exp.target.file}${linePart}${colPart}: ${exp.status} (inCandidates=${String(exp.inCandidates)})`,
  );
  lines.push(`  summary: ${exp.summary}`);
  if (exp.excludedByCheckpoint) {
    const detailSuffix =
      exp.excludedByCheckpoint.detail !== undefined
        ? ` detail=${JSON.stringify(exp.excludedByCheckpoint.detail)}`
        : "";
    lines.push(
      `  excludedByCheckpoint: ${exp.excludedByCheckpoint.name} (${exp.excludedByCheckpoint.outcome})${detailSuffix}`,
    );
  }
  if (exp.excludedByQuery) {
    lines.push(
      `  excludedByQuery: ${exp.excludedByQuery.op} (provider=${exp.excludedByQuery.provider}, cache=${exp.excludedByQuery.cacheStatus}, candidates=${exp.excludedByQuery.candidateCount})`,
    );
  }
  for (const query of exp.queries) {
    lines.push(
      `  query #${query.queryIndex}: ${query.op} [${query.cacheStatus}] candidates=${query.candidateCount} matchedTarget=${String(query.matchedTarget)}`,
    );
  }
}

function appendObservationLines(lines: string[], obs: WireObservation): void {
  lines.push(
    `Observation (${obs.mode}): total=${obs.phases.totalMs}ms (configOpen=${obs.phases.configAndOpenMs}ms, engineQuery=${obs.phases.engineQueryMs}ms, ruleExec=${obs.phases.ruleExecutionMs}ms)`,
  );
  lines.push(
    `  rpc: batches=${obs.rpc.batches} (queryBatches=${obs.rpc.queryBatches}), bytesSent=${obs.rpc.bytesSent}, bytesReceived=${obs.rpc.bytesReceived}`,
  );
  lines.push(
    `  overhead: checkpoint=${obs.overhead.checkpointMs}ms, encode=${obs.overhead.encodeMs}ms, write=${obs.overhead.writeMs}ms`,
  );
  lines.push(
    `  queries: total=${obs.queryCount}, computed=${obs.computedQueryCount}, reused=${obs.reusedQueryCount}, candidates=${obs.candidateCount}, checkpoints=${obs.checkpointCount}`,
  );
  if (obs.truncated) {
    lines.push(`  truncated: true (dropped=${obs.droppedCount})`);
  }
  if (obs.details) {
    for (const detail of obs.details) {
      lines.push(`  detail [${detail.kind}]: ${detail.summary}`);
    }
  }
}

function appendExtrasText(lines: string[], report: WireCheckReport): void {
  if (report.explanation) {
    appendExplanationLines(lines, report.explanation);
  } else if (report.explanations) {
    for (const exp of report.explanations) {
      appendExplanationLines(lines, exp);
    }
  }
  if (report.observation) {
    appendObservationLines(lines, report.observation);
  }
}

function formatScopeLines(report: WireCheckReport): string[] {
  const lines: string[] = [`Projects (${report.projects.length}):`];
  for (const project of report.projects) {
    const chain = project.entryChain.join(" -> ");
    const flags = [
      `strict=${project.compilerOptions.strict}`,
      `allowJs=${project.compilerOptions.allowJs}`,
      `checkJs=${project.compilerOptions.checkJs}`,
      ...(project.compilerOptions.module !== undefined
        ? [`module=${project.compilerOptions.module}`]
        : []),
      `files=${project.sourceFiles.length}`,
    ];
    const refsSuffix =
      project.projectReferences.length > 0
        ? `, references=[${project.projectReferences.join(", ")}]`
        : "";
    lines.push(
      `  - ${project.configFile} (chain: ${chain}, ${flags.join(", ")}${refsSuffix})`,
    );
  }
  lines.push(`Files (${report.fileOrigins.length}):`);
  for (const origin of report.fileOrigins) {
    const sources = origin.projects.map(
      (proj) => `${proj.projectId} (via ${proj.entryChain.join(" -> ")})`,
    );
    lines.push(`  - ${origin.file} <- ${sources.join(", ")}`);
  }
  return lines;
}

function formatCheckCleanText(report: WireCheckReport) {
  const scopeLines = formatScopeLines(report);
  const summary = `No violations found across ${report.projects.length} project(s).`;
  const extras: string[] = [];
  appendExtrasText(extras, report);
  const [first, ...rest] = [...scopeLines, summary, ...extras];
  return first !== undefined
    ? text.lines([first, ...rest])
    : text.line(summary);
}

function formatCheckFindingsText(report: WireCheckReport) {
  const lines: string[] = formatScopeLines(report);
  for (const diag of report.diagnostics) {
    lines.push(
      `${diag.at.file}:${diag.at.line}:${diag.at.column} [${diag.ruleId}] (${diag.id}) ${diag.message} [projects: ${diag.projects.join(", ")}]`,
    );
    for (const item of diag.evidence) {
      const locSuffix = item.at
        ? ` (${item.at.file}:${item.at.line}:${item.at.column})`
        : "";
      lines.push(`  evidence (${item.kind}): ${item.message}${locSuffix}`);
    }
  }
  const summary = `Found ${report.diagnostics.length} violation(s).`;
  const extras: string[] = [];
  appendExtrasText(extras, report);
  const [first, ...rest] = lines;
  return first !== undefined
    ? text.lines([first, ...rest, summary, ...extras])
    : text.lines([summary, ...extras]);
}

type CheckCliInput = {
  readonly config?: string | undefined;
  readonly rule?: string | undefined;
  readonly at?: string | undefined;
  readonly observe?: "off" | "summary" | "detail" | undefined;
  readonly observeLimit?: string | undefined;
};

function createCliContract(
  identity: CliCommandIdentity,
  workingDirectory: string,
) {
  const define = defineCli();
  const versionInput = z.object({});
  const checkInput = z.object({
    config: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    at: z.string().min(1).optional(),
    observe: z.enum(["off", "summary", "detail"]).optional(),
    observeLimit: z.string().min(1).optional(),
  });

  async function executeCheck(input: CheckCliInput): Promise<
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
      const observeLimit =
        input.observeLimit !== undefined
          ? parseObserveLimit(input.observeLimit)
          : undefined;

      const configStart = performance.now();
      const config = await loadProjectConfig(workingDirectory, input.config);
      const configLoadMs = performance.now() - configStart;

      const report = await runCheck({
        cwd: workingDirectory,
        config,
        configLoadMs,
        ...(input.rule !== undefined ? { ruleIds: [input.rule] } : {}),
        ...(input.at !== undefined ? { at: input.at } : {}),
        ...(input.observe !== undefined ? { observe: input.observe } : {}),
        ...(observeLimit !== undefined ? { observeLimit } : {}),
      });
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
          rule: {
            kind: "valueOption",
            longOption: "--rule",
            description: "Run only the specified rule ID.",
          },
          at: {
            kind: "valueOption",
            longOption: "--at",
            description:
              "Explain why diagnostics did or did not trigger at <file[:line[:column]]>.",
          },
          observe: {
            kind: "valueOption",
            longOption: "--observe",
            description:
              "Observation verbosity level (off, summary, or detail).",
          },
          observeLimit: {
            kind: "valueOption",
            longOption: "--observe-limit",
            description: "Limit detail observation entries (e.g. 20 or 4096b).",
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
                    text: formatCheckCleanText,
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
                const outcomeResult = await executeCheck(input);
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
                const outcomeResult = await executeCheck(input);
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
