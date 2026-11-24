import {
  REPORT_SCHEMA_VERSION,
  type CheckReport,
  type ExplainResult,
  type FactConflictDetails,
  type ObservationReport,
  type ProjectSummary,
} from "@verule/sdk";
import { z } from "zod";

export const locationSchema = z.object({
  file: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  endLine: z.number().int().positive(),
  endColumn: z.number().int().positive(),
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
});

export const evidenceSchema = z.object({
  kind: z.enum(["source", "type", "note", "model"]),
  message: z.string(),
  at: locationSchema.optional(),
  modelId: z.string().optional(),
  declaration: z.string().optional(),
});

export const gapSchema = z.object({
  kind: z.string(),
  message: z.string(),
  at: locationSchema.optional(),
});

export const diagnosticSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  at: locationSchema,
  message: z.string(),
  evidence: z.array(evidenceSchema),
  projects: z.array(z.string()),
});

export const compilerOptionsSummarySchema = z.object({
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

export const projectSummarySchema = z.object({
  projectId: z.string(),
  configFile: z.string(),
  entryConfig: z.string(),
  entryChain: z.array(z.string()),
  referencedBy: z.array(z.string()),
  projectReferences: z.array(z.string()),
  compilerOptions: compilerOptionsSummarySchema,
  sourceFiles: z.array(z.string()),
});

export const sourceFileProjectOriginSchema = z.object({
  projectId: z.string(),
  configFile: z.string(),
  entryConfig: z.string(),
  entryChain: z.array(z.string()),
});

export const sourceFileOriginSchema = z.object({
  file: z.string(),
  projects: z.array(sourceFileProjectOriginSchema),
});

export const additionalInputSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("config") }),
  z.object({ kind: z.literal("rule"), id: z.string() }),
  z.object({ kind: z.literal("adapter"), id: z.string() }),
]);

export const additionalInputEntrySchema = z.object({
  file: z.string(),
  exists: z.boolean(),
  digest: z.string().optional(),
  sources: z.array(additionalInputSourceSchema),
});

export const ruleIdentitySchema = z.object({
  id: z.string(),
  digest: z.string(),
});

export const modelIdentitySchema = z.object({
  id: z.string(),
  version: z.string().optional(),
  digest: z.string(),
});

export const reportIdentitySchema = z.object({
  snapshotDigest: z.string(),
  configDigest: z.string(),
  rules: z.array(ruleIdentitySchema),
  models: z.array(modelIdentitySchema),
});

export const observationDetailEntrySchema = z.object({
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

export const observationSchema = z.object({
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
  nativeAdapters: z.array(
    z.object({
      packageName: z.string(),
      providerId: z.string(),
      status: z.enum(["loaded", "reused"]),
    }),
  ),
  limit: z
    .object({
      maxItems: z.number().int().nonnegative().optional(),
      maxBytes: z.number().int().nonnegative().optional(),
    })
    .optional(),
  truncated: z.boolean(),
  droppedCount: z.number().int().nonnegative(),
  engineExtractions: z.record(
    z.string(),
    z.object({
      extractions: z.number().int().nonnegative(),
      candidates: z.number().int().nonnegative(),
    }),
  ),
  details: z.array(observationDetailEntrySchema).optional(),
});

export const explainQueryStepSchema = z.object({
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

export const explainCheckpointTraceSchema = z.object({
  name: z.string(),
  ruleId: z.string(),
  projectId: z.string(),
  outcome: z.enum(["pass", "exclude", "info"]),
  at: locationSchema.optional(),
  detail: z.unknown().optional(),
});

export const explainCleanupPathSchema = z.object({
  instanceKey: z.string(),
  allocationLocation: locationSchema.optional(),
  scopeLocation: locationSchema,
  cleanupLocations: z.array(locationSchema),
  modelIds: z.array(z.string()),
  summary: z.string(),
  evidence: z.array(evidenceSchema),
});

export const explainGapResolutionSchema = z.object({
  providerId: z.string(),
  operation: z.string(),
  conclusion: z.string(),
  at: locationSchema.optional(),
});

export const explainLocalGapSchema = z.object({
  status: z.enum(["unresolved", "resolved_by_override"]),
  factTypeId: z.string(),
  providerId: z.string(),
  field: z.string().optional(),
  gap: gapSchema,
  subjectLocation: locationSchema.optional(),
  resolvedBy: explainGapResolutionSchema.optional(),
  impact: z.string().optional(),
});

export const explainProviderEvaluationSchema = z.object({
  providerId: z.string(),
  factTypeId: z.string().optional(),
  status: z.enum(["evaluated", "reused", "skipped"]),
  reason: z.string().optional(),
  subjectLocation: locationSchema.optional(),
});

export const explainResultSchema = z.object({
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
  localGaps: z.array(explainLocalGapSchema),
  providerEvaluations: z.array(explainProviderEvaluationSchema),
  providers: z.array(z.string()),
  cleanupPaths: z.array(explainCleanupPathSchema),
  inlineIgnore: z
    .object({
      matched: z.boolean(),
      ruleId: z.string().optional(),
      reason: z.string().optional(),
      commentAt: locationSchema.optional(),
    })
    .optional(),
});

export const inlineIgnoreEntrySchema = z.object({
  status: z.enum([
    "suppressed",
    "unused",
    "ambiguous",
    "malformed",
    "unknown_rule",
    "undetermined",
  ]),
  at: locationSchema,
  targetLine: z.number().int().positive().optional(),
  ruleId: z.string().optional(),
  reason: z.string().optional(),
  matchedLocations: z.array(locationSchema).optional(),
  message: z.string().optional(),
});

export const checkReportSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  status: z.enum(["clean", "findings"]),
  projects: z.array(projectSummarySchema),
  fileOrigins: z.array(sourceFileOriginSchema),
  additionalInputs: z.array(additionalInputEntrySchema),
  diagnostics: z.array(diagnosticSchema),
  gaps: z.array(gapSchema),
  identity: reportIdentitySchema,
  inlineIgnores: z.array(inlineIgnoreEntrySchema).optional(),
  observation: observationSchema.optional(),
  explanation: explainResultSchema.optional(),
  explanations: z.array(explainResultSchema).optional(),
});

export type WireCheckReport = z.infer<typeof checkReportSchema>;
export type WireProjectSummary = z.infer<typeof projectSummarySchema>;
export type WireObservation = z.infer<typeof observationSchema>;
export type WireExplainResult = z.infer<typeof explainResultSchema>;

export const factConflictPartySchema = z.object({
  providerId: z.string(),
  providers: z.array(z.string()),
  conclusion: z.unknown(),
  conclusionSummary: z.string(),
  evidence: z.array(evidenceSchema),
});

export const factConflictDetailsSchema = z.object({
  factTypeId: z.string(),
  projectId: z.string(),
  snapshotId: z.number().int().positive(),
  subjectHandleId: z.string(),
  subjectLocation: locationSchema.optional(),
  condition: z.unknown().optional(),
  reason: z.string(),
  parties: z.tuple([factConflictPartySchema, factConflictPartySchema]),
});

export type WireFactConflictDetails = z.infer<typeof factConflictDetailsSchema>;

export const checkFailureSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  code: z.string(),
  message: z.string(),
  conflict: factConflictDetailsSchema.optional(),
});

function toWireEvidence(
  ev: CheckReport["diagnostics"][number]["evidence"][number],
) {
  return {
    kind: ev.kind,
    message: ev.message,
    ...(ev.at !== undefined ? { at: { ...ev.at } } : {}),
    ...(ev.modelId !== undefined ? { modelId: ev.modelId } : {}),
    ...(ev.declaration !== undefined ? { declaration: ev.declaration } : {}),
  };
}

export function toWireFactConflict(
  conflict: FactConflictDetails,
): WireFactConflictDetails {
  const [party0, party1] = conflict.parties;
  return {
    factTypeId: conflict.factTypeId,
    projectId: conflict.projectId,
    snapshotId: conflict.snapshotId,
    subjectHandleId: conflict.subjectHandleId,
    ...(conflict.subjectLocation !== undefined
      ? { subjectLocation: { ...conflict.subjectLocation } }
      : {}),
    ...(conflict.condition !== undefined
      ? { condition: conflict.condition }
      : {}),
    reason: conflict.reason,
    parties: [
      {
        providerId: party0.providerId,
        providers: [...party0.providers],
        conclusion: party0.conclusion,
        conclusionSummary: party0.conclusionSummary,
        evidence: party0.evidence.map(toWireEvidence),
      },
      {
        providerId: party1.providerId,
        providers: [...party1.providers],
        conclusion: party1.conclusion,
        conclusionSummary: party1.conclusionSummary,
        evidence: party1.evidence.map(toWireEvidence),
      },
    ],
  };
}

function sanitizeWireJsonValue(value: unknown): unknown {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "string"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) {
    return value.map((item) =>
      item === undefined ? null : sanitizeWireJsonValue(item),
    );
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out[key] = sanitizeWireJsonValue(item);
      }
    }
    return out;
  }
  if (value === undefined) {
    return null;
  }
  if (typeof value === "bigint" || typeof value === "symbol") {
    return value.toString();
  }
  return null;
}

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
    nativeAdapters: obs.nativeAdapters.map((adapter) => ({ ...adapter })),
    engineExtractions: Object.fromEntries(
      Object.entries(obs.engineExtractions).map(([providerId, stats]) => [
        providerId,
        { ...stats },
      ]),
    ),
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
            ...(entry.detail !== undefined
              ? { detail: sanitizeWireJsonValue(entry.detail) }
              : {}),
          })),
        }
      : {}),
  };
}

function toWireExplainQueryStep(q: ExplainResult["queries"][number]) {
  return {
    queryIndex: q.queryIndex,
    op: q.op,
    projectId: q.projectId,
    provider: q.provider,
    cacheStatus: q.cacheStatus,
    candidateCount: q.candidateCount,
    matchedTarget: q.matchedTarget,
    durationMs: q.durationMs,
    ...(q.summary !== undefined ? { summary: q.summary } : {}),
    ...(q.detail !== undefined
      ? { detail: sanitizeWireJsonValue(q.detail) }
      : {}),
  };
}

function toWireExplainCheckpoint(cp: ExplainResult["checkpoints"][number]) {
  return {
    name: cp.name,
    ruleId: cp.ruleId,
    projectId: cp.projectId,
    outcome: cp.outcome,
    ...(cp.at !== undefined ? { at: { ...cp.at } } : {}),
    ...(cp.detail !== undefined
      ? { detail: sanitizeWireJsonValue(cp.detail) }
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
          excludedByQuery: toWireExplainQueryStep(exp.excludedByQuery),
        }
      : {}),
    ...(exp.excludedByCheckpoint !== undefined
      ? {
          excludedByCheckpoint: toWireExplainCheckpoint(
            exp.excludedByCheckpoint,
          ),
        }
      : {}),
    queries: exp.queries.map(toWireExplainQueryStep),
    checkpoints: exp.checkpoints.map(toWireExplainCheckpoint),
    gaps: exp.gaps.map((g) => ({
      kind: g.kind,
      message: g.message,
      ...(g.at !== undefined ? { at: { ...g.at } } : {}),
    })),
    localGaps: exp.localGaps.map((lg) => ({
      status: lg.status,
      factTypeId: lg.factTypeId,
      providerId: lg.providerId,
      ...(lg.field !== undefined ? { field: lg.field } : {}),
      gap: {
        kind: lg.gap.kind,
        message: lg.gap.message,
        ...(lg.gap.at !== undefined ? { at: { ...lg.gap.at } } : {}),
      },
      ...(lg.subjectLocation !== undefined
        ? { subjectLocation: { ...lg.subjectLocation } }
        : {}),
      ...(lg.resolvedBy !== undefined
        ? {
            resolvedBy: {
              providerId: lg.resolvedBy.providerId,
              operation: lg.resolvedBy.operation,
              conclusion: lg.resolvedBy.conclusion,
              ...(lg.resolvedBy.at !== undefined
                ? { at: { ...lg.resolvedBy.at } }
                : {}),
            },
          }
        : {}),
      ...(lg.impact !== undefined ? { impact: lg.impact } : {}),
    })),
    providerEvaluations: exp.providerEvaluations.map((pe) => ({
      providerId: pe.providerId,
      ...(pe.factTypeId !== undefined ? { factTypeId: pe.factTypeId } : {}),
      status: pe.status,
      ...(pe.reason !== undefined ? { reason: pe.reason } : {}),
      ...(pe.subjectLocation !== undefined
        ? { subjectLocation: { ...pe.subjectLocation } }
        : {}),
    })),
    providers: [...exp.providers],
    cleanupPaths: exp.cleanupPaths.map((cp) => ({
      instanceKey: cp.instanceKey,
      ...(cp.allocationLocation !== undefined
        ? { allocationLocation: { ...cp.allocationLocation } }
        : {}),
      scopeLocation: { ...cp.scopeLocation },
      cleanupLocations: cp.cleanupLocations.map((loc) => ({ ...loc })),
      modelIds: [...cp.modelIds],
      summary: cp.summary,
      evidence: cp.evidence.map((ev) => ({
        kind: ev.kind,
        message: ev.message,
        ...(ev.at !== undefined ? { at: { ...ev.at } } : {}),
        ...(ev.modelId !== undefined ? { modelId: ev.modelId } : {}),
        ...(ev.declaration !== undefined
          ? { declaration: ev.declaration }
          : {}),
      })),
    })),
    ...(exp.inlineIgnore !== undefined
      ? {
          inlineIgnore: {
            matched: exp.inlineIgnore.matched,
            ...(exp.inlineIgnore.ruleId !== undefined
              ? { ruleId: exp.inlineIgnore.ruleId }
              : {}),
            ...(exp.inlineIgnore.reason !== undefined
              ? { reason: exp.inlineIgnore.reason }
              : {}),
            ...(exp.inlineIgnore.commentAt !== undefined
              ? { commentAt: { ...exp.inlineIgnore.commentAt } }
              : {}),
          },
        }
      : {}),
  };
}

export function toWireProjects(
  projects: readonly ProjectSummary[],
): WireProjectSummary[] {
  return projects.map((project) => ({
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
  }));
}

export function toWireReport(report: CheckReport): WireCheckReport {
  return {
    reportVersion: report.reportVersion,
    status: report.status,
    projects: toWireProjects(report.projects),
    fileOrigins: report.fileOrigins.map((origin) => ({
      file: origin.file,
      projects: origin.projects.map((proj) => ({
        projectId: proj.projectId,
        configFile: proj.configFile,
        entryConfig: proj.entryConfig,
        entryChain: [...proj.entryChain],
      })),
    })),
    additionalInputs: report.additionalInputs.map((entry) => ({
      file: entry.file,
      exists: entry.exists,
      ...(entry.digest !== undefined ? { digest: entry.digest } : {}),
      sources: entry.sources.map((src) =>
        src.kind === "config"
          ? { kind: "config" as const }
          : { kind: src.kind, id: src.id },
      ),
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
        ...(item.modelId !== undefined ? { modelId: item.modelId } : {}),
        ...(item.declaration !== undefined
          ? { declaration: item.declaration }
          : {}),
      })),
      projects: [...diag.projects],
    })),
    gaps: report.gaps.map((gap) => ({
      kind: gap.kind,
      message: gap.message,
      ...(gap.at !== undefined ? { at: { ...gap.at } } : {}),
    })),
    identity: {
      snapshotDigest: report.identity.snapshotDigest,
      configDigest: report.identity.configDigest,
      rules: report.identity.rules.map((rule) => ({
        id: rule.id,
        digest: rule.digest,
      })),
      models: report.identity.models.map((model) => ({
        id: model.id,
        ...(model.version !== undefined ? { version: model.version } : {}),
        digest: model.digest,
      })),
    },
    ...(report.inlineIgnores !== undefined
      ? {
          inlineIgnores: report.inlineIgnores.map((entry) => ({
            status: entry.status,
            at: { ...entry.at },
            ...(entry.targetLine !== undefined
              ? { targetLine: entry.targetLine }
              : {}),
            ...(entry.ruleId !== undefined ? { ruleId: entry.ruleId } : {}),
            ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
            ...(entry.matchedLocations !== undefined
              ? {
                  matchedLocations: entry.matchedLocations.map((loc) => ({
                    ...loc,
                  })),
                }
              : {}),
            ...(entry.message !== undefined ? { message: entry.message } : {}),
          })),
        }
      : {}),
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

export function formatDiagnosticsLines(report: WireCheckReport): string[] {
  const lines: string[] = [];
  for (const diag of report.diagnostics) {
    lines.push(
      `${diag.at.file}:${diag.at.line}:${diag.at.column} [${diag.ruleId}] (${diag.id}) ${diag.message} [projects: ${diag.projects.join(", ")}]`,
    );
    for (const item of diag.evidence) {
      const locSuffix = item.at
        ? ` (${item.at.file}:${item.at.line}:${item.at.column})`
        : "";
      const modelSuffix =
        item.modelId !== undefined
          ? ` [model=${item.modelId}${item.declaration !== undefined ? `:${item.declaration}` : ""}]`
          : "";
      lines.push(
        `  evidence (${item.kind}): ${item.message}${modelSuffix}${locSuffix}`,
      );
    }
  }
  return lines;
}

export function appendGapLines(
  lines: string[],
  gaps: WireCheckReport["gaps"],
): void {
  for (const gap of gaps) {
    const locSuffix = gap.at
      ? ` (${gap.at.file}:${gap.at.line}:${gap.at.column})`
      : "";
    lines.push(`gap [${gap.kind}]: ${gap.message}${locSuffix}`);
  }
}

export function formatScopeLines(report: WireCheckReport): string[] {
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
  if (report.additionalInputs.length > 0) {
    lines.push(`Additional inputs (${report.additionalInputs.length}):`);
    for (const input of report.additionalInputs) {
      const sources = input.sources.map((src) =>
        src.kind === "config" ? "config" : `${src.kind}:${src.id}`,
      );
      const statusSuffix = input.exists ? "" : " [missing]";
      lines.push(`  - ${input.file}${statusSuffix} <- ${sources.join(", ")}`);
    }
  }
  return lines;
}
