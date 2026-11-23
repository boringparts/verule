import { dirname, resolve } from "node:path";

import { REPORT_SCHEMA_VERSION, watchProject } from "@verule/sdk";
import { text } from "@ykdz/cli-contract";
import { z } from "zod";

import { loadProjectConfigWithDependencies } from "./config-loader.ts";
import {
  appendGapLines,
  checkReportSchema,
  factConflictDetailsSchema,
  formatDiagnosticsLines,
  toWireFactConflict,
  toWireReport,
} from "./report-wire.ts";

export const recomputationScopeSchema = z.object({
  recomputedProjects: z.array(z.string()),
  reusedProjects: z.array(z.string()),
  recomputedFiles: z.array(z.string()),
  reusedFiles: z.array(z.string()),
  removedFiles: z.array(z.string()),
  invalidatedBy: z.array(z.string()),
});

export const memoryStatsSchema = z.object({
  hostRssBytes: z.number().int().nonnegative(),
  engineRssBytes: z.number().int().nonnegative().optional(),
});

export const watchReportRecordSchema = checkReportSchema.extend({
  sequence: z.number().int().positive(),
  trigger: z.enum(["initial", "change"]),
  snapshotId: z.number().int().positive(),
  recomputation: recomputationScopeSchema,
  memory: memoryStatsSchema,
});

export type WireWatchReportRecord = z.infer<typeof watchReportRecordSchema>;

export const watchFailureRecordSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  sequence: z.number().int().positive(),
  trigger: z.enum(["initial", "change"]),
  code: z.string(),
  message: z.string(),
  conflict: factConflictDetailsSchema.optional(),
});

export type WireWatchFailureRecord = z.infer<typeof watchFailureRecordSchema>;

export function formatWatchReportText(record: WireWatchReportRecord) {
  const lines = formatDiagnosticsLines(record);
  appendGapLines(lines, record.gaps);
  const gapSuffix =
    record.gaps.length > 0 ? ` (${record.gaps.length} gap(s))` : "";
  const summary =
    record.diagnostics.length === 0
      ? `[watch #${record.sequence}] No violations found across ${record.projects.length} project(s)${gapSuffix}.`
      : `[watch #${record.sequence}] Found ${record.diagnostics.length} violation(s)${gapSuffix}.`;
  if (lines.length === 0) {
    return text.line(summary);
  }
  return text.fragment(`${[...lines, summary].join("\n")}\n`);
}

/**
 * Streams complete analysis reports and single-round failures for `verule watch`,
 * preserving the long-lived analysis session across edits until aborted.
 */
export async function* streamWatchEvents<
  TReportFact,
  TFailedFact,
  TSuccessFact,
>(
  workingDirectory: string,
  configOption: string | undefined,
  signal: AbortSignal | undefined,
  outcome: {
    readonly record: {
      readonly report: (payload: WireWatchReportRecord) => TReportFact;
      readonly failed: (payload: WireWatchFailureRecord) => TFailedFact;
    };
    readonly streamSuccess: () => TSuccessFact;
  },
): AsyncGenerator<TReportFact | TFailedFact, TSuccessFact, void> {
  const events = watchProject({
    cwd: workingDirectory,
    ...(signal !== undefined ? { signal } : {}),
    ...(configOption !== undefined
      ? { watchFiles: [resolve(workingDirectory, configOption)] }
      : {}),
    loadConfig: async () => {
      const loaded = await loadProjectConfigWithDependencies(
        workingDirectory,
        configOption,
      );
      return {
        config: loaded.config,
        watchFiles: loaded.watchFiles,
        adapterResolutionRoot: dirname(loaded.configPath),
      };
    },
  });

  for await (const event of events) {
    if (event.kind === "report") {
      const wire = toWireReport(event.report);
      yield outcome.record.report({
        ...wire,
        sequence: event.sequence,
        trigger: event.trigger,
        snapshotId: event.snapshotId,
        recomputation: {
          recomputedProjects: [...event.recomputation.recomputedProjects],
          reusedProjects: [...event.recomputation.reusedProjects],
          recomputedFiles: [...event.recomputation.recomputedFiles],
          reusedFiles: [...event.recomputation.reusedFiles],
          removedFiles: [...event.recomputation.removedFiles],
          invalidatedBy: [...event.recomputation.invalidatedBy],
        },
        memory: {
          hostRssBytes: event.memory.hostRssBytes,
          ...(event.memory.engineRssBytes !== undefined
            ? { engineRssBytes: event.memory.engineRssBytes }
            : {}),
        },
      });
    } else {
      yield outcome.record.failed({
        reportVersion: REPORT_SCHEMA_VERSION,
        sequence: event.sequence,
        trigger: event.trigger,
        code: event.code,
        message: event.message,
        ...(event.conflict !== undefined
          ? { conflict: toWireFactConflict(event.conflict) }
          : {}),
      });
    }
  }

  return outcome.streamSuccess();
}
