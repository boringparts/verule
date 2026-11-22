import { REPORT_SCHEMA_VERSION, type CheckReport } from "@verule/sdk";
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
  kind: z.enum(["source", "type", "note"]),
  message: z.string(),
  at: locationSchema.optional(),
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

export const projectSummarySchema = z.object({
  projectId: z.string(),
  configFile: z.string(),
  sourceFiles: z.array(z.string()),
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

export const checkReportSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  status: z.enum(["clean", "findings"]),
  projects: z.array(projectSummarySchema),
  diagnostics: z.array(diagnosticSchema),
  gaps: z.array(gapSchema),
  identity: reportIdentitySchema,
});

export type WireCheckReport = z.infer<typeof checkReportSchema>;

export const checkFailureSchema = z.object({
  reportVersion: z.literal(REPORT_SCHEMA_VERSION),
  code: z.string(),
  message: z.string(),
});

export function toWireReport(report: CheckReport): WireCheckReport {
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
  };
}

export function formatDiagnosticsLines(report: WireCheckReport): string[] {
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
  return lines;
}
