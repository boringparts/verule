import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { engineExecutablePath } from "@verule/engine/binary";

export { parseObserveLimit, parseTargetSpec } from "./observation.ts";
export { defineConfig, defineRule, openSession, runCheck } from "./session.ts";
export type {
  AssignabilityPair,
  AssignabilityResult,
  CallProjectionSelection,
  DeclarationProjectionSelection,
  FullCallProjectionFields,
  FullDeclarationProjectionFields,
  FullSignatureProjectionFields,
  FullSyntaxLookupFields,
  FullTypeProjectionFields,
  InstantiatedParameterType,
  ProjectedCallResolutionRow,
  ProjectedCallRow,
  ProjectedDeclarationRow,
  ProjectedSignatureRow,
  ProjectedSyntaxLookupRow,
  ProjectedTypeRow,
  SelectedKeys,
  SignatureParameterInfo,
  SignatureProjectionSelection,
  SyntaxLookupSelection,
  TypeProjectionSelection,
  TypePropertyInfo,
  TypeSummary,
} from "./projection.ts";
export {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  type AnalysisSession,
  type CallRef,
  type CheckReport,
  type CheckpointOutcome,
  type CheckpointTarget,
  type CompilerOptionsSummary,
  type DeclarationRef,
  type Diagnostic,
  type DiagnosticInput,
  type DiagnosticLocation,
  type Evidence,
  type ExplainCheckpointTrace,
  type ExplainOptions,
  type ExplainQueryStep,
  type ExplainReport,
  type ExplainResult,
  type ExplainStatus,
  type FindSyntaxOptions,
  type Gap,
  type NormalizedVeruleConfig,
  type ObservationDetailEntry,
  type ObservationOverhead,
  type ObservationPhases,
  type ObservationReport,
  type ObservationRpcMetrics,
  type ObserveLimit,
  type ObserveLimitInput,
  type ObserveMode,
  type ObserveOptions,
  type OpenSessionOptions,
  type ProgramObjectKind,
  type ProgramRef,
  type ProjectSummary,
  type Rule,
  type RuleContext,
  type RunCheckOptions,
  type SessionCheckOptions,
  type SignatureRef,
  type SourceFileOrigin,
  type SourceFileProjectOrigin,
  type SourceRange,
  type SourceTarget,
  type SyntaxKind,
  type SyntaxNodeResult,
  type SyntaxRef,
  type TypeAtResult,
  type TypeRef,
  type VeruleConfig,
  type VeruleErrorCode,
} from "./types.ts";

const runEngine = promisify(execFile);

/** Runs the packaged engine and rejects if the executable cannot run. */
export async function getEngineVersion(): Promise<string> {
  const { stdout } = await runEngine(engineExecutablePath, ["--version"]);
  return stdout.trimEnd();
}
