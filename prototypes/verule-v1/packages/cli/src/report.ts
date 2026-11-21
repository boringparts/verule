import { text } from "@ykdz/cli-contract";
import { z } from "zod";

const location = z.object({
  file: z.string(),
  line: z.number(),
  column: z.number(),
  endLine: z.number(),
  endColumn: z.number(),
});
const evidence = z.object({
  at: location,
  reason: z.string(),
  kind: z.enum(["source", "model", "approximation"]),
});
export const reportSchema = z.object({
  version: z.string(),
  diagnostics: z.array(
    z.object({
      id: z.string(),
      rule: z.string(),
      message: z.string(),
      at: location,
      evidence: z.array(evidence),
    }),
  ),
  gaps: z.array(
    z.object({ rule: z.string(), reason: z.string(), at: location }),
  ),
});
export const failureSchema = z.object({
  version: z.string(),
  message: z.string(),
});
export type CheckReport = z.infer<typeof reportSchema>;
export type CheckFailure = z.infer<typeof failureSchema>;

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function position(at: z.infer<typeof location>): string {
  return [at.file, at.line, at.column].join(":");
}

export function presentReport(report: CheckReport) {
  const heading = `Check ${report.version} | ${report.diagnostics.length} diagnostics, ${report.gaps.length} gaps`;
  const lines: string[] = [];
  for (const diagnostic of report.diagnostics) {
    lines.push(
      `${position(diagnostic.at)}  ${diagnostic.rule}  ${diagnostic.message}`,
    );
    for (const item of diagnostic.evidence) {
      lines.push(`  ${item.kind}  ${position(item.at)}  ${item.reason}`);
    }
  }
  for (const gap of report.gaps) {
    lines.push(`${position(gap.at)}  ${gap.rule}  Unknown: ${gap.reason}`);
  }
  return text.lines([
    heading,
    ...lines.flatMap((line) =>
      line.replaceAll("\0", "\uFFFD").split(/\r\n|[\r\n]/u),
    ),
  ]);
}

export function presentFailure({ version, message }: CheckFailure) {
  return text.lines([
    `Check ${version} failed`,
    ...message.replaceAll("\0", "\uFFFD").split(/\r\n|[\r\n]/u),
  ]);
}
