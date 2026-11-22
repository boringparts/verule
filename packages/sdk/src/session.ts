import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { EngineClient, type RpcRequestOptions } from "./engine-client.ts";
import {
  ObservationCollector,
  locationMatchesTarget,
  normalizeObserveConfig,
  normalizeTargetSpec,
  type EngineCallIoMetrics,
} from "./observation.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  getRefSessionToken,
  makeProgramRef,
  type AnalysisSession,
  type CheckReport,
  type CheckpointOutcome,
  type CheckpointTarget,
  type Diagnostic,
  type DiagnosticInput,
  type DiagnosticLocation,
  type Evidence,
  type ExplainOptions,
  type ExplainReport,
  type FindSyntaxOptions,
  type MemoryStats,
  type Model,
  type ModelIdentitySummary,
  type NormalizedVeruleConfig,
  type OpenSessionOptions,
  type ProjectSummary,
  type RecomputationScope,
  type ReportIdentity,
  type Rule,
  type RuleContext,
  type RuleIdentitySummary,
  type RunCheckOptions,
  type SessionCheckOptions,
  type SessionUpdateOptions,
  type SyntaxKind,
  type SyntaxNodeResult,
  type SyntaxRef,
  type TypeAtResult,
  type VeruleConfig,
} from "./types.ts";

type EngineOpenResult = {
  readonly snapshotId: number;
  readonly snapshotDigest: string;
  readonly projects: readonly ProjectSummary[];
  readonly engineRssBytes?: number;
};

type EngineUpdateResult = EngineOpenResult & {
  readonly recomputedProjects: readonly string[];
  readonly reusedProjects: readonly string[];
  readonly recomputedFiles: readonly string[];
  readonly reusedFiles: readonly string[];
  readonly removedFiles: readonly string[];
};

type EngineSyntaxItem = {
  readonly ref: string;
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly location: DiagnosticLocation;
  readonly expression?: string;
  readonly arguments?: readonly string[];
  readonly name?: string;
  readonly initializer?: string;
};

type EngineTypeItem = {
  readonly target: string;
  readonly typeRef: string;
  readonly typeText: string;
  readonly isUnion: boolean;
  readonly isIntersection: boolean;
  readonly isLiteral: boolean;
  readonly literalValue?: string | number | boolean;
  readonly unionMembers?: readonly string[];
};

type EngineBatchResult = {
  readonly results: readonly {
    readonly items: readonly unknown[];
  }[];
};

type CollectedDiagnostic = {
  readonly ruleId: string;
  readonly projectId: string;
  readonly at: DiagnosticLocation;
  readonly message: string;
  readonly findingKey?: string;
  readonly evidence: readonly Evidence[];
};

function validateRules(rules: readonly Rule[]): readonly Rule[] {
  const seen = new Set<string>();
  for (const rule of rules) {
    if (typeof rule.id !== "string" || rule.id.trim() === "") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        "Each rule must have a non-empty string id.",
      );
    }
    if (seen.has(rule.id)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Duplicate rule id: "${rule.id}".`,
      );
    }
    if (typeof rule.run !== "function") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Rule "${rule.id}" must provide a run function.`,
      );
    }
    seen.add(rule.id);
  }
  return [...rules];
}

function validateModels(models: readonly Model[]): readonly Model[] {
  const seen = new Set<string>();
  for (const model of models) {
    if (typeof model.id !== "string" || model.id.trim() === "") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        "Each model must have a non-empty string id.",
      );
    }
    if (model.version !== undefined && typeof model.version !== "string") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Model "${model.id}" version must be a string when provided.`,
      );
    }
    if (seen.has(model.id)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Duplicate model id: "${model.id}".`,
      );
    }
    seen.add(model.id);
  }
  return [...models];
}

/** Validates a project model definition. */
export function defineModel(model: Model): Model {
  if (typeof model.id !== "string" || model.id.trim() === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "Model id must be a non-empty string.",
    );
  }
  if (model.version !== undefined && typeof model.version !== "string") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Model "${model.id}" version must be a string when provided.`,
    );
  }
  return model;
}

function selectRules(
  baseRules: readonly Rule[],
  ruleIds?: readonly string[],
): readonly Rule[] {
  if (!ruleIds || ruleIds.length === 0) {
    return baseRules;
  }
  const byId = new Map(baseRules.map((rule) => [rule.id, rule]));
  const selected: Rule[] = [];
  const seen = new Set<string>();
  for (const id of ruleIds) {
    const found = byId.get(id);
    if (!found) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Unknown rule id "${id}".`,
      );
    }
    if (!seen.has(id)) {
      seen.add(id);
      selected.push(found);
    }
  }
  return selected;
}

/** Validates and normalizes a rule definition. */
export function defineRule(rule: Rule): Rule {
  if (typeof rule.id !== "string" || rule.id.trim() === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "Rule id must be a non-empty string.",
    );
  }
  if (typeof rule.run !== "function") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Rule "${rule.id}" must provide a run function.`,
    );
  }
  return rule;
}

/** Validates and normalizes a Verule project configuration, defaulting to zero rules. */
export function defineConfig(config: VeruleConfig): NormalizedVeruleConfig {
  if (config.tsconfig !== undefined && config.projects !== undefined) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      'Specify either "tsconfig" or "projects", not both.',
    );
  }
  if (config.projects !== undefined && config.projects.length === 0) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      '"projects" must contain at least one tsconfig path when specified.',
    );
  }
  const rules = validateRules(config.rules ?? []);
  const models = validateModels(config.models ?? []);
  return {
    ...(config.tsconfig !== undefined ? { tsconfig: config.tsconfig } : {}),
    ...(config.projects !== undefined
      ? { projects: [...config.projects] }
      : {}),
    rules,
    models,
  };
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted();
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

function sha256Prefix(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

function summarizeRule(rule: Rule): RuleIdentitySummary {
  return {
    id: rule.id,
    digest: sha256Prefix(
      stableSerialize({
        id: rule.id,
        description: rule.description ?? null,
        run: rule.run.toString(),
      }),
    ),
  };
}

function summarizeModel(model: Model): ModelIdentitySummary {
  return {
    id: model.id,
    ...(model.version !== undefined ? { version: model.version } : {}),
    digest: sha256Prefix(
      stableSerialize({
        id: model.id,
        version: model.version ?? null,
        description: model.description ?? null,
        facts: model.facts ?? null,
      }),
    ),
  };
}

function computeReportIdentity(
  snapshotDigest: string,
  entries: readonly string[],
  rules: readonly Rule[],
  models: readonly Model[],
): ReportIdentity {
  const ruleSummaries = rules.map(summarizeRule);
  const modelSummaries = models.map(summarizeModel);
  const configDigest = sha256Prefix(
    stableSerialize({
      entries,
      rules: ruleSummaries,
      models: modelSummaries,
    }),
  );
  return {
    snapshotDigest,
    configDigest,
    rules: ruleSummaries,
    models: modelSummaries,
  };
}

function resolveEntries(config: VeruleConfig | undefined): readonly string[] {
  if (!config) {
    return ["tsconfig.json"];
  }
  if (config.projects !== undefined) {
    if (config.projects.length === 0) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        '"projects" must contain at least one tsconfig path when specified.',
      );
    }
    return config.projects;
  }
  if (config.tsconfig !== undefined) {
    return [config.tsconfig];
  }
  return ["tsconfig.json"];
}

function toSyntaxNodeResult(
  item: EngineSyntaxItem,
  sessionToken: symbol,
  projectId: string,
  snapshotId: number,
  syntaxLocations: WeakMap<SyntaxRef, DiagnosticLocation>,
): SyntaxNodeResult {
  const ref = makeProgramRef(
    "syntax",
    sessionToken,
    projectId,
    snapshotId,
    item.ref,
  );
  syntaxLocations.set(ref, item.location);

  return {
    ref,
    kind: item.kind,
    text: item.text,
    location: item.location,
    ...(item.expression !== undefined
      ? {
          expression: makeProgramRef(
            "syntax",
            sessionToken,
            projectId,
            snapshotId,
            item.expression,
          ),
        }
      : {}),
    ...(item.arguments !== undefined
      ? {
          arguments: item.arguments.map((argId) =>
            makeProgramRef(
              "syntax",
              sessionToken,
              projectId,
              snapshotId,
              argId,
            ),
          ),
        }
      : {}),
    ...(item.name !== undefined
      ? {
          name: makeProgramRef(
            "syntax",
            sessionToken,
            projectId,
            snapshotId,
            item.name,
          ),
        }
      : {}),
    ...(item.initializer !== undefined
      ? {
          initializer: makeProgramRef(
            "syntax",
            sessionToken,
            projectId,
            snapshotId,
            item.initializer,
          ),
        }
      : {}),
  };
}

function toTypeAtResult(
  item: EngineTypeItem,
  target: SyntaxRef,
  sessionToken: symbol,
  projectId: string,
  snapshotId: number,
): TypeAtResult {
  return {
    target,
    ref: makeProgramRef(
      "type",
      sessionToken,
      projectId,
      snapshotId,
      item.typeRef,
    ),
    typeText: item.typeText,
    isUnion: item.isUnion,
    isIntersection: item.isIntersection,
    isLiteral: item.isLiteral,
    ...(item.literalValue !== undefined
      ? { literalValue: item.literalValue }
      : {}),
    ...(item.unionMembers !== undefined
      ? { unionMembers: item.unionMembers }
      : {}),
  };
}

function resolveCheckpointLocation(
  target: CheckpointTarget,
  syntaxLocations: WeakMap<SyntaxRef, DiagnosticLocation>,
): DiagnosticLocation | undefined {
  if ("location" in target) {
    return target.location;
  }
  if ("file" in target && "line" in target && "start" in target) {
    return target;
  }
  return syntaxLocations.get(target);
}

function canonicalLocationKey(loc: DiagnosticLocation): string {
  return `${loc.file}:${loc.start}:${loc.end}:${loc.line}:${loc.column}:${loc.endLine}:${loc.endColumn}`;
}

function canonicalEvidenceKey(evidence: readonly Evidence[]): string {
  return JSON.stringify(
    evidence.map((item) => ({
      kind: item.kind,
      message: item.message,
      ...(item.at !== undefined ? { at: canonicalLocationKey(item.at) } : {}),
    })),
  );
}

function compareLocations(
  a: DiagnosticLocation,
  b: DiagnosticLocation,
): number {
  const fileCmp = a.file.localeCompare(b.file);
  if (fileCmp !== 0) return fileCmp;
  if (a.start !== b.start) return a.start - b.start;
  if (a.end !== b.end) return a.end - b.end;
  if (a.line !== b.line) return a.line - b.line;
  return a.column - b.column;
}

function buildDiagnostics(
  collected: readonly CollectedDiagnostic[],
): readonly Diagnostic[] {
  const sorted = collected.toSorted((a, b) => {
    const locCmp = compareLocations(a.at, b.at);
    if (locCmp !== 0) return locCmp;
    const ruleCmp = a.ruleId.localeCompare(b.ruleId);
    if (ruleCmp !== 0) return ruleCmp;
    return a.message.localeCompare(b.message);
  });

  type MergedEntry = {
    readonly ruleId: string;
    readonly at: DiagnosticLocation;
    readonly message: string;
    readonly findingKey?: string;
    readonly evidence: readonly Evidence[];
    readonly projects: string[];
  };

  const mergedMap = new Map<string, MergedEntry>();
  const mergedList: MergedEntry[] = [];

  for (const item of sorted) {
    const mergeKey = JSON.stringify([
      item.ruleId,
      canonicalLocationKey(item.at),
      item.message,
      canonicalEvidenceKey(item.evidence),
    ]);
    const existing = mergedMap.get(mergeKey);
    if (existing) {
      if (!existing.projects.includes(item.projectId)) {
        existing.projects.push(item.projectId);
      }
    } else {
      const entry: MergedEntry = {
        ruleId: item.ruleId,
        at: item.at,
        message: item.message,
        ...(item.findingKey !== undefined
          ? { findingKey: item.findingKey }
          : {}),
        evidence: item.evidence,
        projects: [item.projectId],
      };
      mergedMap.set(mergeKey, entry);
      mergedList.push(entry);
    }
  }

  const occurrenceCounts = new Map<string, number>();
  return mergedList.map((entry) => {
    const anchorKey = entry.findingKey ?? entry.message;
    const sigKey = JSON.stringify([entry.ruleId, entry.at.file, anchorKey]);
    const occurrence = occurrenceCounts.get(sigKey) ?? 0;
    occurrenceCounts.set(sigKey, occurrence + 1);

    const id = createHash("sha256")
      .update(
        JSON.stringify([
          entry.ruleId,
          entry.at.file,
          anchorKey,
          `${entry.at.start}:${entry.at.end}`,
          occurrence,
        ]),
      )
      .digest("hex")
      .slice(0, 16);

    return {
      id,
      ruleId: entry.ruleId,
      at: entry.at,
      message: entry.message,
      evidence: entry.evidence,
      projects: entry.projects,
    };
  });
}

<<<<<<< HEAD
function resolveNextConfig(
  current: NormalizedVeruleConfig,
  options?: SessionUpdateOptions,
): NormalizedVeruleConfig {
  if (options?.config !== undefined) {
    return defineConfig(options.config);
  }
  const rules = options?.rules ? validateRules(options.rules) : current.rules;
  const models = options?.models
    ? validateModels(options.models)
    : current.models;
  if (options?.entries !== undefined) {
    if (options.entries.length === 0) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        '"entries" must contain at least one tsconfig path when specified.',
      );
    }
    return {
      projects: [...options.entries],
      rules,
      models,
    };
  }
  return {
    ...(current.tsconfig !== undefined ? { tsconfig: current.tsconfig } : {}),
    ...(current.projects !== undefined ? { projects: current.projects } : {}),
    rules,
    models,
  };
}

function collectInvalidatedBy(
  prevConfig: NormalizedVeruleConfig,
  nextConfig: NormalizedVeruleConfig,
  options?: SessionUpdateOptions,
): readonly string[] {
  const reasons: string[] = [];
  for (const file of options?.changed ?? []) reasons.push(`changed:${file}`);
  for (const file of options?.created ?? []) reasons.push(`created:${file}`);
  for (const file of options?.deleted ?? []) reasons.push(`deleted:${file}`);

  const prevIdentity = computeReportIdentity(
    "",
    resolveEntries(prevConfig),
    prevConfig.rules,
    prevConfig.models,
  );
  const nextIdentity = computeReportIdentity(
    "",
    resolveEntries(nextConfig),
    nextConfig.rules,
    nextConfig.models,
  );
  if (
    stableSerialize(resolveEntries(prevConfig)) !==
    stableSerialize(resolveEntries(nextConfig))
  ) {
    reasons.push("entries");
  }
  if (
    stableSerialize(prevIdentity.rules) !== stableSerialize(nextIdentity.rules)
  ) {
    reasons.push("rules");
  }
  if (
    stableSerialize(prevIdentity.models) !==
    stableSerialize(nextIdentity.models)
  ) {
    reasons.push("models");
  }
  if (options?.config !== undefined && reasons.length === 0) {
    reasons.push("config");
  }
  return reasons;
}

function readMemoryStats(engineRssBytes?: number): MemoryStats {
  return {
    hostRssBytes: process.memoryUsage().rss,
    ...(engineRssBytes !== undefined ? { engineRssBytes } : {}),
  };
}

function isSessionCheckOptions(
  value: readonly Rule[] | SessionCheckOptions | undefined,
): value is SessionCheckOptions {
  return value !== undefined && !Array.isArray(value);
}

/**
 * Opens an analysis session backed by a single engine subprocess and project snapshot.
 *
 * Call `session.close()` when finished to release the snapshot and terminate the engine process.
 */
export async function openSession(
  options: OpenSessionOptions,
): Promise<AnalysisSession> {
  let normalizedConfig = options.config
    ? defineConfig(options.config)
    : defineConfig({});
  const initialEntries = resolveEntries(normalizedConfig);
  const absCwd = resolve(options.cwd);
  const sessionObserve = normalizeObserveConfig(
    options.observe,
    options.observeLimit,
  );

  const client = new EngineClient();
  let openIoMetrics: EngineCallIoMetrics | undefined;
  const openStart = performance.now();
  let openResult: EngineOpenResult;
  try {
    const openRpcOptions: RpcRequestOptions | undefined =
      sessionObserve.mode !== "off"
        ? {
            observe: {
              mode: sessionObserve.mode,
              ...(sessionObserve.limit?.maxItems !== undefined
                ? { maxItems: sessionObserve.limit.maxItems }
                : {}),
              ...(sessionObserve.limit?.maxBytes !== undefined
                ? { maxBytes: sessionObserve.limit.maxBytes }
                : {}),
            },
            onMetrics: (io) => {
              openIoMetrics = io;
            },
          }
        : undefined;
    openResult = await client.request<EngineOpenResult>(
      "snapshot.open",
      {
        cwd: absCwd,
        entries: initialEntries,
      },
      openRpcOptions,
    );
  } catch (err) {
    await client.close();
    throw err;
  }
  const openDurationMs = performance.now() - openStart;

  const sessionToken = Symbol("verule-session");
  let currentSnapshotId = openResult.snapshotId;
  let currentSnapshotDigest = openResult.snapshotDigest;
  let currentProjects = openResult.projects;
  let lastEngineRssBytes = openResult.engineRssBytes;
  let closed = false;
  let pendingOpenIoMetrics = openIoMetrics;
  let pendingOpenDurationMs = openDurationMs;
  let pendingConfigLoadMs = options.configLoadMs ?? 0;

  const syntaxCache = new Map<string, Promise<readonly SyntaxNodeResult[]>>();
  const typeCache = new Map<string, Promise<TypeAtResult>>();
  const syntaxLocations = new WeakMap<SyntaxRef, DiagnosticLocation>();

  function assertOpen(): void {
    if (closed) {
      throw new VeruleExecutionError(
        "SESSION_CLOSED",
        "Analysis session is already closed.",
      );
    }
  }

  function buildRpcOptions(
    collector: ObservationCollector,
  ): RpcRequestOptions | undefined {
    if (!collector.isObserveEnabled()) {
      return undefined;
    }
    return {
      observe: {
        mode: collector.mode,
        ...(collector.limit?.maxItems !== undefined
          ? { maxItems: collector.limit.maxItems }
          : {}),
        ...(collector.limit?.maxBytes !== undefined
          ? { maxBytes: collector.limit.maxBytes }
          : {}),
      },
      onMetrics: (io) => {
        collector.recordRpcCall(io);
      },
    };
  }

  function createRuleContext(
    ruleId: string,
    project: ProjectSummary,
    models: readonly Model[],
    collected: CollectedDiagnostic[],
    collector: ObservationCollector,
    recordRuleEngineMs: (ms: number) => void,
  ): RuleContext {
    const activeSnapshotId = currentSnapshotId;
    return {
      project,
      models,
      getModel: (id: string) => models.find((model) => model.id === id),
      findSyntax: async (query: FindSyntaxOptions) => {
        assertOpen();
        const cacheKey = JSON.stringify([
          activeSnapshotId,
          project.projectId,
          query.kinds.toSorted(),
          query.files ? query.files.toSorted() : null,
        ]);
        const cached = syntaxCache.get(cacheKey);
        const queryStart = collector.isActive() ? performance.now() : 0;

        let items: readonly SyntaxNodeResult[];
        let cacheStatus: "computed" | "reused";
        if (cached) {
          cacheStatus = "reused";
          items = await cached;
        } else {
          cacheStatus = "computed";
          const promise = client
            .request<EngineBatchResult>(
              "query.batch",
              {
                snapshotId: activeSnapshotId,
                projectId: project.projectId,
                steps: [
                  {
                    op: "findSyntax",
                    kinds: query.kinds,
                    ...(query.files !== undefined
                      ? { files: query.files }
                      : {}),
                  },
                ],
              },
              buildRpcOptions(collector),
            )
            .then((batch) => {
              const rawItems = (batch.results[0]?.items ??
                []) as readonly EngineSyntaxItem[];
              return rawItems.map((item) =>
                toSyntaxNodeResult(
                  item,
                  sessionToken,
                  project.projectId,
                  activeSnapshotId,
                  syntaxLocations,
                ),
              );
            });

          syntaxCache.set(cacheKey, promise);
          items = await promise;
        }

        if (collector.isActive()) {
          const durationMs = performance.now() - queryStart;
          if (cacheStatus === "computed") {
            collector.addEngineQueryMs(durationMs);
            recordRuleEngineMs(durationMs);
          }
          const matchedLocations = collector.explainTarget
            ? items
                .filter((item) =>
                  locationMatchesTarget(
                    item.location,
                    collector.explainTarget!,
                  ),
                )
                .map((item) => item.location)
            : undefined;
          collector.recordQuery({
            ruleId,
            op: "findSyntax",
            projectId: project.projectId,
            provider: "engine",
            cacheStatus,
            candidateCount: items.length,
            durationMs,
            summary: `findSyntax(${query.kinds.join(", ")}) -> ${items.length} candidate(s)`,
            ...(matchedLocations !== undefined ? { matchedLocations } : {}),
            ...(collector.mode === "detail" || collector.isExplainEnabled()
              ? {
                  detail: {
                    kinds: query.kinds,
                    ...(query.files !== undefined
                      ? { files: query.files }
                      : {}),
                  },
                }
              : {}),
          });
        }

        return items;
      },
      typeAt: async (targets: readonly SyntaxRef[]) => {
        assertOpen();
        if (targets.length === 0) return [];

        for (const target of targets) {
          if (
            getRefSessionToken(target) !== sessionToken ||
            target.snapshotId !== currentSnapshotId
          ) {
            throw new VeruleExecutionError(
              "STALE_REFERENCE",
              `Program reference "${target.handleId}" belongs to a closed or stale snapshot.`,
            );
          }
          if (target.projectId !== project.projectId) {
            throw new VeruleExecutionError(
              "CROSS_PROJECT_REFERENCE",
              `Program reference "${target.handleId}" belongs to project "${target.projectId}", not "${project.projectId}".`,
            );
          }
        }

        const missingTargets: SyntaxRef[] = [];
        for (const target of targets) {
          const key = `${activeSnapshotId}:${project.projectId}:${target.handleId}`;
          if (!typeCache.has(key)) {
            missingTargets.push(target);
          }
        }

        const queryStart = collector.isActive() ? performance.now() : 0;
        const cacheStatus: "computed" | "reused" =
          missingTargets.length > 0 ? "computed" : "reused";

        if (missingTargets.length > 0) {
          const batchPromise = client.request<EngineBatchResult>(
            "query.batch",
            {
              snapshotId: activeSnapshotId,
              projectId: project.projectId,
              steps: [
                {
                  op: "typeAtLocation",
                  targets: missingTargets.map((target) => target.handleId),
                },
              ],
            },
            buildRpcOptions(collector),
          );

          for (const [index, target] of missingTargets.entries()) {
            const key = `${activeSnapshotId}:${project.projectId}:${target.handleId}`;
            const itemPromise = batchPromise.then((batch) => {
              const items = (batch.results[0]?.items ??
                []) as readonly EngineTypeItem[];
              const raw = items[index];
              if (!raw) {
                throw new VeruleExecutionError(
                  "ENGINE_ERROR",
                  `Engine omitted type result for target "${target.handleId}".`,
                );
              }
              return toTypeAtResult(
                raw,
                target,
                sessionToken,
                project.projectId,
                activeSnapshotId,
              );
            });
            typeCache.set(key, itemPromise);
          }
        }

        const results = await Promise.all(
          targets.map((target) =>
            typeCache.get(
              `${activeSnapshotId}:${project.projectId}:${target.handleId}`,
            )!,
          ),
        );

        if (collector.isActive()) {
          const durationMs = performance.now() - queryStart;
          if (cacheStatus === "computed") {
            collector.addEngineQueryMs(durationMs);
            recordRuleEngineMs(durationMs);
          }
          const matchedLocations: DiagnosticLocation[] = [];
          const matchedTypeTexts: string[] = [];
          if (collector.explainTarget) {
            for (const item of results) {
              const loc = syntaxLocations.get(item.target);
              if (
                loc &&
                (locationMatchesTarget(loc, collector.explainTarget) ||
                  collector.hasMatchingCandidateOverlapping(ruleId, loc))
              ) {
                matchedLocations.push(loc);
                matchedTypeTexts.push(item.typeText);
              }
            }
          }
          collector.recordQuery({
            ruleId,
            op: "typeAtLocation",
            projectId: project.projectId,
            provider: "engine",
            cacheStatus,
            candidateCount: results.length,
            durationMs,
            summary: `typeAtLocation(${targets.length} target(s))`,
            ...(collector.explainTarget !== undefined
              ? { matchedLocations }
              : {}),
            ...(matchedTypeTexts.length > 0
              ? { detail: { matchedTypes: matchedTypeTexts } }
              : {}),
          });
        }

        return results;
      },
      report: (input: DiagnosticInput) => {
        assertOpen();
        collected.push({
          ruleId,
          projectId: project.projectId,
          at: input.at,
          message: input.message,
          ...(input.findingKey !== undefined
            ? { findingKey: input.findingKey }
            : {}),
          evidence: input.evidence ?? [],
        });
      },
      checkpoint: (
        name: string,
        target: CheckpointTarget,
        outcome: CheckpointOutcome,
        detail?: () => unknown,
      ) => {
        if (!collector.isActive()) {
          return;
        }
        collector.recordCheckpoint({
          ruleId,
          projectId: project.projectId,
          name,
          outcome,
          resolveLocation: () =>
            resolveCheckpointLocation(target, syntaxLocations),
          ...(detail !== undefined ? { detailFn: detail } : {}),
        });
      },
    };
  }

  async function executeCheckRun(
    runOptions?: SessionCheckOptions,
  ): Promise<CheckReport> {
    assertOpen();
    const baseRules = runOptions?.rulesOverride
      ? validateRules(runOptions.rulesOverride)
      : normalizedConfig.rules;
    const rules = selectRules(baseRules, runOptions?.ruleIds);

    const explainTarget =
      runOptions?.at !== undefined
        ? normalizeTargetSpec(runOptions.at, absCwd)
        : undefined;
    if (explainTarget !== undefined && rules.length === 0) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        "At least one rule must be configured or selected via ruleIds to explain a target location.",
      );
    }

    const effectiveObserve =
      runOptions?.observe !== undefined ||
      runOptions?.observeLimit !== undefined
        ? normalizeObserveConfig(
            runOptions.observe ?? sessionObserve.mode,
            runOptions.observeLimit ?? sessionObserve.limit,
          )
        : sessionObserve;

    const configLoadMs = runOptions?.configLoadMs ?? pendingConfigLoadMs;
    pendingConfigLoadMs = 0;
    const openMs = pendingOpenDurationMs;
    pendingOpenDurationMs = 0;

    const collector = new ObservationCollector({
      mode: effectiveObserve.mode,
      ...(effectiveObserve.limit !== undefined
        ? { limit: effectiveObserve.limit }
        : {}),
      ...(explainTarget !== undefined ? { explainTarget } : {}),
      configAndOpenMs: configLoadMs + openMs,
    });

    if (pendingOpenIoMetrics) {
      collector.recordRpcCall(pendingOpenIoMetrics);
      pendingOpenIoMetrics = undefined;
    }

    const collected: CollectedDiagnostic[] = [];
    for (const project of currentProjects) {
      for (const rule of rules) {
        let ruleEngineMs = 0;
        const ruleStart = collector.isObserveEnabled() ? performance.now() : 0;
        const ctx = createRuleContext(
          rule.id,
          project,
          normalizedConfig.models,
          collected,
          collector,
          (ms) => {
            ruleEngineMs += ms;
          },
        );
        try {
          await rule.run(ctx);
        } catch (err) {
          if (err instanceof VeruleExecutionError) {
            throw err;
          }
          const detail = err instanceof Error ? err.message : String(err);
          throw new VeruleExecutionError(
            "RULE_EXECUTION_ERROR",
            `Rule "${rule.id}" failed: ${detail}`,
            { cause: err },
          );
        } finally {
          if (collector.isObserveEnabled()) {
            const ruleElapsed = performance.now() - ruleStart;
            collector.addRuleExecutionMs(
              Math.max(0, ruleElapsed - ruleEngineMs),
            );
          }
        }
      }
    }

    const diagnostics = buildDiagnostics(collected);
    const observation = collector.buildObservationReport();
    const explanations = explainTarget
      ? rules.map((rule) =>
          collector.buildExplainResult({
            ruleId: rule.id,
            projects: currentProjects,
            diagnostics,
          }),
        )
      : undefined;

    return {
      reportVersion: REPORT_SCHEMA_VERSION,
      status: diagnostics.length > 0 ? "findings" : "clean",
      projects: currentProjects,
      diagnostics,
      gaps: [],
      identity: computeReportIdentity(
        currentSnapshotDigest,
        resolveEntries(normalizedConfig),
        rules,
        normalizedConfig.models,
      ),
      ...(observation !== undefined ? { observation } : {}),
      ...(explanations !== undefined && explanations.length === 1
        ? { explanation: explanations[0] }
        : {}),
      ...(explanations !== undefined && explanations.length > 1
        ? { explanations }
        : {}),
    };
  }

  return {
    get snapshotId() {
      return currentSnapshotId;
    },
    get projects() {
      return currentProjects;
    },
    get memory() {
      return readMemoryStats(lastEngineRssBytes);
    },
    check: (optionsOrRules?: readonly Rule[] | SessionCheckOptions) => {
      if (isSessionCheckOptions(optionsOrRules)) {
        return executeCheckRun(optionsOrRules);
      }
      return executeCheckRun(
        optionsOrRules !== undefined
          ? { rulesOverride: optionsOrRules }
          : undefined,
      );
    },
    update: async (updateOptions?: SessionUpdateOptions) => {
      assertOpen();
      const nextConfig = resolveNextConfig(normalizedConfig, updateOptions);
      const nextEntries = resolveEntries(nextConfig);
      const previousSnapshotId = currentSnapshotId;

      const updated = await client.request<EngineUpdateResult>(
        "snapshot.update",
        {
          snapshotId: previousSnapshotId,
          entries: nextEntries,
          changed: updateOptions?.changed ?? [],
          created: updateOptions?.created ?? [],
          deleted: updateOptions?.deleted ?? [],
        },
      );

      const invalidatedBy = collectInvalidatedBy(
        normalizedConfig,
        nextConfig,
        updateOptions,
      );

      normalizedConfig = nextConfig;
      currentSnapshotId = updated.snapshotId;
      currentSnapshotDigest = updated.snapshotDigest;
      currentProjects = updated.projects;
      lastEngineRssBytes = updated.engineRssBytes;
      syntaxCache.clear();
      typeCache.clear();

      const recomputation: RecomputationScope = {
        recomputedProjects: updated.recomputedProjects,
        reusedProjects: updated.reusedProjects,
        recomputedFiles: updated.recomputedFiles,
        reusedFiles: updated.reusedFiles,
        removedFiles: updated.removedFiles,
        invalidatedBy,
      };

      return {
        previousSnapshotId,
        snapshotId: updated.snapshotId,
        projects: updated.projects,
        recomputation,
        memory: readMemoryStats(updated.engineRssBytes),
      };
    },
    explain: async (explainOptions: ExplainOptions): Promise<ExplainReport> => {
      const report = await executeCheckRun({
        ...(explainOptions.rulesOverride !== undefined
          ? { rulesOverride: explainOptions.rulesOverride }
          : {}),
        ...(explainOptions.ruleId !== undefined
          ? { ruleIds: [explainOptions.ruleId] }
          : {}),
        at: explainOptions.at,
        ...(explainOptions.observe !== undefined
          ? { observe: explainOptions.observe }
          : {}),
        ...(explainOptions.observeLimit !== undefined
          ? { observeLimit: explainOptions.observeLimit }
          : {}),
      });
      const primaryExplanation = report.explanation ?? report.explanations?.[0];
      if (!primaryExplanation) {
        throw new VeruleExecutionError(
          "ENGINE_ERROR",
          "Failed to generate explanation for the requested target.",
        );
      }
      return {
        ...report,
        explanation: primaryExplanation,
      };
    },
    close: async () => {
      if (closed) return;
      closed = true;
      syntaxCache.clear();
      typeCache.clear();
      try {
        await client.request("snapshot.release", {
          snapshotId: currentSnapshotId,
        });
      } catch {
        // Best-effort release before terminating the child process.
      } finally {
        await client.close();
      }
    },
  };
}

/** Runs a one-shot check in a dedicated analysis session and releases resources before returning. */
export async function runCheck(options: RunCheckOptions): Promise<CheckReport> {
  const session = await openSession(options);
  try {
    return await session.check({
      ...(options.ruleIds !== undefined ? { ruleIds: options.ruleIds } : {}),
      ...(options.at !== undefined ? { at: options.at } : {}),
      ...(options.observe !== undefined ? { observe: options.observe } : {}),
      ...(options.observeLimit !== undefined
        ? { observeLimit: options.observeLimit }
        : {}),
    });
  } finally {
    await session.close();
  }
}
