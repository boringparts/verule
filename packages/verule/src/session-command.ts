import { resolve } from "node:path";

import { text } from "@boringparts/cli-contract";
import { z } from "zod";

import { loadProjectConfigWithDependencies } from "./config-loader.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  startSharedSession,
  type SharedSession,
} from "./index.ts";
import { projectSummarySchema, toWireProjects } from "./report-wire.ts";

export const sessionReadyRecordSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  endpoint: z.string(),
  snapshotId: z.number().int().positive(),
  projects: z.array(projectSummarySchema),
});

export type WireSessionReadyRecord = z.infer<typeof sessionReadyRecordSchema>;

export function formatSessionReadyText(record: WireSessionReadyRecord) {
  return text.line(
    `Shared session ready at ${record.endpoint} (snapshot #${record.snapshotId}, ${record.projects.length} project(s)).`,
  );
}

/**
 * Starts a long-lived shared session bound to a single project configuration, emits
 * a ready notification, serves cross-process `verule check --session` queries, and cleans
 * up the socket endpoint and engine subprocess on shutdown.
 */
export async function* streamSharedSession<
  TReadyFact,
  TSuccessFact,
  TFailureFact,
>(
  workingDirectory: string,
  configOption: string | undefined,
  socketOption: string,
  signal: AbortSignal | undefined,
  outcome: {
    readonly record: {
      readonly ready: (payload: WireSessionReadyRecord) => TReadyFact;
    };
    readonly streamSuccess: () => TSuccessFact;
    readonly failure: {
      readonly failed: (payload: {
        readonly reportVersion: typeof REPORT_SCHEMA_VERSION;
        readonly code: string;
        readonly message: string;
      }) => TFailureFact;
    };
  },
): AsyncGenerator<TReadyFact, TSuccessFact | TFailureFact, void> {
  let sharedSession: SharedSession | undefined;

  try {
    const initial = await loadProjectConfigWithDependencies(
      workingDirectory,
      configOption,
    );
    const watchFiles = new Set<string>(initial.watchFiles);
    if (configOption !== undefined) {
      watchFiles.add(resolve(workingDirectory, configOption));
    }

    sharedSession = await startSharedSession({
      cwd: workingDirectory,
      endpoint: socketOption,
      config: initial.config,
      watchFiles: [...watchFiles],
      ...(signal !== undefined ? { signal } : {}),
      loadConfig: async () => {
        const loaded = await loadProjectConfigWithDependencies(
          workingDirectory,
          configOption,
        );
        return {
          config: loaded.config,
          watchFiles: loaded.watchFiles,
        };
      },
    });
  } catch (err) {
    const failure =
      err instanceof VeruleExecutionError
        ? {
            reportVersion: REPORT_SCHEMA_VERSION,
            code: err.code,
            message: err.message,
          }
        : {
            reportVersion: REPORT_SCHEMA_VERSION,
            code: "ENGINE_ERROR",
            message: err instanceof Error ? err.message : String(err),
          };
    return outcome.failure.failed(failure);
  }

  try {
    yield outcome.record.ready({
      reportVersion: REPORT_SCHEMA_VERSION,
      endpoint: sharedSession.endpoint,
      snapshotId: sharedSession.snapshotId,
      projects: toWireProjects(sharedSession.projects),
    });

    await sharedSession.waitUntilClosed();
  } finally {
    await sharedSession.close();
  }

  return outcome.streamSuccess();
}
