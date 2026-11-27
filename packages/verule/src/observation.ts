import { isAbsolute, relative } from "node:path";
import { performance } from "node:perf_hooks";

import {
  locationMatchesTarget,
  locationsOverlap,
  normalizeObserveConfig as normalizeEngineObserveConfig,
  type DiagnosticLocation,
  type EngineCallIoMetrics,
  type EngineIrCacheMetrics,
  type EngineLoweringMetrics,
  type EngineSummaryLookupMetrics,
  type ExplainCleanupPath,
  type Gap,
  type NormalizedObserveConfig,
  type ObserveLimit,
  type ObserveLimitInput,
  type ObserveMode,
  type ObserveOptions,
  type ProjectSummary,
  type SourceTarget,
} from "tssae";

import {
  toVeruleError,
  VeruleExecutionError,
  type CheckpointOutcome,
  type Diagnostic,
  type ExplainCheckpointTrace,
  type ExplainQueryStep,
  type ExplainResult,
  type ExplainStatus,
  type ObservationDetailEntry,
  type ObservationReport,
} from "./types.ts";

export { type EngineCallIoMetrics, type NormalizedObserveConfig };

export type QueryTraceRecord = {
  readonly ruleId: string;
  readonly queryIndex: number;
  readonly op: string;
  readonly projectId: string;
  readonly provider: string;
  readonly providers?: readonly string[];
  readonly cacheStatus: "computed" | "reused";
  readonly candidateCount: number;
  readonly matchedTarget: boolean;
  readonly durationMs: number;
  readonly summary: string;
  readonly detail?: unknown;
};

export type CheckpointTraceRecord = {
  readonly ruleId: string;
  readonly projectId: string;
  readonly name: string;
  readonly outcome: CheckpointOutcome;
  readonly at?: DiagnosticLocation;
  readonly detail?: unknown;
};

function normalizeSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function normalizeRelativeFile(file: string, cwd: string): string {
  const normalized = normalizeSlashes(file).trim();
  const normCwd = normalizeSlashes(cwd);
  let rel = normalized;
  if (isAbsolute(normalized) || /^[A-Za-z]:\//u.test(normalized)) {
    rel = normalizeSlashes(relative(normCwd, normalized));
  }
  while (rel.startsWith("./")) {
    rel = rel.slice(2);
  }
  return rel;
}

function parsePositiveInt(raw: string, label: string, input: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid ${label} in target "${input}": expected positive integer.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid ${label} in target "${input}": must be >= 1.`,
    );
  }
  return value;
}

/** Parses `<file[:line[:column]]>` into a normalized `SourceTarget` relative to `cwd`. */
export function parseTargetSpec(input: string, cwd: string): SourceTarget {
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "Target location (--at) cannot be empty.",
    );
  }

  let filePart = trimmed;
  let line: number | undefined;
  let column: number | undefined;

  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 1) {
    const tail = trimmed.slice(lastColon + 1);
    const prefix = trimmed.slice(0, lastColon);
    if (/^\d+$/u.test(tail)) {
      const secondLastColon = prefix.lastIndexOf(":");
      if (secondLastColon > 1) {
        const mid = prefix.slice(secondLastColon + 1);
        if (/^\d+$/u.test(mid)) {
          filePart = prefix.slice(0, secondLastColon);
          line = parsePositiveInt(mid, "line", input);
          column = parsePositiveInt(tail, "column", input);
        } else {
          filePart = prefix;
          line = parsePositiveInt(tail, "line", input);
        }
      } else {
        filePart = prefix;
        line = parsePositiveInt(tail, "line", input);
      }
    } else if (tail === "" || !tail.includes("/")) {
      // Allow Windows drive letters like C:\foo only when colon is at index 1; otherwise reject non-numeric suffix.
      if (lastColon > 1) {
        throw new VeruleExecutionError(
          "INVALID_CONFIG",
          `Invalid target location "${input}": expected <file[:line[:column]]>.`,
        );
      }
    }
  } else if (lastColon === 0) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid target location "${input}": missing file path.`,
    );
  }

  const normalizedFile = normalizeRelativeFile(filePart, cwd);
  if (normalizedFile === "" || normalizedFile === ".") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid target location "${input}": missing file path.`,
    );
  }

  return {
    file: normalizedFile,
    ...(line !== undefined ? { line } : {}),
    ...(column !== undefined ? { column } : {}),
  };
}

/** Normalizes a string or `SourceTarget` relative to `cwd`. */
export function normalizeTargetSpec(
  target: string | SourceTarget,
  cwd: string,
): SourceTarget {
  if (typeof target === "string") {
    return parseTargetSpec(target, cwd);
  }
  const file = normalizeRelativeFile(target.file, cwd);
  if (file === "" || file === ".") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "Target location file cannot be empty.",
    );
  }
  if (
    target.line !== undefined &&
    (!Number.isInteger(target.line) || target.line < 1)
  ) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid target line ${String(target.line)}: must be >= 1.`,
    );
  }
  if (
    target.column !== undefined &&
    (!Number.isInteger(target.column) || target.column < 1)
  ) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid target column ${String(target.column)}: must be >= 1.`,
    );
  }
  return {
    file,
    ...(target.line !== undefined ? { line: target.line } : {}),
    ...(target.column !== undefined ? { column: target.column } : {}),
  };
}

function parseNonNegativeInt(raw: string, source: string): number {
  if (!/^\d+$/u.test(raw)) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid observe limit "${source}": expected a non-negative integer.`,
    );
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Invalid observe limit "${source}" ${String(value)}: must be a non-negative integer.`,
    );
  }
  return value;
}

/** Parses `--observe-limit` strings (e.g. `20`, `4096b`, `4kb`, `10items`) or SDK limit objects. */
export function parseObserveLimit(
  input: string | ObserveLimitInput,
): ObserveLimit {
  if (typeof input !== "string") {
    try {
      return (
        normalizeEngineObserveConfig({ mode: "off", limit: input }).limit ?? {}
      );
    } catch (err) {
      throw toVeruleError(err, "INVALID_CONFIG");
    }
  }

  const normalized = input.trim().toLowerCase();
  if (normalized === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "Observe limit cannot be empty.",
    );
  }
  if (normalized.startsWith("bytes:")) {
    return {
      maxBytes: parseNonNegativeInt(normalized.slice("bytes:".length), input),
    };
  }
  if (normalized.startsWith("items:")) {
    return {
      maxItems: parseNonNegativeInt(normalized.slice("items:".length), input),
    };
  }
  if (normalized.endsWith("kb")) {
    const kb = parseNonNegativeInt(normalized.slice(0, -2), input);
    return { maxBytes: kb * 1024 };
  }
  if (normalized.endsWith("b")) {
    return { maxBytes: parseNonNegativeInt(normalized.slice(0, -1), input) };
  }
  if (normalized.endsWith("items")) {
    return { maxItems: parseNonNegativeInt(normalized.slice(0, -5), input) };
  }
  return { maxItems: parseNonNegativeInt(normalized, input) };
}

/** Normalizes Verule `observe` and `observeLimit` inputs into validated `tssae` observe options. */
export function normalizeObserveConfig(
  observe: ObserveMode | ObserveOptions | undefined,
  observeLimit: ObserveLimitInput | undefined,
): NormalizedObserveConfig {
  const mode: ObserveMode =
    observe === undefined
      ? "off"
      : typeof observe === "string"
        ? observe
        : observe.mode;
  const rawLimit =
    typeof observe === "object" && observe.limit !== undefined
      ? observe.limit
      : observeLimit;
  const limit =
    typeof rawLimit === "string" ? parseObserveLimit(rawLimit) : rawLimit;
  try {
    return normalizeEngineObserveConfig({
      mode,
      ...(limit !== undefined ? { limit } : {}),
    });
  } catch (err) {
    throw toVeruleError(err, "INVALID_CONFIG");
  }
}

/** Collects observation metrics, bounded detail entries, and explain traces for a check run. */
export class ObservationCollector {
  readonly mode: ObserveMode;
  readonly limit: ObserveLimit | undefined;
  readonly explainTarget: SourceTarget | undefined;
  readonly #startedAt: number;
  #configAndOpenMs: number;
  #engineQueryMs = 0;
  #ruleExecutionMs = 0;
  #rpcBatches = 0;
  #queryBatches = 0;
  #bytesSent = 0;
  #bytesReceived = 0;
  #checkpointMs = 0;
  #encodeMs = 0;
  #writeMs = 0;
  #queryCount = 0;
  #computedQueryCount = 0;
  #reusedQueryCount = 0;
  #candidateCount = 0;
  #checkpointCount = 0;
  #truncated = false;
  #droppedCount = 0;
  #usedDetailBytes = 0;
  readonly #lowering: {
    functionsLowered: number;
    verticesCreated: number;
    durationMs: number;
  } = { functionsLowered: 0, verticesCreated: 0, durationMs: 0 };
  readonly #irCache: {
    functionHits: number;
    functionMisses: number;
    filesReused: number;
    filesInvalidated: number;
  } = {
    functionHits: 0,
    functionMisses: 0,
    filesReused: 0,
    filesInvalidated: 0,
  };
  readonly #summaryLookup: {
    lookups: number;
    hits: number;
    misses: number;
    hitsBySource: {
      local: number;
      package: number;
      community: number;
      builtin: number;
    };
  } = {
    lookups: 0,
    hits: 0,
    misses: 0,
    hitsBySource: { local: 0, package: 0, community: 0, builtin: 0 },
  };
  readonly #providers = new Set<string>();
  readonly #details: ObservationDetailEntry[] = [];
  readonly #queriesByRule = new Map<string, QueryTraceRecord[]>();
  readonly #checkpointsByRule = new Map<string, CheckpointTraceRecord[]>();
  readonly #matchingCandidatesByRule = new Map<string, DiagnosticLocation[]>();
  readonly #cleanupPathsByRule = new Map<
    string,
    {
      readonly targetLocations: readonly DiagnosticLocation[];
      readonly path: ExplainCleanupPath;
    }[]
  >();
  readonly #gapsByRule = new Map<
    string,
    { readonly gap: Gap; readonly relatedLocation?: DiagnosticLocation }[]
  >();

  constructor(options: {
    readonly mode: ObserveMode;
    readonly limit?: ObserveLimit;
    readonly explainTarget?: SourceTarget;
    readonly configAndOpenMs?: number;
  }) {
    this.mode = options.mode;
    this.limit = options.limit;
    this.explainTarget = options.explainTarget;
    this.#configAndOpenMs = options.configAndOpenMs ?? 0;
    this.#startedAt = this.isObserveEnabled() ? performance.now() : 0;
  }

  isObserveEnabled(): boolean {
    return this.mode !== "off";
  }

  isExplainEnabled(): boolean {
    return this.explainTarget !== undefined;
  }

  isActive(): boolean {
    return this.isObserveEnabled() || this.isExplainEnabled();
  }

  addConfigAndOpenMs(ms: number): void {
    if (this.isObserveEnabled()) {
      this.#configAndOpenMs += ms;
    }
  }

  addEngineQueryMs(ms: number): void {
    if (this.isObserveEnabled()) {
      this.#engineQueryMs += ms;
    }
  }

  addRuleExecutionMs(ms: number): void {
    if (this.isObserveEnabled()) {
      this.#ruleExecutionMs += ms;
    }
  }

  recordRpcCall(io: EngineCallIoMetrics): void {
    if (!this.isObserveEnabled()) {
      return;
    }
    this.#rpcBatches += 1;
    if (io.isQueryBatch) {
      this.#queryBatches += 1;
    }
    this.#bytesSent += io.bytesSent;
    this.#bytesReceived += io.bytesReceived;
    this.#encodeMs += io.encodeMs;
    this.#writeMs += io.writeMs;

    const engineMetrics = io.engineMetrics;
    if (!engineMetrics) {
      return;
    }
    this.#encodeMs += engineMetrics.encodeMs;
    if (engineMetrics.steps) {
      for (const step of engineMetrics.steps) {
        this.#providers.add(step.provider);
        if (this.mode === "detail" && step.details) {
          for (const item of step.details) {
            this.#appendDetail({
              kind: "engineStep",
              provider: step.provider,
              durationMs: step.durationMs,
              summary: item.summary,
              ...(item.file !== undefined &&
              item.line !== undefined &&
              item.column !== undefined
                ? {
                    detail: {
                      file: item.file,
                      line: item.line,
                      column: item.column,
                      kind: item.kind,
                    },
                  }
                : {}),
            });
          }
        }
      }
    }
    if (engineMetrics.lowering) {
      this.#lowering.functionsLowered +=
        engineMetrics.lowering.functionsLowered;
      this.#lowering.verticesCreated += engineMetrics.lowering.verticesCreated;
      this.#lowering.durationMs += engineMetrics.lowering.durationMs;
    }
    if (engineMetrics.irCache) {
      this.#irCache.functionHits += engineMetrics.irCache.functionHits;
      this.#irCache.functionMisses += engineMetrics.irCache.functionMisses;
      this.#irCache.filesReused += engineMetrics.irCache.filesReused;
      this.#irCache.filesInvalidated += engineMetrics.irCache.filesInvalidated;
    }
    if (engineMetrics.summaryLookup) {
      this.#summaryLookup.lookups += engineMetrics.summaryLookup.lookups;
      this.#summaryLookup.hits += engineMetrics.summaryLookup.hits;
      this.#summaryLookup.misses += engineMetrics.summaryLookup.misses;
      this.#summaryLookup.hitsBySource.local +=
        engineMetrics.summaryLookup.hitsBySource.local;
      this.#summaryLookup.hitsBySource.package +=
        engineMetrics.summaryLookup.hitsBySource.package;
      this.#summaryLookup.hitsBySource.community +=
        engineMetrics.summaryLookup.hitsBySource.community;
      this.#summaryLookup.hitsBySource.builtin +=
        engineMetrics.summaryLookup.hitsBySource.builtin;
    }
    if (engineMetrics.truncated) {
      this.#truncated = true;
    }
    if (engineMetrics.droppedCount > 0) {
      this.#droppedCount += engineMetrics.droppedCount;
    }
  }

  recordQuery(params: {
    readonly ruleId: string;
    readonly op: string;
    readonly projectId: string;
    readonly provider: string;
    readonly providers?: readonly string[];
    readonly cacheStatus: "computed" | "reused";
    readonly candidateCount: number;
    readonly durationMs: number;
    readonly summary: string;
    readonly matchedLocations?: readonly DiagnosticLocation[];
    readonly detail?: unknown;
  }): void {
    if (!this.isActive()) {
      return;
    }

    if (this.isObserveEnabled()) {
      this.#queryCount += 1;
      if (params.cacheStatus === "computed") {
        this.#computedQueryCount += 1;
      } else {
        this.#reusedQueryCount += 1;
      }
      this.#candidateCount += params.candidateCount;
      const providersToAdd = params.providers ?? [params.provider];
      for (const providerId of providersToAdd) {
        this.#providers.add(providerId);
      }

      if (this.mode === "detail") {
        this.#appendDetail({
          kind: "query",
          ruleId: params.ruleId,
          projectId: params.projectId,
          provider: params.provider,
          name: params.op,
          cacheStatus: params.cacheStatus,
          candidateCount: params.candidateCount,
          durationMs: params.durationMs,
          summary: params.summary,
          ...(params.detail !== undefined ? { detail: params.detail } : {}),
        });
      }
    }

    if (this.isExplainEnabled()) {
      const ruleQueries = this.#queriesByRule.get(params.ruleId) ?? [];
      const matchedTarget = (params.matchedLocations?.length ?? 0) > 0;
      ruleQueries.push({
        ruleId: params.ruleId,
        queryIndex: ruleQueries.length + 1,
        op: params.op,
        projectId: params.projectId,
        provider: params.provider,
        ...(params.providers !== undefined
          ? { providers: params.providers }
          : {}),
        cacheStatus: params.cacheStatus,
        candidateCount: params.candidateCount,
        matchedTarget,
        durationMs: params.durationMs,
        summary: params.summary,
        ...(params.detail !== undefined ? { detail: params.detail } : {}),
      });
      this.#queriesByRule.set(params.ruleId, ruleQueries);

      if (params.matchedLocations && params.matchedLocations.length > 0) {
        const list = this.#matchingCandidatesByRule.get(params.ruleId) ?? [];
        for (const loc of params.matchedLocations) {
          list.push(loc);
        }
        this.#matchingCandidatesByRule.set(params.ruleId, list);
      }
    }
  }

  recordCheckpoint(params: {
    readonly ruleId: string;
    readonly projectId: string;
    readonly name: string;
    readonly outcome: CheckpointOutcome;
    readonly resolveLocation: () => DiagnosticLocation | undefined;
    readonly detailFn?: () => unknown;
  }): void {
    if (!this.isActive()) {
      return;
    }

    const start = performance.now();
    if (this.isObserveEnabled()) {
      this.#checkpointCount += 1;
    }

    const at = params.resolveLocation();
    const matchesExplain =
      this.explainTarget !== undefined &&
      at !== undefined &&
      (locationMatchesTarget(at, this.explainTarget) ||
        this.hasMatchingCandidateOverlapping(params.ruleId, at));

    const shouldEvalForDetail =
      this.mode === "detail" && !this.#isItemLimitReached();
    const shouldEvalForExplain = this.isExplainEnabled() && matchesExplain;

    let evaluatedDetail: unknown;
    let hasEvaluatedDetail = false;
    if (params.detailFn && (shouldEvalForDetail || shouldEvalForExplain)) {
      evaluatedDetail = params.detailFn();
      hasEvaluatedDetail = true;
    }

    if (this.mode === "detail") {
      this.#appendDetail({
        kind: "checkpoint",
        ruleId: params.ruleId,
        projectId: params.projectId,
        name: params.name,
        outcome: params.outcome,
        ...(at !== undefined ? { at } : {}),
        summary: `${params.name}: ${params.outcome}`,
        ...(hasEvaluatedDetail ? { detail: evaluatedDetail } : {}),
      });
    }

    if (this.isExplainEnabled()) {
      const list = this.#checkpointsByRule.get(params.ruleId) ?? [];
      list.push({
        ruleId: params.ruleId,
        projectId: params.projectId,
        name: params.name,
        outcome: params.outcome,
        ...(at !== undefined ? { at } : {}),
        ...(hasEvaluatedDetail ? { detail: evaluatedDetail } : {}),
      });
      this.#checkpointsByRule.set(params.ruleId, list);
    }

    if (this.isObserveEnabled()) {
      this.#checkpointMs += performance.now() - start;
    }
  }

  hasMatchingCandidateOverlapping(
    ruleId: string,
    loc: DiagnosticLocation,
  ): boolean {
    const candidates = this.#matchingCandidatesByRule.get(ruleId);
    if (!candidates) return false;
    return candidates.some((candidate) => locationsOverlap(candidate, loc));
  }

  recordCleanupPaths(params: {
    readonly ruleId: string;
    readonly targetLocations: readonly DiagnosticLocation[];
    readonly paths: readonly ExplainCleanupPath[];
  }): void {
    if (!this.isExplainEnabled()) {
      return;
    }
    const list = this.#cleanupPathsByRule.get(params.ruleId) ?? [];
    for (const path of params.paths) {
      list.push({
        targetLocations: params.targetLocations,
        path,
      });
    }
    this.#cleanupPathsByRule.set(params.ruleId, list);
  }

  recordRuleGaps(
    ruleId: string,
    gaps: readonly Gap[],
    relatedLocation?: DiagnosticLocation,
  ): void {
    if (!this.isExplainEnabled() || gaps.length === 0) {
      return;
    }
    const list = this.#gapsByRule.get(ruleId) ?? [];
    for (const gap of gaps) {
      list.push({
        gap,
        ...(relatedLocation !== undefined ? { relatedLocation } : {}),
      });
    }
    this.#gapsByRule.set(ruleId, list);
  }

  #isItemLimitReached(): boolean {
    return (
      this.#truncated ||
      (this.limit?.maxItems !== undefined &&
        this.#details.length >= this.limit.maxItems)
    );
  }

  #appendDetail(entry: ObservationDetailEntry): void {
    if (this.#isItemLimitReached()) {
      this.#truncated = true;
      this.#droppedCount += 1;
      return;
    }

    const encodeStart = performance.now();
    const encoded = JSON.stringify(entry);
    const entryBytes = Buffer.byteLength(encoded, "utf8");
    this.#encodeMs += performance.now() - encodeStart;

    if (
      this.limit?.maxBytes !== undefined &&
      this.#usedDetailBytes + entryBytes > this.limit.maxBytes
    ) {
      this.#truncated = true;
      this.#droppedCount += 1;
      return;
    }

    this.#usedDetailBytes += entryBytes;
    this.#details.push(entry);
  }

  buildObservationReport(): ObservationReport | undefined {
    if (!this.isObserveEnabled()) {
      return undefined;
    }
    const mode = this.mode === "detail" ? "detail" : "summary";
    const totalMs = Math.max(0, performance.now() - this.#startedAt);
    const lowering: EngineLoweringMetrics = {
      functionsLowered: this.#lowering.functionsLowered,
      verticesCreated: this.#lowering.verticesCreated,
      durationMs: roundMs(this.#lowering.durationMs),
    };
    const irCache: EngineIrCacheMetrics = { ...this.#irCache };
    const summaryLookup: EngineSummaryLookupMetrics = {
      lookups: this.#summaryLookup.lookups,
      hits: this.#summaryLookup.hits,
      misses: this.#summaryLookup.misses,
      hitsBySource: { ...this.#summaryLookup.hitsBySource },
    };
    return {
      mode,
      phases: {
        configAndOpenMs: roundMs(this.#configAndOpenMs),
        engineQueryMs: roundMs(this.#engineQueryMs),
        ruleExecutionMs: roundMs(this.#ruleExecutionMs),
        totalMs: roundMs(totalMs),
      },
      rpc: {
        batches: this.#rpcBatches,
        queryBatches: this.#queryBatches,
        bytesSent: this.#bytesSent,
        bytesReceived: this.#bytesReceived,
      },
      overhead: {
        checkpointMs: roundMs(this.#checkpointMs),
        encodeMs: roundMs(this.#encodeMs),
        writeMs: roundMs(this.#writeMs),
      },
      queryCount: this.#queryCount,
      computedQueryCount: this.#computedQueryCount,
      reusedQueryCount: this.#reusedQueryCount,
      candidateCount: this.#candidateCount,
      checkpointCount: this.#checkpointCount,
      providers: [...this.#providers].toSorted(),
      lowering,
      irCache,
      summaryLookup,
      ...(this.limit !== undefined ? { limit: this.limit } : {}),
      truncated: this.#truncated,
      droppedCount: this.#droppedCount,
      ...(mode === "detail" ? { details: [...this.#details] } : {}),
    };
  }

  buildExplainResult(params: {
    readonly ruleId: string;
    readonly projects: readonly ProjectSummary[];
    readonly diagnostics: readonly Diagnostic[];
    readonly suppressions?: readonly {
      readonly ruleId: string;
      readonly at: DiagnosticLocation;
      readonly directiveAt: DiagnosticLocation;
      readonly reason: string;
    }[];
  }): ExplainResult {
    const target = this.explainTarget;
    if (!target) {
      throw new VeruleExecutionError(
        "ENGINE_ERROR",
        "Cannot build explanation without a target location.",
      );
    }

    const queries = this.#queriesByRule.get(params.ruleId) ?? [];
    const checkpoints = this.#checkpointsByRule.get(params.ruleId) ?? [];
    const matchingCandidates =
      this.#matchingCandidatesByRule.get(params.ruleId) ?? [];
    const hasTargetCheckpoint = checkpoints.some(
      (cp) => cp.at !== undefined && locationMatchesTarget(cp.at, target),
    );
    const inCandidates = matchingCandidates.length > 0 || hasTargetCheckpoint;

    const relevantCheckpoints: ExplainCheckpointTrace[] = checkpoints
      .filter(
        (cp) =>
          cp.at !== undefined &&
          (locationMatchesTarget(cp.at, target) ||
            matchingCandidates.some((cand) => locationsOverlap(cand, cp.at!))),
      )
      .map((cp) => ({
        name: cp.name,
        ruleId: cp.ruleId,
        projectId: cp.projectId,
        outcome: cp.outcome,
        ...(cp.at !== undefined ? { at: cp.at } : {}),
        ...(cp.detail !== undefined ? { detail: cp.detail } : {}),
      }));

    const querySteps: ExplainQueryStep[] = queries.map((q) => ({
      queryIndex: q.queryIndex,
      op: q.op,
      projectId: q.projectId,
      provider: q.provider,
      cacheStatus: q.cacheStatus,
      candidateCount: q.candidateCount,
      matchedTarget: q.matchedTarget,
      durationMs: roundMs(q.durationMs),
      summary: q.summary,
      ...(q.detail !== undefined ? { detail: q.detail } : {}),
    }));

    const providers = [
      ...new Set(queries.flatMap((q) => q.providers ?? [q.provider])),
    ].toSorted();
    const projectsChecked = params.projects.map((p) => p.projectId);

    const matchingDiagnostic = params.diagnostics.find(
      (diag) =>
        diag.ruleId === params.ruleId && locationMatchesTarget(diag.at, target),
    );
    const matchingSuppression = params.suppressions?.find(
      (sup) =>
        sup.ruleId === params.ruleId && locationMatchesTarget(sup.at, target),
    );
    const targetInAnyProject = params.projects.some((project) =>
      project.sourceFiles.includes(target.file),
    );

    const excludedCheckpoint =
      relevantCheckpoints.find(
        (cp) =>
          cp.outcome === "exclude" &&
          cp.at !== undefined &&
          locationMatchesTarget(cp.at, target),
      ) ?? relevantCheckpoints.find((cp) => cp.outcome === "exclude");
    const firstNonMatchingFindSyntax = querySteps.find(
      (step) => step.op === "findSyntax" && !step.matchedTarget,
    );
    const lastMatchingQuery = [...querySteps]
      .reverse()
      .find((step) => step.matchedTarget);

    let status: ExplainStatus;
    let summary: string;
    let excludedByQuery: ExplainQueryStep | undefined;
    let excludedByCheckpoint: ExplainCheckpointTrace | undefined;
    let inlineIgnore:
      | {
          readonly matched: boolean;
          readonly ruleId?: string;
          readonly reason?: string;
          readonly commentAt?: DiagnosticLocation;
        }
      | undefined;

    const matchingCleanupEntries = (
      this.#cleanupPathsByRule.get(params.ruleId) ?? []
    ).filter((entry) =>
      entry.targetLocations.some(
        (loc) =>
          locationMatchesTarget(loc, target) ||
          matchingCandidates.some((cand) => locationsOverlap(cand, loc)),
      ),
    );
    const cleanupPaths: ExplainCleanupPath[] = [];
    const seenCleanupKeys = new Set<string>();
    for (const entry of matchingCleanupEntries) {
      const key = `${entry.path.instanceKey}:${entry.path.scopeLocation.file}:${entry.path.scopeLocation.start}`;
      if (!seenCleanupKeys.has(key)) {
        seenCleanupKeys.add(key);
        cleanupPaths.push(entry.path);
      }
    }

    const matchesLoc = (loc: DiagnosticLocation | undefined): boolean =>
      loc !== undefined &&
      (locationMatchesTarget(loc, target) ||
        matchingCandidates.some((cand) => locationsOverlap(cand, loc)));

    const relevantGaps: Gap[] = [];
    const seenGapKeys = new Set<string>();
    const pushGap = (gap: Gap): void => {
      const key = JSON.stringify([
        gap.kind,
        gap.message,
        gap.at?.file ?? null,
        gap.at?.start ?? null,
        gap.at?.end ?? null,
      ]);
      if (!seenGapKeys.has(key)) {
        seenGapKeys.add(key);
        relevantGaps.push(gap);
      }
    };
    for (const entry of this.#gapsByRule.get(params.ruleId) ?? []) {
      if (
        matchesLoc(entry.gap.at) ||
        matchesLoc(entry.relatedLocation) ||
        (entry.gap.at === undefined && inCandidates)
      ) {
        pushGap(entry.gap);
      }
    }

    if (matchingDiagnostic) {
      status = "reported";
      summary = `Rule "${params.ruleId}" reported a diagnostic at ${formatTarget(target)}.`;
    } else if (matchingSuppression) {
      status = "suppressed_by_ignore";
      inlineIgnore = {
        matched: true,
        ruleId: matchingSuppression.ruleId,
        reason: matchingSuppression.reason,
        commentAt: matchingSuppression.directiveAt,
      };
      summary = `Diagnostic for rule "${params.ruleId}" at ${formatTarget(target)} was suppressed by verule-ignore-next-code-line at ${matchingSuppression.directiveAt.file}:${matchingSuppression.directiveAt.line}:${matchingSuppression.directiveAt.column} (reason: ${matchingSuppression.reason}).`;
    } else if (!targetInAnyProject) {
      status = "target_not_in_project";
      summary = `Target "${target.file}" is not part of any opened compiler project.`;
    } else if (cleanupPaths.length > 0) {
      status = "covered_by_cleanup";
      summary = `Target is covered by valid cleanup path(s) (${cleanupPaths.map((cp) => cp.instanceKey).join(", ")}).`;
    } else if (excludedCheckpoint) {
      status = "excluded_by_checkpoint";
      excludedByCheckpoint = excludedCheckpoint;
      summary = `Target entered candidates and was excluded at checkpoint "${excludedCheckpoint.name}".`;
    } else if (relevantGaps.length > 0) {
      status = "blocked_by_gap";
      excludedByQuery = lastMatchingQuery ?? querySteps[0];
      summary = `Target conclusion was blocked by ${relevantGaps.length} active gap(s) (${relevantGaps.map((g) => g.kind).join(", ")}).`;
    } else if (!inCandidates) {
      status = "not_in_candidates";
      excludedByQuery = firstNonMatchingFindSyntax ?? querySteps[0];
      summary = excludedByQuery
        ? `Target did not enter candidates in ${excludedByQuery.op} (${excludedByQuery.candidateCount} candidates, ${excludedByQuery.cacheStatus}).`
        : `Target did not enter any candidate set for rule "${params.ruleId}".`;
    } else {
      status = "rule_filtered";
      excludedByQuery = lastMatchingQuery;
      summary = `Target entered ${matchingCandidates.length} candidate(s) and rule "${params.ruleId}" did not report a diagnostic.`;
    }

    return {
      ruleId: params.ruleId,
      target,
      status,
      inCandidates,
      summary,
      projectsChecked,
      matchingCandidates,
      ...(excludedByQuery !== undefined ? { excludedByQuery } : {}),
      ...(excludedByCheckpoint !== undefined ? { excludedByCheckpoint } : {}),
      ...(inlineIgnore !== undefined ? { inlineIgnore } : {}),
      queries: querySteps,
      checkpoints: relevantCheckpoints,
      gaps: relevantGaps,
      providers,
      cleanupPaths,
    };
  }
}

function formatTarget(target: SourceTarget): string {
  if (target.line === undefined) return target.file;
  if (target.column === undefined) return `${target.file}:${target.line}`;
  return `${target.file}:${target.line}:${target.column}`;
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}
