import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import { dirname, resolve } from "node:path";

import type { CheckReport } from "@boringparts/verule";
import { runTscTypecheck } from "@verule/test-hosts";

import {
  type PackedArtifact,
  type PackedArtifactBundle,
  packWorkspaceArtifacts,
} from "./artifacts.ts";
import { type PreparedAcceptanceHost } from "./host-lifecycle.ts";
import {
  appendUnrelatedBackgroundComment,
  assertPoolOwnershipClean,
  assertPoolOwnershipInitialFindings,
  assertPoolOwnershipReportsReconcile,
  fixPoolOwnershipViolation,
  POOL_OWNERSHIP_TIERS,
  type PoolOwnershipMaterializedSpec,
  type PoolOwnershipScaleSpec,
  restorePoolOwnershipViolation,
  verifyPoolOwnershipScaleAndCandidates,
  withPoolOwnershipHost,
} from "./pool-ownership-scenario.ts";
import {
  parseCheckJsonResult,
  type WatchReportRecord,
} from "./process-stream.ts";

export const SUPPORTED_PERF_SCENARIOS = ["pool-ownership"] as const;
export type PerfScenarioName = (typeof SUPPORTED_PERF_SCENARIOS)[number];
export type PerfExecutionStatus = "succeeded" | "failed" | "not_run";

export type PerfCliOptions = {
  readonly scenario: PerfScenarioName;
  readonly tiers: readonly PoolOwnershipScaleSpec[];
  readonly samples: number;
  readonly retries: number;
  readonly jsonOut?: string;
  readonly markdownOut?: string;
  readonly help: boolean;
};

export type PerfRoundAttempt = {
  readonly attempt: number;
  readonly status: "succeeded" | "failed";
  readonly coldCheckMs?: number;
  readonly fixOwnershipMs?: number;
  readonly unrelatedEditMs?: number;
  readonly failureReason?: string;
  readonly coldCheckStatus?: number;
  readonly watchInitialSnapshotId?: number;
  readonly watchFixSnapshotId?: number;
  readonly watchRestoreSnapshotId?: number;
  readonly watchUnrelatedSnapshotId?: number;
  readonly durationMs: number;
};

export type PerfRoundResult = {
  readonly round: number;
  readonly status: PerfExecutionStatus;
  readonly coldCheckMs?: number;
  readonly fixOwnershipMs?: number;
  readonly unrelatedEditMs?: number;
  readonly retryCount: number;
  readonly attempts: readonly PerfRoundAttempt[];
  readonly failureReason?: string;
};

export type PerfTierPreflight = {
  readonly status: PerfExecutionStatus;
  readonly typecheckMs?: number;
  readonly scaleAuditMs?: number;
  readonly observedFileCount?: number;
  readonly observedCandidateCount?: number;
  readonly seedCheckpointCount?: number;
  readonly judgmentCheckpointCount?: number;
  readonly coldReconcileStates: readonly string[];
  readonly failureReason?: string;
};

export type PerfTierResult = {
  readonly tierLabel: string;
  readonly fileCount: number;
  readonly candidateFactoryCount: number;
  readonly status: PerfExecutionStatus;
  readonly preflight: PerfTierPreflight;
  readonly rounds: readonly PerfRoundResult[];
  readonly succeededRounds: number;
  readonly failedRounds: number;
  readonly notRunRounds: number;
  readonly totalRetries: number;
  readonly medianColdCheckMs: number | null;
  readonly medianFixOwnershipMs: number | null;
  readonly medianUnrelatedEditMs: number | null;
  readonly coldCheckSamplesMs: readonly number[];
  readonly fixOwnershipSamplesMs: readonly number[];
  readonly unrelatedEditSamplesMs: readonly number[];
  readonly failureReason?: string;
  readonly durationMs: number;
};

export type PerfArtifactSummary = {
  readonly name: string;
  readonly version: string;
  readonly sha256: string;
  readonly integrity: string;
  readonly size: number;
  readonly binarySha256?: string;
};

export type PerfEnvironmentMetadata = {
  readonly timestampUtc: string;
  readonly gitCommit: string;
  readonly gitDirty: boolean;
  readonly platform: NodeJS.Platform;
  readonly osRelease: string;
  readonly arch: string;
  readonly cpuModel: string;
  readonly cpuCores: number;
  readonly totalMemoryBytes: number;
  readonly nodeVersion: string;
  readonly pnpmVersion: string;
  readonly cargoVersion?: string;
  readonly rustcVersion?: string;
  readonly isolationMode?: string;
  readonly artifacts: readonly PerfArtifactSummary[];
  readonly cacheConditions: {
    readonly artifactsPackedOnce: boolean;
    readonly perTierIsolatedHostInstall: boolean;
    readonly osPageCacheMode: string;
    readonly observerInTimedRounds: "off";
  };
};

export type PerfBaselineReport = {
  readonly scenario: PerfScenarioName;
  readonly status: "succeeded" | "failed";
  readonly samples: number;
  readonly retries: number;
  readonly command: string;
  readonly environment: PerfEnvironmentMetadata;
  readonly tiers: readonly PerfTierResult[];
  readonly totalDurationMs: number;
};

export type PerfTierExecutionOutcome = {
  readonly preflight: PerfTierPreflight;
  readonly rounds: readonly PerfRoundResult[];
  readonly isolationMode?: string;
  readonly abortRemainingTiers?: boolean;
  readonly failureReason?: string;
  readonly durationMs: number;
};

export type PerfTierExecutor = (context: {
  readonly tier: PoolOwnershipScaleSpec;
  readonly samples: number;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly bundle: PackedArtifactBundle;
}) => Promise<PerfTierExecutionOutcome>;

export type RunPoolOwnershipPerfOptions = {
  readonly scenario?: PerfScenarioName;
  readonly tiers?: readonly PoolOwnershipScaleSpec[];
  readonly samples?: number;
  readonly retries?: number;
  readonly timeoutMs?: number;
  readonly workspaceRoot?: string;
  readonly bundle?: PackedArtifactBundle;
  readonly executeTier?: PerfTierExecutor;
  readonly logProgress?: (line: string) => void;
};

const defaultOperationTimeoutMs = 120_000;
const poolOwnershipAdditionalPackages = [
  "@verule/rules-reference",
  "@verule/adapter-drizzle",
  "@verule/adapter-zod",
] as const;

export function formatTierLabel(tier: PoolOwnershipScaleSpec): string {
  return `${String(tier.fileCount)}/${String(tier.candidateFactoryCount)}`;
}

/**
 * Parses a `<files>/<candidates>` tier string into a validated scale spec.
 */
export function parseScaleTier(raw: string): PoolOwnershipScaleSpec {
  const trimmed = raw.trim();
  const match = /^(\d+)\/(\d+)$/u.exec(trimmed);
  if (match === null) {
    throw new Error(
      `Invalid tier "${raw}". Expected "<files>/<candidates>" (for example "256/8").`,
    );
  }
  const fileCount = Number(match[1]);
  const candidateFactoryCount = Number(match[2]);
  if (!Number.isSafeInteger(fileCount) || fileCount < 5) {
    throw new Error(
      `Invalid tier "${raw}": fileCount must be an integer >= 5.`,
    );
  }
  if (
    !Number.isSafeInteger(candidateFactoryCount) ||
    candidateFactoryCount < 1
  ) {
    throw new Error(
      `Invalid tier "${raw}": candidateFactoryCount must be an integer >= 1.`,
    );
  }
  return { fileCount, candidateFactoryCount };
}

/**
 * Deduplicates scale tiers by `<fileCount>/<candidateFactoryCount>` while
 * preserving first-seen order so shared intersections such as `256/8` run once.
 */
export function deduplicateTiers(
  tiers: readonly PoolOwnershipScaleSpec[],
): readonly PoolOwnershipScaleSpec[] {
  const seen = new Set<string>();
  const unique: PoolOwnershipScaleSpec[] = [];
  for (const tier of tiers) {
    const key = formatTierLabel(tier);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push({
        fileCount: tier.fileCount,
        candidateFactoryCount: tier.candidateFactoryCount,
      });
    }
  }
  return unique;
}

function parsePositiveInt(raw: string, flagName: string): number {
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(
      `Invalid ${flagName} value "${raw}". Expected a positive integer.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(
      `Invalid ${flagName} value "${raw}". Expected a positive integer.`,
    );
  }
  return value;
}

function parseNonNegativeInt(raw: string, flagName: string): number {
  if (!/^\d+$/u.test(raw.trim())) {
    throw new Error(
      `Invalid ${flagName} value "${raw}". Expected a non-negative integer.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `Invalid ${flagName} value "${raw}". Expected a non-negative integer.`,
    );
  }
  return value;
}

export function formatPerfCliUsage(): string {
  return [
    "Usage: pnpm perf -- [options]",
    "",
    "Options:",
    `  --scenario <name>           Scenario to run (default: "pool-ownership"; supported: ${SUPPORTED_PERF_SCENARIOS.join(", ")})`,
    "  --tier <files>/<candidates> Run specific tier (repeatable; e.g. --tier 64/8 --tier 256/8)",
    '  --tiers <list>              Comma-separated tiers (default: "64/8,256/8,1024/8,256/32,256/128")',
    "  --samples <n>               Number of sampling rounds per tier (default: 5)",
    "  --retries <n>               Max retries per failed round (default: 0)",
    "  --json-out <path>           Write full structured JSON baseline report",
    "  --markdown-out <path>       Write Simplified Chinese Markdown baseline report",
    "  -h, --help                  Show this help message",
  ].join("\n");
}

/**
 * Parses CLI options for the performance runner while tolerating a leading or
 * forwarded `--` separator from package-manager wrappers.
 */
export function parsePerfCliArgs(argv: readonly string[]): PerfCliOptions {
  let scenario: PerfScenarioName = "pool-ownership";
  const explicitTiers: PoolOwnershipScaleSpec[] = [];
  let samples = 5;
  let retries = 0;
  let jsonOut: string | undefined;
  let markdownOut: string | undefined;
  let help = false;

  const consumeValue = (
    index: number,
    flag: string,
    inline?: string,
  ): string => {
    if (inline !== undefined) {
      if (inline.length === 0) {
        throw new Error(`Missing value for ${flag}`);
      }
      return inline;
    }
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("--")) {
      throw new Error(`Missing value for ${flag}`);
    }
    return next;
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === "--") {
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }

    const eqIndex = arg.indexOf("=");
    const flag = eqIndex === -1 ? arg : arg.slice(0, eqIndex);
    const inlineValue = eqIndex === -1 ? undefined : arg.slice(eqIndex + 1);
    const advanceIfSeparate = inlineValue === undefined ? 1 : 0;

    switch (flag) {
      case "--scenario": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        if (!(SUPPORTED_PERF_SCENARIOS as readonly string[]).includes(value)) {
          throw new Error(
            `Unknown scenario "${value}". Supported scenarios: ${SUPPORTED_PERF_SCENARIOS.join(", ")}.`,
          );
        }
        scenario = value as PerfScenarioName;
        break;
      }
      case "--tier": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        explicitTiers.push(parseScaleTier(value));
        break;
      }
      case "--tiers": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        const parts = value
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        if (parts.length === 0) {
          throw new Error("Expected at least one tier in --tiers");
        }
        for (const part of parts) {
          explicitTiers.push(parseScaleTier(part));
        }
        break;
      }
      case "--samples": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        samples = parsePositiveInt(value, "--samples");
        break;
      }
      case "--retries": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        retries = parseNonNegativeInt(value, "--retries");
        break;
      }
      case "--json-out": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        if (value.trim().length === 0) {
          throw new Error("Expected non-empty path for --json-out");
        }
        jsonOut = value;
        break;
      }
      case "--markdown-out": {
        const value = consumeValue(i, flag, inlineValue);
        i += advanceIfSeparate;
        if (value.trim().length === 0) {
          throw new Error("Expected non-empty path for --markdown-out");
        }
        markdownOut = value;
        break;
      }
      default: {
        throw new Error(
          arg.startsWith("-")
            ? `Unknown option "${arg}". Run with --help to inspect valid flags.`
            : `Unexpected positional argument "${arg}". Run with --help to inspect valid flags.`,
        );
      }
    }
  }

  const tiers =
    explicitTiers.length > 0
      ? deduplicateTiers(explicitTiers)
      : deduplicateTiers(POOL_OWNERSHIP_TIERS);

  return {
    scenario,
    tiers,
    samples,
    retries,
    ...(jsonOut === undefined ? {} : { jsonOut }),
    ...(markdownOut === undefined ? {} : { markdownOut }),
    help,
  };
}

/** Computes the statistical median for a numeric sample array, or `null` when empty. */
export function computeMedian(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].toSorted((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function roundMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function formatMsCell(value: number | null): string {
  return value === null ? "n/a" : value.toFixed(1);
}

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function padRight(text: string, width: number): string {
  return text.length >= width
    ? text
    : `${text}${" ".repeat(width - text.length)}`;
}

function padLeft(text: string, width: number): string {
  return text.length >= width
    ? text
    : `${" ".repeat(width - text.length)}${text}`;
}

/**
 * Formats the default stdout summary table with file count, candidate factory
 * count, three latency medians, execution status, and failure details.
 */
export function formatPerfSummaryTable(report: PerfBaselineReport): string {
  const headers = [
    "Files",
    "Candidates",
    "Cold Check (ms)",
    "Fix Ownership (ms)",
    "Unrelated Edit (ms)",
    "Status",
    "Rounds",
    "Retries",
  ] as const;

  const rows = report.tiers.map((tier) => [
    formatInt(tier.fileCount),
    formatInt(tier.candidateFactoryCount),
    formatMsCell(tier.medianColdCheckMs),
    formatMsCell(tier.medianFixOwnershipMs),
    formatMsCell(tier.medianUnrelatedEditMs),
    tier.status,
    `${String(tier.succeededRounds)}/${String(tier.rounds.length)}`,
    String(tier.totalRetries),
  ]);

  const widths = headers.map((header, columnIndex) =>
    Math.max(header.length, ...rows.map((row) => row[columnIndex]!.length)),
  );

  const numericColumns = new Set([0, 1, 2, 3, 4, 7]);
  const formatRow = (cells: readonly string[]): string =>
    cells
      .map((cell, columnIndex) =>
        numericColumns.has(columnIndex)
          ? padLeft(cell, widths[columnIndex]!)
          : padRight(cell, widths[columnIndex]!),
      )
      .join(" | ");

  const separator = widths.map((width) => "-".repeat(width)).join("-+-");
  const lines = [
    `Scenario: ${report.scenario} | Samples: ${String(report.samples)} | Retries: ${String(report.retries)} | Status: ${report.status}`,
    formatRow(headers),
    separator,
    ...rows.map((row) => formatRow(row)),
  ];

  const failures: string[] = [];
  for (const tier of report.tiers) {
    if (tier.status !== "succeeded") {
      failures.push(
        `- ${tier.tierLabel} [${tier.status}]: ${tier.failureReason ?? "unspecified failure"}`,
      );
      for (const round of tier.rounds) {
        if (round.status !== "succeeded" && round.failureReason !== undefined) {
          failures.push(
            `  round ${String(round.round)} [${round.status}]: ${round.failureReason}`,
          );
        }
      }
    }
  }
  if (failures.length > 0) {
    lines.push("", "Failures / Not-Run Details:", ...failures);
  }

  return lines.join("\n");
}

function formatArtifactListMd(
  artifacts: readonly PerfArtifactSummary[],
): string {
  return artifacts
    .map((artifact) => {
      const binaryPart =
        artifact.binarySha256 === undefined
          ? ""
          : `, binary sha256=${artifact.binarySha256.slice(0, 12)}`;
      return `- \`${artifact.name}@${artifact.version}\`: tgz sha256=\`${artifact.sha256}\`${binaryPart}`;
    })
    .join("\n");
}

function summarizeCurveObservations(
  tiers: readonly PerfTierResult[],
): readonly string[] {
  const byLabel = new Map(tiers.map((tier) => [tier.tierLabel, tier]));
  const t64 = byLabel.get("64/8");
  const t256 = byLabel.get("256/8");
  const t1024 = byLabel.get("1024/8");
  const t256c32 = byLabel.get("256/32");
  const t256c128 = byLabel.get("256/128");
  const notes: string[] = [];

  if (
    t64?.medianColdCheckMs != null &&
    t256?.medianColdCheckMs != null &&
    t1024?.medianColdCheckMs != null
  ) {
    notes.push(
      `- 文件规模曲线（固定 8 个候选工厂，64 -> 256 -> 1,024 文件）：冷检查中位数从 ${t64.medianColdCheckMs.toFixed(1)} ms 增至 ${t256.medianColdCheckMs.toFixed(1)} ms、${t1024.medianColdCheckMs.toFixed(1)} ms；修复归属延迟从 ${formatMsCell(t64.medianFixOwnershipMs)} ms 变为 ${formatMsCell(t256.medianFixOwnershipMs)} ms、${formatMsCell(t1024.medianFixOwnershipMs)} ms；无关编辑延迟从 ${formatMsCell(t64.medianUnrelatedEditMs)} ms 变为 ${formatMsCell(t256.medianUnrelatedEditMs)} ms、${formatMsCell(t1024.medianUnrelatedEditMs)} ms。`,
    );
  }
  if (
    t256?.medianColdCheckMs != null &&
    t256c32?.medianColdCheckMs != null &&
    t256c128?.medianColdCheckMs != null
  ) {
    notes.push(
      `- 候选规模曲线（固定 256 个文件，8 -> 32 -> 128 个候选工厂）：冷检查中位数从 ${t256.medianColdCheckMs.toFixed(1)} ms 增至 ${t256c32.medianColdCheckMs.toFixed(1)} ms、${t256c128.medianColdCheckMs.toFixed(1)} ms；修复归属延迟从 ${formatMsCell(t256.medianFixOwnershipMs)} ms 变为 ${formatMsCell(t256c32.medianFixOwnershipMs)} ms、${formatMsCell(t256c128.medianFixOwnershipMs)} ms；无关编辑延迟从 ${formatMsCell(t256.medianUnrelatedEditMs)} ms 变为 ${formatMsCell(t256c32.medianUnrelatedEditMs)} ms、${formatMsCell(t256c128.medianUnrelatedEditMs)} ms。`,
    );
  }
  if (notes.length === 0) {
    notes.push("- 本次运行未包含完整五档数据，仅保留实测档位汇总。");
  }
  return notes;
}

/**
 * Formats a concise, natural Simplified Chinese Markdown report covering
 * reproduction commands, toolchain/artifact metadata, 5-tier medians, raw round
 * samples, and factual observations on both scaling curves.
 */
export function formatPerfMarkdownReport(report: PerfBaselineReport): string {
  const { environment } = report;
  const totalGib = (
    environment.totalMemoryBytes /
    (1024 * 1024 * 1024)
  ).toFixed(1);

  const medianTableRows = report.tiers.map(
    (tier) =>
      `| ${formatInt(tier.fileCount)} | ${formatInt(tier.candidateFactoryCount)} | ${formatMsCell(tier.medianColdCheckMs)} | ${formatMsCell(tier.medianFixOwnershipMs)} | ${formatMsCell(tier.medianUnrelatedEditMs)} | ${tier.status} | ${String(tier.succeededRounds)}/${String(tier.rounds.length)} | ${String(tier.totalRetries)} |`,
  );

  const rawRoundRows: string[] = [];
  for (const tier of report.tiers) {
    for (const round of tier.rounds) {
      rawRoundRows.push(
        `| ${tier.tierLabel} | ${String(round.round)} | ${round.status} | ${round.coldCheckMs === undefined ? "n/a" : round.coldCheckMs.toFixed(1)} | ${round.fixOwnershipMs === undefined ? "n/a" : round.fixOwnershipMs.toFixed(1)} | ${round.unrelatedEditMs === undefined ? "n/a" : round.unrelatedEditMs.toFixed(1)} | ${String(round.retryCount)} | ${round.failureReason ?? "-"} |`,
      );
    }
  }

  return [
    "# 五档延迟基线报告（pool-ownership）",
    "",
    "## 运行命令",
    "",
    "```bash",
    "pnpm turbo run build --filter=@verule/acceptance",
    `pnpm perf -- --scenario ${report.scenario} --tiers ${report.tiers.map((tier) => tier.tierLabel).join(",")} --samples ${String(report.samples)} --retries ${String(report.retries)}`,
    "```",
    "",
    "## 运行条件与复测信息",
    "",
    `- **执行状态**：\`${report.status}\`（总耗时 ${(report.totalDurationMs / 1000).toFixed(1)} s）`,
    `- **执行时间（UTC）**：\`${environment.timestampUtc}\``,
    `- **Git 提交**：\`${environment.gitCommit}\`${environment.gitDirty ? "（工作区存在未提交改动）" : "（工作区干净）"}`,
    `- **机器与系统**：\`${environment.platform}/${environment.arch}\`（${environment.osRelease}），CPU \`${environment.cpuModel}\` × ${String(environment.cpuCores)}，内存 ${totalGib} GiB`,
    `- **工具链版本**：Node \`${environment.nodeVersion}\`，pnpm \`${environment.pnpmVersion}\`${environment.cargoVersion === undefined ? "" : `，cargo \`${environment.cargoVersion}\``}${environment.rustcVersion === undefined ? "" : `，rustc \`${environment.rustcVersion}\``}`,
    `- **隔离与观测**：沙箱模式 \`${environment.isolationMode ?? "unknown"}\`，计时采样阶段关闭详细观测（\`--observe\` off）；生成、安装、类型检查、\`--observe detail\` 规模核验与冷查对账均在计时之外`,
    `- **采样与缓存条件**：每档串行采样 ${String(report.samples)} 轮（重试上限 ${String(report.retries)}）；制品单次打包并复用，每档独立安装宿主；\`${environment.cacheConditions.osPageCacheMode}\`（同机同进程连续串行执行，不清理操作系统页缓存，且预检已预热产物与文件页缓存）`,
    "",
    "### 本轮制品校验（SHA-256）",
    "",
    formatArtifactListMd(environment.artifacts),
    "",
    "## 五档中位数汇总",
    "",
    "| 去重文件数 | 候选工厂数 | 独立冷检查中位数 (ms) | 修复归属延迟中位数 (ms) | 无关编辑延迟中位数 (ms) | 状态 | 成功轮数 | 重试次数 |",
    "| ---: | ---: | ---: | ---: | ---: | --- | ---: | ---: |",
    ...medianTableRows,
    "",
    "## 各轮原始采样与状态",
    "",
    "| 档位 | 轮次 | 状态 | 冷检查 (ms) | 修复归属 (ms) | 无关编辑 (ms) | 重试 | 备注/失败原因 |",
    "| --- | ---: | --- | ---: | ---: | ---: | ---: | --- |",
    ...rawRoundRows,
    "",
    "## 实测观察（不设硬性毫秒门槛）",
    "",
    ...summarizeCurveObservations(report.tiers),
    "",
  ].join("\n");
}

function classifyWatchError(step: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/timed out/iu.test(message)) {
    return `${step} timed out: ${message}`;
  }
  if (/exited early/iu.test(message)) {
    return `${step} exited early: ${message}`;
  }
  return `${step} failed: ${message}`;
}

function assertSnapshotAdvanced(
  step: string,
  prev: { readonly snapshotId: number; readonly sequence: number },
  next: WatchReportRecord,
): void {
  if (next.snapshotId <= prev.snapshotId || next.sequence <= prev.sequence) {
    throw new Error(
      `Stale snapshot after ${step}: expected snapshotId>${String(prev.snapshotId)} and sequence>${String(prev.sequence)}, got snapshotId=${String(next.snapshotId)} and sequence=${String(next.sequence)}`,
    );
  }
}

async function runRoundAttempt(options: {
  readonly host: PreparedAcceptanceHost;
  readonly spec: PoolOwnershipMaterializedSpec;
  readonly round: number;
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly coldInitialRef: CheckReport;
  readonly coldFixedRef: CheckReport;
  readonly initialViolatingContent: string;
  readonly initialUnrelatedContent: string;
}): Promise<PerfRoundAttempt> {
  const attemptStart = performance.now();
  const {
    host,
    spec,
    round,
    attempt,
    timeoutMs,
    coldInitialRef,
    coldFixedRef,
    initialViolatingContent,
    initialUnrelatedContent,
  } = options;

  let coldCheckMs: number | undefined;
  let coldCheckStatus: number | undefined;
  let fixOwnershipMs: number | undefined;
  let unrelatedEditMs: number | undefined;
  let watchInitialSnapshotId: number | undefined;
  let watchFixSnapshotId: number | undefined;
  let watchRestoreSnapshotId: number | undefined;
  let watchUnrelatedSnapshotId: number | undefined;

  try {
    // 1. Timed cold check (observer off, fresh CLI + engine process)
    const fallbackStart = performance.now();
    const rawCold = await host.runCli(
      ["check", "--config", spec.configPath, "--output", "json"],
      { timeoutMs },
    );
    const fallbackDurationMs = performance.now() - fallbackStart;
    coldCheckStatus = rawCold.status;

    if (rawCold.timedOut === true) {
      throw new Error(`Cold check timed out after ${String(timeoutMs)}ms`);
    }
    if (rawCold.signal !== undefined && rawCold.signal !== null) {
      throw new Error(
        `Cold check exited early via signal ${rawCold.signal}: ${rawCold.stderr.trim() || "no stderr"}`,
      );
    }
    if (rawCold.status !== 1) {
      const detail =
        rawCold.stderr.trim() || rawCold.stdout.trim() || "no output";
      throw new Error(
        `Cold check exited early with status ${String(rawCold.status)} (expected 1): ${detail}`,
      );
    }

    coldCheckMs = roundMs(rawCold.durationMs ?? fallbackDurationMs);
    const parsedCold = parseCheckJsonResult(rawCold);
    assertPoolOwnershipInitialFindings(parsedCold.report, spec);
    assertPoolOwnershipReportsReconcile(
      parsedCold.report,
      coldInitialRef,
      `round ${String(round)} cold check`,
    );

    // 2. Watch session (initial report awaited outside edit timers)
    const watch = await host.startWatch({
      config: spec.configPath,
      timeoutMs,
    });
    let watchUnrelatedRecord: WatchReportRecord;
    let watchClosed = false;
    try {
      let watchInitial: WatchReportRecord;
      try {
        watchInitial = await watch.nextReport({ timeoutMs });
      } catch (error) {
        throw new Error(classifyWatchError("watch initial report", error), {
          cause: error,
        });
      }
      assert.equal(watchInitial.trigger, "initial");
      assertPoolOwnershipInitialFindings(watchInitial, spec);
      assertPoolOwnershipReportsReconcile(
        watchInitial,
        coldInitialRef,
        `round ${String(round)} watch initial`,
      );
      watchInitialSnapshotId = watchInitial.snapshotId;

      // 2a. Timed ownership fix
      const fixStart = performance.now();
      fixPoolOwnershipViolation(host, spec);
      let watchAfterFix: WatchReportRecord;
      try {
        watchAfterFix = await watch.nextReport({ timeoutMs });
      } catch (error) {
        throw new Error(classifyWatchError("watch fix ownership", error), {
          cause: error,
        });
      }
      fixOwnershipMs = roundMs(performance.now() - fixStart);
      assertSnapshotAdvanced("ownership fix", watchInitial, watchAfterFix);
      assert.equal(watchAfterFix.trigger, "change");
      assertPoolOwnershipClean(watchAfterFix, spec);
      assertPoolOwnershipReportsReconcile(
        watchAfterFix,
        coldFixedRef,
        `round ${String(round)} ownership fix`,
      );
      watchFixSnapshotId = watchAfterFix.snapshotId;

      // 2b. Untimed violation restoration & verification
      restorePoolOwnershipViolation(host, spec);
      let watchRestored: WatchReportRecord;
      try {
        watchRestored = await watch.nextReport({ timeoutMs });
      } catch (error) {
        throw new Error(classifyWatchError("watch restore violation", error), {
          cause: error,
        });
      }
      assertSnapshotAdvanced("restore violation", watchAfterFix, watchRestored);
      assert.equal(watchRestored.trigger, "change");
      assertPoolOwnershipInitialFindings(watchRestored, spec);
      assertPoolOwnershipReportsReconcile(
        watchRestored,
        coldInitialRef,
        `round ${String(round)} restore violation`,
      );
      watchRestoreSnapshotId = watchRestored.snapshotId;

      // 2c. Timed unrelated background edit
      const marker = `perf-round-${String(round)}-attempt-${String(attempt)}`;
      const unrelatedStart = performance.now();
      appendUnrelatedBackgroundComment(host, spec, marker);
      try {
        watchUnrelatedRecord = await watch.nextReport({ timeoutMs });
      } catch (error) {
        throw new Error(classifyWatchError("watch unrelated edit", error), {
          cause: error,
        });
      }
      unrelatedEditMs = roundMs(performance.now() - unrelatedStart);
      assertSnapshotAdvanced(
        "unrelated edit",
        watchRestored,
        watchUnrelatedRecord,
      );
      assert.equal(watchUnrelatedRecord.trigger, "change");
      assert.ok(
        watchUnrelatedRecord.recomputation.invalidatedBy.includes(
          `changed:${spec.unrelatedFile}`,
        ),
        `Expected invalidatedBy to include changed:${spec.unrelatedFile}, got ${JSON.stringify(watchUnrelatedRecord.recomputation.invalidatedBy)}`,
      );
      assert.notEqual(
        watchUnrelatedRecord.identity.snapshotDigest,
        watchRestored.identity.snapshotDigest,
        "Expected unrelated edit to advance snapshotDigest",
      );
      assertPoolOwnershipInitialFindings(watchUnrelatedRecord, spec);
      assert.deepEqual(
        watchUnrelatedRecord.diagnostics,
        coldInitialRef.diagnostics,
      );
      assert.deepEqual(watchUnrelatedRecord.gaps, coldInitialRef.gaps);
      watchUnrelatedSnapshotId = watchUnrelatedRecord.snapshotId;
      watchClosed = true;
      const watchExit = await watch.close();
      if (watchExit.code !== 0) {
        throw new Error(
          `Watch process exited with code ${String(watchExit.code)}: ${watchExit.stderr.trim()}`,
        );
      }
    } finally {
      if (!watchClosed) {
        await watch.close();
      }
    }

    // 3. Out-of-timer cold-check reconciliation for the exact post-unrelated-edit state
    const coldAfterUnrelated = await host.check({
      config: spec.configPath,
      timeoutMs,
    });
    assert.equal(coldAfterUnrelated.status, 1, coldAfterUnrelated.stderr);
    assertPoolOwnershipReportsReconcile(
      watchUnrelatedRecord,
      coldAfterUnrelated.report,
      `round ${String(round)} unrelated edit cold reconcile`,
    );

    return {
      attempt,
      status: "succeeded",
      coldCheckMs,
      fixOwnershipMs,
      unrelatedEditMs,
      coldCheckStatus,
      watchInitialSnapshotId,
      watchFixSnapshotId,
      watchRestoreSnapshotId,
      watchUnrelatedSnapshotId,
      durationMs: roundMs(performance.now() - attemptStart),
    };
  } catch (error) {
    return {
      attempt,
      status: "failed",
      ...(coldCheckMs === undefined ? {} : { coldCheckMs }),
      ...(fixOwnershipMs === undefined ? {} : { fixOwnershipMs }),
      ...(unrelatedEditMs === undefined ? {} : { unrelatedEditMs }),
      ...(coldCheckStatus === undefined ? {} : { coldCheckStatus }),
      ...(watchInitialSnapshotId === undefined
        ? {}
        : { watchInitialSnapshotId }),
      ...(watchFixSnapshotId === undefined ? {} : { watchFixSnapshotId }),
      ...(watchRestoreSnapshotId === undefined
        ? {}
        : { watchRestoreSnapshotId }),
      ...(watchUnrelatedSnapshotId === undefined
        ? {}
        : { watchUnrelatedSnapshotId }),
      failureReason: error instanceof Error ? error.message : String(error),
      durationMs: roundMs(performance.now() - attemptStart),
    };
  } finally {
    host.writeText(spec.violatingFile, initialViolatingContent);
    host.writeText(spec.unrelatedFile, initialUnrelatedContent);
  }
}

async function defaultPoolOwnershipTierExecutor(context: {
  readonly tier: PoolOwnershipScaleSpec;
  readonly samples: number;
  readonly retries: number;
  readonly timeoutMs: number;
  readonly bundle: PackedArtifactBundle;
}): Promise<PerfTierExecutionOutcome> {
  const tierStart = performance.now();
  const { tier, samples, retries, timeoutMs, bundle } = context;

  return withPoolOwnershipHost(
    { scale: tier, bundle },
    async (host, spec): Promise<PerfTierExecutionOutcome> => {
      const coldReconcileStates: string[] = [];
      let typecheckMs: number | undefined;
      let scaleAuditMs: number | undefined;
      let observedFileCount: number | undefined;
      let observedCandidateCount: number | undefined;
      let seedCheckpointCount: number | undefined;
      let judgmentCheckpointCount: number | undefined;
      let isolationMode: string | undefined;

      const initialViolatingContent = host.readText(spec.violatingFile);
      const initialUnrelatedContent = host.readText(spec.unrelatedFile);

      let coldInitialRef: CheckReport;
      let coldFixedRef: CheckReport;

      try {
        const typecheckStart = performance.now();
        await runTscTypecheck(host.appDir, "tsconfig.json");
        typecheckMs = roundMs(performance.now() - typecheckStart);

        const auditStart = performance.now();
        const audit = await verifyPoolOwnershipScaleAndCandidates(host, spec, {
          timeoutMs,
        });
        scaleAuditMs = roundMs(performance.now() - auditStart);
        observedFileCount = audit.fileCount;
        observedCandidateCount = audit.candidateCallCount;
        seedCheckpointCount = audit.seedCheckpointCount;
        judgmentCheckpointCount = audit.judgmentCheckpointCount;
        assertPoolOwnershipInitialFindings(audit.report, spec);

        // Cold-check reconciliation for initial, fixed, restored, and unrelated states
        const coldInitial = await host.check({
          config: spec.configPath,
          timeoutMs,
        });
        assert.equal(coldInitial.status, 1, coldInitial.stderr);
        assertPoolOwnershipInitialFindings(coldInitial.report, spec);
        isolationMode = coldInitial.isolation?.mode;
        coldInitialRef = coldInitial.report;
        coldReconcileStates.push("initial");

        fixPoolOwnershipViolation(host, spec);
        await runTscTypecheck(host.appDir, "tsconfig.json");
        const coldFixed = await host.check({
          config: spec.configPath,
          timeoutMs,
        });
        assert.equal(coldFixed.status, 0, coldFixed.stderr);
        assertPoolOwnershipClean(coldFixed.report, spec);
        coldFixedRef = coldFixed.report;
        coldReconcileStates.push("fixed");

        restorePoolOwnershipViolation(host, spec);
        const coldRestored = await host.check({
          config: spec.configPath,
          timeoutMs,
        });
        assert.equal(coldRestored.status, 1, coldRestored.stderr);
        assertPoolOwnershipReportsReconcile(
          coldRestored.report,
          coldInitialRef,
          "preflight restored",
        );
        coldReconcileStates.push("restored");

        appendUnrelatedBackgroundComment(
          host,
          spec,
          "preflight-unrelated-comment",
        );
        const coldUnrelated = await host.check({
          config: spec.configPath,
          timeoutMs,
        });
        assert.equal(coldUnrelated.status, 1, coldUnrelated.stderr);
        assertPoolOwnershipInitialFindings(coldUnrelated.report, spec);
        assert.notEqual(
          coldUnrelated.report.identity.snapshotDigest,
          coldInitialRef.identity.snapshotDigest,
          "Expected unrelated preflight comment to advance snapshotDigest",
        );
        assert.deepEqual(
          coldUnrelated.report.diagnostics,
          coldInitialRef.diagnostics,
        );
        assert.deepEqual(coldUnrelated.report.gaps, coldInitialRef.gaps);
        coldReconcileStates.push("unrelated");
      } catch (error) {
        const failureReason =
          error instanceof Error ? error.message : String(error);
        const notRunRounds: PerfRoundResult[] = Array.from(
          { length: samples },
          (_, index) => ({
            round: index + 1,
            status: "not_run",
            retryCount: 0,
            attempts: [],
            failureReason: `Preflight verification failed: ${failureReason}`,
          }),
        );
        return {
          preflight: {
            status: "failed",
            ...(typecheckMs === undefined ? {} : { typecheckMs }),
            ...(scaleAuditMs === undefined ? {} : { scaleAuditMs }),
            ...(observedFileCount === undefined ? {} : { observedFileCount }),
            ...(observedCandidateCount === undefined
              ? {}
              : { observedCandidateCount }),
            ...(seedCheckpointCount === undefined
              ? {}
              : { seedCheckpointCount }),
            ...(judgmentCheckpointCount === undefined
              ? {}
              : { judgmentCheckpointCount }),
            coldReconcileStates,
            failureReason,
          },
          rounds: notRunRounds,
          ...(isolationMode === undefined ? {} : { isolationMode }),
          failureReason,
          durationMs: roundMs(performance.now() - tierStart),
        };
      } finally {
        host.writeText(spec.violatingFile, initialViolatingContent);
        host.writeText(spec.unrelatedFile, initialUnrelatedContent);
      }

      const preflight: PerfTierPreflight = {
        status: "succeeded",
        typecheckMs,
        scaleAuditMs,
        observedFileCount,
        observedCandidateCount,
        seedCheckpointCount,
        judgmentCheckpointCount,
        coldReconcileStates,
      };

      const rounds: PerfRoundResult[] = [];
      for (let round = 1; round <= samples; round += 1) {
        const attempts: PerfRoundAttempt[] = [];
        for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
          const outcome = await runRoundAttempt({
            host,
            spec,
            round,
            attempt,
            timeoutMs,
            coldInitialRef,
            coldFixedRef,
            initialViolatingContent,
            initialUnrelatedContent,
          });
          attempts.push(outcome);
          if (outcome.status === "succeeded") {
            break;
          }
        }

        const lastAttempt = attempts[attempts.length - 1]!;
        if (lastAttempt.status === "succeeded") {
          rounds.push({
            round,
            status: "succeeded",
            coldCheckMs: lastAttempt.coldCheckMs!,
            fixOwnershipMs: lastAttempt.fixOwnershipMs!,
            unrelatedEditMs: lastAttempt.unrelatedEditMs!,
            retryCount: attempts.length - 1,
            attempts,
          });
        } else {
          rounds.push({
            round,
            status: "failed",
            retryCount: attempts.length - 1,
            attempts,
            failureReason:
              lastAttempt.failureReason ?? "Round failed without details",
          });
        }
      }

      return {
        preflight,
        rounds,
        ...(isolationMode === undefined ? {} : { isolationMode }),
        durationMs: roundMs(performance.now() - tierStart),
      };
    },
  );
}

function summarizeTierResult(
  tier: PoolOwnershipScaleSpec,
  outcome: PerfTierExecutionOutcome,
): PerfTierResult {
  const succeeded = outcome.rounds.filter((r) => r.status === "succeeded");
  const failed = outcome.rounds.filter((r) => r.status === "failed");
  const notRun = outcome.rounds.filter((r) => r.status === "not_run");
  const totalRetries = outcome.rounds.reduce(
    (sum, round) => sum + round.retryCount,
    0,
  );

  const coldSamples = succeeded.map((r) => r.coldCheckMs!);
  const fixSamples = succeeded.map((r) => r.fixOwnershipMs!);
  const unrelatedSamples = succeeded.map((r) => r.unrelatedEditMs!);

  let status: PerfExecutionStatus;
  let failureReason = outcome.failureReason;
  if (outcome.preflight.status === "not_run") {
    status = "not_run";
  } else if (
    outcome.preflight.status === "failed" ||
    failed.length > 0 ||
    notRun.length > 0
  ) {
    status = "failed";
    if (failureReason === undefined) {
      failureReason =
        failed[0]?.failureReason ??
        notRun[0]?.failureReason ??
        "One or more sampling rounds failed";
    }
  } else {
    status = "succeeded";
  }

  const rawMedianCold = computeMedian(coldSamples);
  const rawMedianFix = computeMedian(fixSamples);
  const rawMedianUnrelated = computeMedian(unrelatedSamples);

  return {
    tierLabel: formatTierLabel(tier),
    fileCount: tier.fileCount,
    candidateFactoryCount: tier.candidateFactoryCount,
    status,
    preflight: outcome.preflight,
    rounds: outcome.rounds,
    succeededRounds: succeeded.length,
    failedRounds: failed.length,
    notRunRounds: notRun.length,
    totalRetries,
    medianColdCheckMs: rawMedianCold === null ? null : roundMs(rawMedianCold),
    medianFixOwnershipMs: rawMedianFix === null ? null : roundMs(rawMedianFix),
    medianUnrelatedEditMs:
      rawMedianUnrelated === null ? null : roundMs(rawMedianUnrelated),
    coldCheckSamplesMs: coldSamples,
    fixOwnershipSamplesMs: fixSamples,
    unrelatedEditSamplesMs: unrelatedSamples,
    ...(failureReason === undefined ? {} : { failureReason }),
    durationMs: outcome.durationMs,
  };
}

function buildUnattemptedTierResult(
  tier: PoolOwnershipScaleSpec,
  samples: number,
  reason: string,
  preflightStatus: "not_run" | "failed",
): PerfTierResult {
  const rounds: PerfRoundResult[] = Array.from(
    { length: samples },
    (_, index) => ({
      round: index + 1,
      status: "not_run",
      retryCount: 0,
      attempts: [],
      failureReason: reason,
    }),
  );
  return summarizeTierResult(tier, {
    preflight: {
      status: preflightStatus,
      coldReconcileStates: [],
      failureReason: reason,
    },
    rounds,
    failureReason: reason,
    durationMs: 0,
  });
}

function tryCommandOutput(
  command: string,
  args: readonly string[],
  cwd: string,
): string | undefined {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    return undefined;
  }
}

function collectEnvironmentMetadata(options: {
  readonly workspaceRoot: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly isolationMode?: string;
}): PerfEnvironmentMetadata {
  const cpus = os.cpus();
  const gitCommit =
    tryCommandOutput("git", ["rev-parse", "HEAD"], options.workspaceRoot) ??
    "unknown";
  const gitStatus =
    tryCommandOutput("git", ["status", "--porcelain"], options.workspaceRoot) ??
    "";
  const pnpmVersion =
    tryCommandOutput("pnpm", ["--version"], options.workspaceRoot) ?? "unknown";
  const cargoVersion = tryCommandOutput(
    "cargo",
    ["--version"],
    options.workspaceRoot,
  );
  const rustcVersion = tryCommandOutput(
    "rustc",
    ["--version"],
    options.workspaceRoot,
  );

  return {
    timestampUtc: new Date().toISOString(),
    gitCommit,
    gitDirty: gitStatus.length > 0,
    platform: process.platform,
    osRelease: os.release(),
    arch: process.arch,
    cpuModel: cpus[0]?.model ?? "unknown",
    cpuCores: cpus.length,
    totalMemoryBytes: os.totalmem(),
    nodeVersion: process.version,
    pnpmVersion,
    ...(cargoVersion === undefined ? {} : { cargoVersion }),
    ...(rustcVersion === undefined ? {} : { rustcVersion }),
    ...(options.isolationMode === undefined
      ? {}
      : { isolationMode: options.isolationMode }),
    artifacts: options.artifacts.map((artifact) => ({
      name: artifact.name,
      version: artifact.version,
      sha256: artifact.sha256,
      integrity: artifact.integrity,
      size: artifact.size,
      ...(artifact.binarySha256 === undefined
        ? {}
        : { binarySha256: artifact.binarySha256 }),
    })),
    cacheConditions: {
      artifactsPackedOnce: true,
      perTierIsolatedHostInstall: true,
      osPageCacheMode: "warm-in-process",
      observerInTimedRounds: "off",
    },
  };
}

/**
 * Runs the serial five-tier (or custom-tier) pool-ownership latency baseline
 * using a single packed workspace artifact bundle across all tiers.
 */
export async function runPoolOwnershipPerfBaseline(
  options: RunPoolOwnershipPerfOptions = {},
): Promise<PerfBaselineReport> {
  const totalStart = performance.now();
  const scenario = options.scenario ?? "pool-ownership";
  if (scenario !== "pool-ownership") {
    throw new Error(`Unsupported scenario: ${String(scenario)}`);
  }

  const tiers = deduplicateTiers(options.tiers ?? POOL_OWNERSHIP_TIERS);
  if (tiers.length === 0) {
    throw new Error("Expected at least one scale tier");
  }
  const samples = options.samples ?? 5;
  const retries = options.retries ?? 0;
  const timeoutMs = options.timeoutMs ?? defaultOperationTimeoutMs;
  const workspaceRoot = options.workspaceRoot ?? process.cwd();
  const executeTier = options.executeTier ?? defaultPoolOwnershipTierExecutor;
  const log = options.logProgress;

  const ownsBundle = options.bundle === undefined;
  let bundle: PackedArtifactBundle | undefined = options.bundle;
  let packErrorMessage: string | undefined;

  if (bundle === undefined) {
    log?.("Packing workspace artifacts once...");
    try {
      bundle = await packWorkspaceArtifacts({
        additionalPackages: poolOwnershipAdditionalPackages,
        cwd: workspaceRoot,
      });
    } catch (error) {
      packErrorMessage = `Artifact packing failed: ${error instanceof Error ? error.message : String(error)}`;
    }
  }

  const tierResults: PerfTierResult[] = [];
  let observedIsolationMode: string | undefined;
  let abortReason = packErrorMessage;

  try {
    for (const tier of tiers) {
      const label = formatTierLabel(tier);
      if (abortReason !== undefined || bundle === undefined) {
        tierResults.push(
          buildUnattemptedTierResult(
            tier,
            samples,
            abortReason ?? "Artifact bundle unavailable",
            "not_run",
          ),
        );
        continue;
      }

      log?.(
        `Running tier ${label} (${String(samples)} samples, retries=${String(retries)})...`,
      );
      try {
        const outcome = await executeTier({
          tier,
          samples,
          retries,
          timeoutMs,
          bundle,
        });
        if (
          observedIsolationMode === undefined &&
          outcome.isolationMode !== undefined
        ) {
          observedIsolationMode = outcome.isolationMode;
        }
        const summarized = summarizeTierResult(tier, outcome);
        tierResults.push(summarized);
        log?.(
          `Finished tier ${label}: status=${summarized.status} cold=${formatMsCell(summarized.medianColdCheckMs)}ms fix=${formatMsCell(summarized.medianFixOwnershipMs)}ms unrelated=${formatMsCell(summarized.medianUnrelatedEditMs)}ms`,
        );
        if (outcome.abortRemainingTiers === true) {
          abortReason =
            outcome.failureReason ??
            `Aborted remaining tiers after unrecoverable error in ${label}`;
        }
      } catch (error) {
        const message = `Unrecoverable setup error in tier ${label}: ${error instanceof Error ? error.message : String(error)}`;
        tierResults.push(
          buildUnattemptedTierResult(tier, samples, message, "failed"),
        );
        abortReason = message;
      }
    }
  } finally {
    if (ownsBundle && bundle !== undefined) {
      bundle.dispose();
    }
  }

  const allSucceeded = tierResults.every((tier) => tier.status === "succeeded");
  const environment = collectEnvironmentMetadata({
    workspaceRoot,
    artifacts: bundle?.artifacts ?? [],
    ...(observedIsolationMode === undefined
      ? {}
      : { isolationMode: observedIsolationMode }),
  });

  return {
    scenario,
    status: allSucceeded ? "succeeded" : "failed",
    samples,
    retries,
    command: `pnpm perf -- --scenario ${scenario} --tiers ${tiers.map((tier) => formatTierLabel(tier)).join(",")} --samples ${String(samples)} --retries ${String(retries)}`,
    environment,
    tiers: tierResults,
    totalDurationMs: roundMs(performance.now() - totalStart),
  };
}

/** Writes text to `outputPath`, creating parent directories as needed. */
export function writeReportFile(outputPath: string, content: string): string {
  const resolved = resolve(outputPath);
  mkdirSync(dirname(resolved), { recursive: true });
  writeFileSync(resolved, content, "utf8");
  return resolved;
}
