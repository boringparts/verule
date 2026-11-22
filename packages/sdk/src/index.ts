import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { engineExecutablePath } from "@verule/engine/binary";

export {
  defineConfig,
  defineModel,
  defineRule,
  openSession,
  runCheck,
} from "./session.ts";
export { watchProject } from "./watch.ts";
export {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  type AnalysisSession,
  type CheckReport,
  type Diagnostic,
  type DiagnosticInput,
  type DiagnosticLocation,
  type Evidence,
  type FindSyntaxOptions,
  type Gap,
  type MemoryStats,
  type Model,
  type ModelIdentitySummary,
  type NormalizedVeruleConfig,
  type ObserveMode,
  type OpenSessionOptions,
  type ProgramObjectKind,
  type ProgramRef,
  type ProjectSummary,
  type RecomputationScope,
  type ReportIdentity,
  type Rule,
  type RuleContext,
  type RuleIdentitySummary,
  type RunCheckOptions,
  type SessionUpdateOptions,
  type SessionUpdateResult,
  type SyntaxKind,
  type SyntaxNodeResult,
  type SyntaxRef,
  type TypeAtResult,
  type TypeRef,
  type VeruleConfig,
  type VeruleErrorCode,
  type WatchConfigLoadResult,
  type WatchEvent,
  type WatchFailureEvent,
  type WatchProjectOptions,
  type WatchReportEvent,
  type WatchTrigger,
} from "./types.ts";

const runEngine = promisify(execFile);

/** Runs the packaged engine and rejects if the executable cannot run. */
export async function getEngineVersion(): Promise<string> {
  const { stdout } = await runEngine(engineExecutablePath, ["--version"]);
  return stdout.trimEnd();
}
