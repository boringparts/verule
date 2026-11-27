import { performance } from "node:perf_hooks";

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
import { loadProjectConfigWithDependencies } from "./config-loader.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  getEngineVersion,
  parseObserveLimit,
  requestSharedReport,
  runCheck,
} from "./index.ts";
import {
  appendGapLines,
  checkFailureSchema,
  checkReportSchema,
  formatDiagnosticsLines,
  formatScopeLines,
  toWireReport,
  type WireCheckReport,
  type WireExplainResult,
  type WireObservation,
} from "./report-wire.ts";
import {
  formatSessionReadyText,
  sessionReadyRecordSchema,
  streamSharedSession,
} from "./session-command.ts";
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

function appendExplanationLines(lines: string[], exp: WireExplainResult): void {
  const linePart = exp.target.line !== undefined ? `:${exp.target.line}` : "";
  const colPart =
    exp.target.column !== undefined ? `:${exp.target.column}` : "";
  lines.push(
    `Explanation [${exp.ruleId}] @ ${exp.target.file}${linePart}${colPart}: ${exp.status} (inCandidates=${String(exp.inCandidates)})`,
  );
  lines.push(`  summary: ${exp.summary}`);
  if (exp.inlineIgnore?.matched) {
    const atSuffix = exp.inlineIgnore.commentAt
      ? ` at ${exp.inlineIgnore.commentAt.file}:${exp.inlineIgnore.commentAt.line}:${exp.inlineIgnore.commentAt.column}`
      : "";
    const reasonSuffix = exp.inlineIgnore.reason
      ? ` -- ${exp.inlineIgnore.reason}`
      : "";
    lines.push(
      `  inlineIgnore: suppressed by verule-ignore-next-code-line${atSuffix}${reasonSuffix}`,
    );
  }
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
  if (exp.providers.length > 0) {
    lines.push(`  providers: ${exp.providers.join(", ")}`);
  }
  for (const gap of exp.gaps) {
    const atSuffix = gap.at
      ? ` (${gap.at.file}:${gap.at.line}:${gap.at.column})`
      : "";
    lines.push(`  gap [${gap.kind}]: ${gap.message}${atSuffix}`);
  }
  for (const cp of exp.cleanupPaths) {
    const sites = cp.cleanupLocations
      .map((loc) => `${loc.file}:${loc.line}:${loc.column}`)
      .join(", ");
    lines.push(`  cleanupPath [${cp.instanceKey}]: ${cp.summary} (${sites})`);
  }
  for (const query of exp.queries) {
    lines.push(
      `  query #${query.queryIndex}: ${query.op} [provider=${query.provider}, cache=${query.cacheStatus}] candidates=${query.candidateCount} matchedTarget=${String(query.matchedTarget)}`,
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
  if (obs.providers.length > 0) {
    lines.push(`  providers: ${obs.providers.join(", ")}`);
  }
  lines.push(
    `  lowering: functions=${obs.lowering.functionsLowered}, vertices=${obs.lowering.verticesCreated}, duration=${obs.lowering.durationMs}ms`,
  );
  lines.push(
    `  irCache: functionHits=${obs.irCache.functionHits}, functionMisses=${obs.irCache.functionMisses}, filesReused=${obs.irCache.filesReused}, filesInvalidated=${obs.irCache.filesInvalidated}`,
  );
  lines.push(
    `  summaryLookup: lookups=${obs.summaryLookup.lookups}, hits=${obs.summaryLookup.hits}, misses=${obs.summaryLookup.misses} (local=${obs.summaryLookup.hitsBySource.local}, package=${obs.summaryLookup.hitsBySource.package}, community=${obs.summaryLookup.hitsBySource.community}, builtin=${obs.summaryLookup.hitsBySource.builtin})`,
  );
  if (obs.truncated) {
    lines.push(`  truncated: true (dropped=${obs.droppedCount})`);
  }
  if (obs.details) {
    for (const detail of obs.details) {
      const meta: string[] = [];
      if (detail.ruleId !== undefined) meta.push(`rule=${detail.ruleId}`);
      if (detail.provider !== undefined)
        meta.push(`provider=${detail.provider}`);
      if (detail.cacheStatus !== undefined) {
        meta.push(`cache=${detail.cacheStatus}`);
      }
      if (detail.candidateCount !== undefined) {
        meta.push(`candidates=${detail.candidateCount}`);
      }
      const metaSuffix = meta.length > 0 ? ` (${meta.join(", ")})` : "";
      lines.push(`  detail [${detail.kind}]${metaSuffix}: ${detail.summary}`);
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

function formatCheckCleanText(report: WireCheckReport) {
  const lines: string[] = formatScopeLines(report);
  appendGapLines(lines, report.gaps);
  const summary =
    report.gaps.length > 0
      ? `No violations found across ${report.projects.length} project(s) (${report.gaps.length} gap(s)).`
      : `No violations found across ${report.projects.length} project(s).`;
  const extras: string[] = [];
  appendExtrasText(extras, report);
  const [first, ...rest] = [...lines, summary, ...extras];
  return first !== undefined
    ? text.lines([first, ...rest])
    : text.line(summary);
}

function formatCheckFindingsText(report: WireCheckReport) {
  const lines: string[] = [
    ...formatScopeLines(report),
    ...formatDiagnosticsLines(report),
  ];
  appendGapLines(lines, report.gaps);
  const summary =
    report.gaps.length > 0
      ? `Found ${report.diagnostics.length} violation(s) (${report.gaps.length} gap(s)).`
      : `Found ${report.diagnostics.length} violation(s).`;
  const extras: string[] = [];
  appendExtrasText(extras, report);
  const [first, ...rest] = lines;
  return first !== undefined
    ? text.lines([first, ...rest, summary, ...extras])
    : text.lines([summary, ...extras]);
}

type CheckCliInput = {
  readonly config?: string | undefined;
  readonly session?: string | undefined;
  readonly rule?: string | undefined;
  readonly at?: string | undefined;
  readonly observe?: "off" | "summary" | "detail" | undefined;
  readonly observeLimit?: string | undefined;
};

function createCliContract(
  identity: CliCommandIdentity,
  workingDirectory: string,
  signal?: AbortSignal,
) {
  const define = defineCli();
  const versionInput = z.object({});
  const checkInput = z.object({
    config: z.string().min(1).optional(),
    session: z.string().min(1).optional(),
    rule: z.string().min(1).optional(),
    at: z.string().min(1).optional(),
    observe: z.enum(["off", "summary", "detail"]).optional(),
    observeLimit: z.string().min(1).optional(),
  });
  const watchInput = z.object({
    config: z.string().min(1).optional(),
  });
  const sessionInput = z.object({
    config: z.string().min(1).optional(),
    socket: z.string().min(1),
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

      if (input.session !== undefined) {
        if (input.config !== undefined) {
          throw new VeruleExecutionError(
            "INVALID_CONFIG",
            'Cannot combine "--session" with "--config"; the shared session is already bound to a configuration.',
          );
        }
        const report = await requestSharedReport({
          endpoint: input.session,
          cwd: workingDirectory,
          ...(input.rule !== undefined ? { ruleIds: [input.rule] } : {}),
          ...(input.at !== undefined ? { at: input.at } : {}),
          ...(input.observe !== undefined ? { observe: input.observe } : {}),
          ...(observeLimit !== undefined ? { observeLimit } : {}),
        });
        return { ok: true, report: toWireReport(report) };
      }

      const configStart = performance.now();
      const loaded = await loadProjectConfigWithDependencies(
        workingDirectory,
        input.config,
      );
      const configLoadMs = performance.now() - configStart;

      const report = await runCheck({
        cwd: workingDirectory,
        config: loaded.config,
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
          session: {
            kind: "valueOption",
            longOption: "--session",
            description:
              "Query a running shared session socket instead of starting a new engine.",
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
        input: watchInput,
        outputs: define.outputModes("watch", watchInput, (mode) => ({
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
      ...define.command("session")({
        kind: "command",
        parent: "verule",
        name: "session",
        description:
          "Start an explicit shared analysis session bound to a configuration and socket endpoint.",
        fields: {
          config: {
            kind: "valueOption",
            longOption: "--config",
            shortAlias: "-c",
            description: "Path to the Verule configuration file.",
          },
          socket: {
            kind: "valueOption",
            longOption: "--socket",
            description: "Local Unix domain socket or Windows named pipe path.",
          },
        },
        input: sessionInput,
        outputs: define.outputModes("session", sessionInput, (mode) => ({
          default: "text",
          modes: {
            text: mode.stream({
              format: "text",
              description: "Emit shared session readiness and shutdown text.",
              success: {
                kind: "stream",
                records: {
                  ready: {
                    description:
                      "Shared session is initialized and listening for queries.",
                    schema: sessionReadyRecordSchema,
                    text: formatSessionReadyText,
                  },
                },
                text: () => text.line("Shared session stopped."),
              },
              failures: {
                failed: {
                  description: "Shared session failed to start.",
                  schema: checkFailureSchema,
                  exitCode: 2,
                  text: ({ code, message }) =>
                    text.line(`Session failed [${code}]: ${message}`),
                },
              },
              handler: ({ input, outcome }) =>
                streamSharedSession(
                  workingDirectory,
                  input.config,
                  input.socket,
                  signal,
                  outcome,
                ),
            }),
            ndjson: mode.stream({
              format: "structured",
              description:
                "Emit shared session readiness and lifecycle events as NDJSON.",
              success: {
                kind: "stream",
                records: {
                  ready: {
                    description:
                      "Shared session is initialized and listening for queries.",
                    schema: sessionReadyRecordSchema,
                  },
                },
              },
              failures: {
                failed: {
                  description: "Shared session failed to start.",
                  schema: checkFailureSchema,
                  exitCode: 2,
                },
              },
              handler: ({ input, outcome }) =>
                streamSharedSession(
                  workingDirectory,
                  input.config,
                  input.socket,
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
