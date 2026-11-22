import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { engineExecutablePath } from "@verule/engine/binary";

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
  type DeclarationRef,
  type Diagnostic,
  type DiagnosticInput,
  type DiagnosticLocation,
  type Evidence,
  type FindSyntaxOptions,
  type Gap,
  type NormalizedVeruleConfig,
  type ObserveMode,
  type OpenSessionOptions,
  type ProgramObjectKind,
  type ProgramRef,
  type ProjectSummary,
  type Rule,
  type RuleContext,
  type RunCheckOptions,
  type SignatureRef,
  type SourceRange,
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
