import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  createAdditionalInputRegistry,
  createScopedAdditionalInputRegistrar,
  validateAdditionalInputPaths,
  type AdditionalInputEntry,
  type AdditionalInputRegistrar,
  type AdditionalInputSource,
} from "./additional-inputs.ts";
import {
  assertValidProgramRef,
  toBranchCoverageItem,
  toFunctionBranchesResult,
  type BranchCoverageItem,
  type BranchCoverageOptions,
  type EngineBranchCoverageItem,
  type EngineFunctionBranchesItem,
  type FunctionBranchesResult,
} from "./branch-coverage.ts";
import {
  createCallsValuesCache,
  createCallsValuesQueries,
} from "./calls-values.ts";
import { EngineClient, type RpcRequestOptions } from "./engine-client.ts";
import {
  FactCache,
  executeFactQuery,
  validateAdapters,
  type AdapterContext,
  type FactQueryOptions,
  type FactType,
  type LibraryAdapter,
} from "./facts.ts";
import {
  INLINE_IGNORE_RULE_ID,
  resolveInlineIgnores,
  type EngineDirectiveItem,
  type EngineDirectivesScanResult,
} from "./inline-ignore.ts";
import {
  createInstanceIdentityCache,
  createInstanceIdentityQueries,
  validateInstanceBehaviors,
} from "./instance-identity.ts";
import {
  ObservationCollector,
  locationMatchesTarget,
  normalizeObserveConfig,
  normalizeTargetSpec,
  type EngineCallIoMetrics,
} from "./observation.ts";
import { createProjectionQueries, validateProgramRefs } from "./projection.ts";
import {
  buildDiagnostics,
  buildFileOrigins,
  buildGaps,
  resolveProjectEntries,
  type CollectedDiagnostic,
} from "./projects.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  makeProgramRef,
  type AnalysisSession,
  type CheckReport,
  type CheckpointOutcome,
  type CheckpointTarget,
  type DiagnosticInput,
  type DiagnosticLocation,
  type ExplainOptions,
  type ExplainReport,
  type FindSyntaxOptions,
  type Gap,
  type MemoryStats,
  type Model,
  type ModelIdentitySummary,
  type NormalizedVeruleConfig,
  type OpenSessionOptions,
  type ProgramObjectKind,
  type ProjectSummary,
  type RecomputationScope,
  type ReportIdentity,
  type Rule,
  type RuleContext,
  type RuleIdentitySummary,
  type RunCheckOptions,
  type SessionCheckOptions,
  type SessionUpdateOptions,
  type SourceFileOrigin,
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
  readonly body?: string;
  readonly parameters?: readonly string[];
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
  readonly gaps?: readonly Gap[];
};

type EngineBatchResult = {
  readonly results: readonly {
    readonly items: readonly unknown[];
  }[];
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
    if (rule.id === INLINE_IGNORE_RULE_ID) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Rule id "${INLINE_IGNORE_RULE_ID}" is reserved.`,
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
    validateInstanceBehaviors(model.id, model.instanceBehaviors);
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
  validateInstanceBehaviors(model.id, model.instanceBehaviors);
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
  const adapters = validateAdapters(config.adapters ?? []);
  const additionalInputs = validateAdditionalInputPaths(
    config.additionalInputs,
  );
  return {
    ...(config.tsconfig !== undefined ? { tsconfig: config.tsconfig } : {}),
    ...(config.projects !== undefined
      ? { projects: [...config.projects] }
      : {}),
    rules,
    models,
    adapters,
    additionalInputs,
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
        ...(model.instanceBehaviors !== undefined
          ? { instanceBehaviors: model.instanceBehaviors }
          : {}),
      }),
    ),
  };
}

function summarizeAdapter(adapter: LibraryAdapter) {
  return {
    id: adapter.id,
    version: adapter.version ?? null,
    provides: adapter.provides
      .map((provider) => provider.factType.id)
      .toSorted(),
  };
}

function computeReportIdentity(
  snapshotDigest: string,
  entries: readonly string[],
  rules: readonly Rule[],
  models: readonly Model[],
  additionalInputs: readonly string[] = [],
  adapters: readonly LibraryAdapter[] = [],
): ReportIdentity {
  const ruleSummaries = rules.map(summarizeRule);
  const modelSummaries = models.map(summarizeModel);
  const adapterSummaries = adapters
    .map(summarizeAdapter)
    .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const configDigest = sha256Prefix(
    stableSerialize({
      entries,
      rules: ruleSummaries,
      models: modelSummaries,
      ...(additionalInputs.length > 0 ? { additionalInputs } : {}),
      ...(adapterSummaries.length > 0 ? { adapters: adapterSummaries } : {}),
    }),
  );
  return {
    snapshotDigest,
    configDigest,
    rules: ruleSummaries,
    models: modelSummaries,
  };
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
    ...(item.body !== undefined
      ? {
          body: makeProgramRef(
            "syntax",
            sessionToken,
            projectId,
            snapshotId,
            item.body,
          ),
        }
      : {}),
    ...(item.parameters !== undefined
      ? {
          parameters: item.parameters.map((paramId) =>
            makeProgramRef(
              "syntax",
              sessionToken,
              projectId,
              snapshotId,
              paramId,
            ),
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
  const adapters = options?.adapters
    ? validateAdapters(options.adapters)
    : current.adapters;
  const additionalInputs =
    options?.additionalInputs !== undefined
      ? validateAdditionalInputPaths(options.additionalInputs)
      : current.additionalInputs;
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
      adapters,
      additionalInputs,
    };
  }
  return {
    ...(current.tsconfig !== undefined ? { tsconfig: current.tsconfig } : {}),
    ...(current.projects !== undefined ? { projects: current.projects } : {}),
    rules,
    models,
    adapters,
    additionalInputs,
  };
}

function collectInvalidatedBy(
  prevConfig: NormalizedVeruleConfig,
  nextConfig: NormalizedVeruleConfig,
  options?: SessionUpdateOptions,
  changedAdditionalFiles: readonly string[] = [],
): readonly string[] {
  const reasons: string[] = [];
  const changedSet = new Set<string>(options?.changed ?? []);
  for (const file of options?.changed ?? []) reasons.push(`changed:${file}`);
  for (const file of options?.created ?? []) reasons.push(`created:${file}`);
  for (const file of options?.deleted ?? []) reasons.push(`deleted:${file}`);
  for (const file of changedAdditionalFiles) {
    if (!changedSet.has(file)) {
      reasons.push(`additional-input:${file}`);
    }
  }

  const prevEntries = resolveProjectEntries(prevConfig);
  const nextEntries = resolveProjectEntries(nextConfig);
  const prevIdentity = computeReportIdentity(
    "",
    prevEntries,
    prevConfig.rules,
    prevConfig.models,
    prevConfig.additionalInputs,
    prevConfig.adapters,
  );
  const nextIdentity = computeReportIdentity(
    "",
    nextEntries,
    nextConfig.rules,
    nextConfig.models,
    nextConfig.additionalInputs,
    nextConfig.adapters,
  );
  if (stableSerialize(prevEntries) !== stableSerialize(nextEntries)) {
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
  if (
    stableSerialize(prevConfig.additionalInputs) !==
    stableSerialize(nextConfig.additionalInputs)
  ) {
    reasons.push("additionalInputs");
  }
  if (
    stableSerialize(
      prevConfig.adapters
        .map(summarizeAdapter)
        .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    ) !==
    stableSerialize(
      nextConfig.adapters
        .map(summarizeAdapter)
        .toSorted((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    )
  ) {
    reasons.push("adapters");
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
  const initialEntries = resolveProjectEntries(normalizedConfig);
  const absCwd = resolve(options.cwd);
  const sessionObserve = normalizeObserveConfig(
    options.observe,
    options.observeLimit,
  );

  const client = new EngineClient();
  let openIoMetrics: EngineCallIoMetrics | undefined;
  const openStart = performance.now();
  let openResult: EngineOpenResult;
  let openDurationMs: number;
  let initialFileOrigins: readonly SourceFileOrigin[];
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
    openDurationMs = performance.now() - openStart;
    initialFileOrigins = buildFileOrigins(openResult.projects);
  } catch (err) {
    await client.close();
    throw err;
  }

  const sessionToken = Symbol("verule-session");
  let currentSnapshotId = openResult.snapshotId;
  let currentSnapshotDigest = openResult.snapshotDigest;
  let currentProjects = openResult.projects;
  let currentFileOrigins = initialFileOrigins;
  let lastEngineRssBytes = openResult.engineRssBytes;
  let closed = false;
  let pendingOpenIoMetrics = openIoMetrics;
  let pendingOpenDurationMs = openDurationMs;
  let pendingConfigLoadMs = options.configLoadMs ?? 0;

  const syntaxCache = new Map<string, Promise<readonly SyntaxNodeResult[]>>();
  const typeCache = new Map<string, Promise<TypeAtResult>>();
  const branchListCache = new Map<string, Promise<FunctionBranchesResult>>();
  const callsValuesCache = createCallsValuesCache();
  const instanceCache = createInstanceIdentityCache();
  const factCache = new FactCache();
  const syntaxLocations = new WeakMap<SyntaxRef, DiagnosticLocation>();
  let cachedDirectives:
    | {
        readonly snapshotId: number;
        readonly promise: Promise<readonly EngineDirectiveItem[]>;
      }
    | undefined;

  function scanDirectives(
    snapshotId: number,
    collector: ObservationCollector,
  ): Promise<readonly EngineDirectiveItem[]> {
    if (cachedDirectives?.snapshotId === snapshotId) {
      return cachedDirectives.promise;
    }
    const promise = client
      .request<EngineDirectivesScanResult>(
        "directives.scan",
        { snapshotId },
        buildRpcOptions(collector),
      )
      .then((res) => res.directives);
    cachedDirectives = { snapshotId, promise };
    return promise;
  }

  const explicitRegistrations: {
    readonly filePath: string;
    readonly source: AdditionalInputSource;
  }[] = [];
  let lastRuleRegistrations: {
    readonly filePath: string;
    readonly source: AdditionalInputSource;
  }[] = [];

  function buildSessionRegistry(
    configInputs: readonly string[],
    explicit: readonly {
      readonly filePath: string;
      readonly source: AdditionalInputSource;
    }[],
    dynamic: readonly {
      readonly filePath: string;
      readonly source: AdditionalInputSource;
    }[],
  ) {
    const registry = createAdditionalInputRegistry({ cwd: absCwd });
    for (const filePath of configInputs) {
      registry.registerAdditionalInput(filePath, { kind: "config" });
    }
    for (const item of explicit) {
      registry.registerAdditionalInput(item.filePath, item.source);
    }
    for (const item of dynamic) {
      registry.registerAdditionalInput(item.filePath, item.source);
    }
    return registry;
  }

  let sessionRegistry = buildSessionRegistry(
    normalizedConfig.additionalInputs,
    explicitRegistrations,
    lastRuleRegistrations,
  );

  function assertOpen(): void {
    if (closed) {
      throw new VeruleExecutionError(
        "SESSION_CLOSED",
        "Analysis session is already closed.",
      );
    }
  }

  function createRuleContext(
    ruleId: string,
    project: ProjectSummary,
    models: readonly Model[],
    collected: CollectedDiagnostic[],
    collectedGaps: Gap[],
    collector: ObservationCollector,
    recordRuleEngineMs: (ms: number) => void,
    additionalInputRegistrar: AdditionalInputRegistrar,
  ): RuleContext {
    const activeSnapshotId = currentSnapshotId;
    const scopedAdditionalInputs = createScopedAdditionalInputRegistrar(
      additionalInputRegistrar,
      { kind: "rule", id: ruleId },
    );

    const assertActiveSnapshot = (): void => {
      assertOpen();
      if (activeSnapshotId !== currentSnapshotId) {
        throw new VeruleExecutionError(
          "STALE_SNAPSHOT",
          `Snapshot ${String(activeSnapshotId)} has been superseded by snapshot ${String(currentSnapshotId)}.`,
        );
      }
    };

    const recordGaps = (gaps: readonly Gap[]): void => {
      for (const gap of gaps) {
        collectedGaps.push(gap);
      }
    };

    const projectionQueries = createProjectionQueries({
      client,
      sessionToken,
      snapshotId: activeSnapshotId,
      projectId: project.projectId,
      assertOpen: assertActiveSnapshot,
      recordGaps,
      getRpcOptions: () => buildRpcOptions(collector),
      ...(collector.isActive()
        ? {
            onQueryCompleted: (op, candidateCount, durationMs) => {
              collector.addEngineQueryMs(durationMs);
              recordRuleEngineMs(durationMs);
              collector.recordQuery({
                ruleId,
                op,
                projectId: project.projectId,
                provider: "engine",
                cacheStatus: "computed",
                candidateCount,
                durationMs,
                summary: `${op} -> ${candidateCount} item(s)`,
              });
            },
          }
        : {}),
    });

    const callsValuesQueries = createCallsValuesQueries({
      client,
      cache: callsValuesCache,
      sessionToken,
      snapshotId: activeSnapshotId,
      projectId: project.projectId,
      assertOpen: assertActiveSnapshot,
      recordGaps,
      getRpcOptions: () => buildRpcOptions(collector),
      ...(collector.isActive()
        ? {
            onQueryCompleted: (op, cacheStatus, candidateCount, durationMs) => {
              if (cacheStatus === "computed") {
                collector.addEngineQueryMs(durationMs);
                recordRuleEngineMs(durationMs);
              }
              collector.recordQuery({
                ruleId,
                op,
                projectId: project.projectId,
                provider: "engine",
                cacheStatus,
                candidateCount,
                durationMs,
                summary: `${op} -> ${candidateCount} item(s)`,
              });
            },
          }
        : {}),
    });

    const instanceQueries = createInstanceIdentityQueries({
      client,
      cache: instanceCache,
      models,
      sessionToken,
      snapshotId: activeSnapshotId,
      projectId: project.projectId,
      assertOpen: assertActiveSnapshot,
      recordGaps,
      getRpcOptions: () => buildRpcOptions(collector),
      ...(collector.isActive()
        ? {
            onQueryCompleted: (op, cacheStatus, candidateCount, durationMs) => {
              if (cacheStatus === "computed") {
                collector.addEngineQueryMs(durationMs);
                recordRuleEngineMs(durationMs);
              }
              collector.recordQuery({
                ruleId,
                op,
                projectId: project.projectId,
                provider: "engine",
                cacheStatus,
                candidateCount,
                durationMs,
                summary: `${op} -> ${candidateCount} item(s)`,
              });
            },
          }
        : {}),
    });

    const adapterCallsValuesQueries = createCallsValuesQueries({
      client,
      cache: callsValuesCache,
      sessionToken,
      snapshotId: activeSnapshotId,
      projectId: project.projectId,
      assertOpen: assertActiveSnapshot,
      recordGaps,
      getRpcOptions: () => buildRpcOptions(collector),
      ...(collector.isActive()
        ? {
            onQueryCompleted: (
              _op,
              cacheStatus,
              _candidateCount,
              durationMs,
            ) => {
              if (cacheStatus === "computed") {
                collector.addEngineQueryMs(durationMs);
                recordRuleEngineMs(durationMs);
              }
            },
          }
        : {}),
    });

    const runFindSyntax = async (
      query: FindSyntaxOptions,
      recordRuleQuery: boolean,
    ): Promise<readonly SyntaxNodeResult[]> => {
      assertActiveSnapshot();
      const cacheKey = JSON.stringify([
        activeSnapshotId,
        project.projectId,
        query.kinds ? query.kinds.toSorted() : null,
        query.files ? query.files.toSorted() : null,
        query.range ?? null,
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
                  ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
                  ...(query.files !== undefined ? { files: query.files } : {}),
                  ...(query.range !== undefined ? { range: query.range } : {}),
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
        if (recordRuleQuery) {
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
          const kindsLabel = query.kinds ? query.kinds.join(", ") : "range";
          collector.recordQuery({
            ruleId,
            op: "findSyntax",
            projectId: project.projectId,
            provider: "engine",
            cacheStatus,
            candidateCount: items.length,
            durationMs,
            summary: `findSyntax(${kindsLabel}) -> ${items.length} candidate(s)`,
            ...(matchedLocations !== undefined ? { matchedLocations } : {}),
            ...(collector.mode === "detail" || collector.isExplainEnabled()
              ? {
                  detail: {
                    ...(query.kinds !== undefined
                      ? { kinds: query.kinds }
                      : {}),
                    ...(query.files !== undefined
                      ? { files: query.files }
                      : {}),
                    ...(query.range !== undefined
                      ? { range: query.range }
                      : {}),
                  },
                }
              : {}),
          });
        }
      }

      return items;
    };

    const runTypeAt = async (
      targets: readonly SyntaxRef[],
      recordRuleQuery: boolean,
    ): Promise<readonly TypeAtResult[]> => {
      assertActiveSnapshot();
      if (targets.length === 0) return [];
      validateProgramRefs(
        targets,
        sessionToken,
        activeSnapshotId,
        project.projectId,
      );

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
            if (raw.gaps) {
              recordGaps(raw.gaps);
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
        if (recordRuleQuery) {
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
      }

      return results;
    };

    const runListBranches = async (
      functions: readonly SyntaxRef[],
      recordRuleQuery: boolean,
    ): Promise<readonly FunctionBranchesResult[]> => {
      assertActiveSnapshot();
      if (functions.length === 0) return [];

      for (const fnRef of functions) {
        assertValidProgramRef(
          fnRef,
          sessionToken,
          activeSnapshotId,
          project.projectId,
        );
      }

      const queryStart = collector.isActive() ? performance.now() : 0;
      const missingFunctions: SyntaxRef[] = [];
      for (const fnRef of functions) {
        const key = `${activeSnapshotId}:${project.projectId}:${fnRef.handleId}`;
        if (!branchListCache.has(key)) {
          missingFunctions.push(fnRef);
        }
      }
      const cacheStatus: "computed" | "reused" =
        missingFunctions.length > 0 ? "computed" : "reused";

      if (missingFunctions.length > 0) {
        const batchPromise = client.request<EngineBatchResult>(
          "query.batch",
          {
            snapshotId: activeSnapshotId,
            projectId: project.projectId,
            steps: [
              {
                op: "listBranches",
                targets: missingFunctions.map((fnRef) => fnRef.handleId),
              },
            ],
          },
          buildRpcOptions(collector),
        );

        for (const [index, fnRef] of missingFunctions.entries()) {
          const key = `${activeSnapshotId}:${project.projectId}:${fnRef.handleId}`;
          const itemPromise = batchPromise.then((batch) => {
            const items = (batch.results[0]?.items ??
              []) as readonly EngineFunctionBranchesItem[];
            const raw = items[index];
            if (!raw) {
              throw new VeruleExecutionError(
                "ENGINE_ERROR",
                `Engine omitted branch list for function "${fnRef.handleId}".`,
              );
            }
            const mapped = toFunctionBranchesResult(
              raw,
              fnRef,
              sessionToken,
              project.projectId,
              activeSnapshotId,
            );
            for (const branch of mapped.branches) {
              syntaxLocations.set(branch.condition, branch.location);
            }
            return mapped;
          });
          branchListCache.set(key, itemPromise);
        }
      }

      const results = await Promise.all(
        functions.map((fnRef) =>
          branchListCache.get(
            `${activeSnapshotId}:${project.projectId}:${fnRef.handleId}`,
          )!,
        ),
      );

      if (collector.isActive()) {
        const durationMs = performance.now() - queryStart;
        if (cacheStatus === "computed") {
          collector.addEngineQueryMs(durationMs);
          recordRuleEngineMs(durationMs);
        }
        if (recordRuleQuery) {
          collector.recordQuery({
            ruleId,
            op: "listBranches",
            projectId: project.projectId,
            provider: "engine",
            cacheStatus,
            candidateCount: results.reduce(
              (total, item) => total + item.branches.length,
              0,
            ),
            durationMs,
            summary: `listBranches(${functions.length} function(s))`,
          });
        }
      }

      return results;
    };

    const runBranchCoverage = async (
      query: BranchCoverageOptions,
      recordRuleQuery: boolean,
    ): Promise<readonly BranchCoverageItem[]> => {
      assertActiveSnapshot();
      if (query.function !== undefined) {
        assertValidProgramRef(
          query.function,
          sessionToken,
          activeSnapshotId,
          project.projectId,
        );
      }
      for (const branchRef of query.branches) {
        assertValidProgramRef(
          branchRef,
          sessionToken,
          activeSnapshotId,
          project.projectId,
        );
      }
      for (const targetRef of query.targets) {
        assertValidProgramRef(
          targetRef,
          sessionToken,
          activeSnapshotId,
          project.projectId,
        );
      }
      if (query.targets.length === 0) return [];

      const queryStart = collector.isActive() ? performance.now() : 0;
      const batch = await client.request<EngineBatchResult>(
        "query.batch",
        {
          snapshotId: activeSnapshotId,
          projectId: project.projectId,
          steps: [
            {
              op: "branchCoverage",
              ...(query.function !== undefined
                ? { function: query.function.handleId }
                : {}),
              branches: query.branches.map((branch) => branch.handleId),
              targets: query.targets.map((target) => target.handleId),
            },
          ],
        },
        buildRpcOptions(collector),
      );

      const rawItems = (batch.results[0]?.items ??
        []) as readonly EngineBranchCoverageItem[];
      const results: BranchCoverageItem[] = [];
      for (const [index, targetRef] of query.targets.entries()) {
        const raw = rawItems[index];
        if (!raw) {
          throw new VeruleExecutionError(
            "ENGINE_ERROR",
            `Engine omitted branchCoverage result for target "${targetRef.handleId}".`,
          );
        }
        const mapped = toBranchCoverageItem(raw, targetRef);
        collectedGaps.push(...mapped.gaps);
        results.push(mapped);
      }

      if (collector.isActive()) {
        const durationMs = performance.now() - queryStart;
        collector.addEngineQueryMs(durationMs);
        recordRuleEngineMs(durationMs);
        if (recordRuleQuery) {
          collector.recordQuery({
            ruleId,
            op: "branchCoverage",
            projectId: project.projectId,
            provider: "engine",
            cacheStatus: "computed",
            candidateCount: results.length,
            durationMs,
            summary: `branchCoverage(${query.branches.length} branch(es), ${query.targets.length} target(s))`,
          });
        }
      }

      return results;
    };

    const adapterProjectionQueries = createProjectionQueries({
      client,
      sessionToken,
      snapshotId: activeSnapshotId,
      projectId: project.projectId,
      assertOpen: assertActiveSnapshot,
      recordGaps,
      getRpcOptions: () => buildRpcOptions(collector),
      ...(collector.isActive()
        ? {
            onQueryCompleted: (_op, _candidateCount, durationMs) => {
              collector.addEngineQueryMs(durationMs);
              recordRuleEngineMs(durationMs);
            },
          }
        : {}),
    });

    const createAdapterContext = (
      adapterId: string,
      onAdditionalInput: (filePath: string) => void,
    ): AdapterContext => {
      const scopedAdapterInputs = createScopedAdditionalInputRegistrar(
        additionalInputRegistrar,
        { kind: "adapter", id: adapterId },
      );
      return {
        project,
        models,
        getModel: (id: string) => models.find((model) => model.id === id),
        ...adapterProjectionQueries,
        ...adapterCallsValuesQueries,
        findSyntax: (query: FindSyntaxOptions) => runFindSyntax(query, false),
        typeAt: (targets: readonly SyntaxRef[]) => runTypeAt(targets, false),
        listBranches: (functions: readonly SyntaxRef[]) =>
          runListBranches(functions, false),
        branchCoverage: (query: BranchCoverageOptions) =>
          runBranchCoverage(query, false),
        registerAdditionalInput: (filePath: string) => {
          assertActiveSnapshot();
          onAdditionalInput(filePath);
          return scopedAdapterInputs.registerAdditionalInput(filePath);
        },
        readAdditionalInput: (filePath: string) => {
          assertActiveSnapshot();
          onAdditionalInput(filePath);
          return scopedAdapterInputs.readAdditionalInput(filePath);
        },
      };
    };

    const replayAdapterAdditionalInput = (
      adapterId: string,
      filePath: string,
    ): void => {
      assertActiveSnapshot();
      additionalInputRegistrar.registerAdditionalInput(filePath, {
        kind: "adapter",
        id: adapterId,
      });
    };

    return {
      project,
      models,
      getModel: (id: string) => models.find((model) => model.id === id),
      ...projectionQueries,
      ...callsValuesQueries,
      ...instanceQueries,
      findSyntax: (query: FindSyntaxOptions) => runFindSyntax(query, true),
      typeAt: (targets: readonly SyntaxRef[]) => runTypeAt(targets, true),
      facts: <SubjectKind extends ProgramObjectKind, Condition, Value>(
        factType: FactType<SubjectKind, Condition, Value>,
        factOptions?: FactQueryOptions<SubjectKind, Condition>,
      ) =>
        executeFactQuery({
          factType,
          options: factOptions,
          adapters: normalizedConfig.adapters,
          factCache,
          sessionToken,
          snapshotId: activeSnapshotId,
          projectId: project.projectId,
          ruleId,
          assertActiveSnapshot,
          createAdapterContext,
          replayAdapterAdditionalInput,
          recordGaps,
          collector,
          syntaxLocations,
        }),
      listBranches: (functions: readonly SyntaxRef[]) =>
        runListBranches(functions, true),
      branchCoverage: (query: BranchCoverageOptions) =>
        runBranchCoverage(query, true),
      registerAdditionalInput: (filePath: string) => {
        assertActiveSnapshot();
        return scopedAdditionalInputs.registerAdditionalInput(filePath);
      },
      readAdditionalInput: (filePath: string) => {
        assertActiveSnapshot();
        return scopedAdditionalInputs.readAdditionalInput(filePath);
      },
      report: (input: DiagnosticInput) => {
        assertActiveSnapshot();
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
    const collectedGaps: Gap[] = [];
    const runRegistry = buildSessionRegistry(
      normalizedConfig.additionalInputs,
      explicitRegistrations,
      [],
    );
    const runRuleRegistrations: {
      readonly filePath: string;
      readonly source: AdditionalInputSource;
    }[] = [];
    const runRegistrar: AdditionalInputRegistrar = {
      cwd: runRegistry.cwd,
      registerAdditionalInput: (filePath, source) => {
        sessionRegistry.registerAdditionalInput(filePath, source);
        runRuleRegistrations.push({ filePath, source });
        return runRegistry.registerAdditionalInput(filePath, source);
      },
      readAdditionalInput: (filePath, source) => {
        sessionRegistry.registerAdditionalInput(filePath, source);
        runRuleRegistrations.push({ filePath, source });
        return runRegistry.readAdditionalInput(filePath, source);
      },
      listAdditionalInputs: () => runRegistry.listAdditionalInputs(),
      getTrackedAbsolutePaths: () => runRegistry.getTrackedAbsolutePaths(),
    };

    for (const project of currentProjects) {
      for (const rule of rules) {
        let ruleEngineMs = 0;
        const ruleStart = collector.isObserveEnabled() ? performance.now() : 0;
        const ctx = createRuleContext(
          rule.id,
          project,
          normalizedConfig.models,
          collected,
          collectedGaps,
          collector,
          (ms) => {
            ruleEngineMs += ms;
          },
          runRegistrar,
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

    const scannedDirectives = await scanDirectives(
      currentSnapshotId,
      collector,
    );
    const settlement = resolveInlineIgnores({
      directives: scannedDirectives,
      collected,
      projects: currentProjects,
      configuredRuleIds: new Set(baseRules.map((rule) => rule.id)),
      executedRuleIds: new Set(rules.map((rule) => rule.id)),
      isPartialRuleSelection:
        runOptions?.ruleIds !== undefined && runOptions.ruleIds.length > 0,
    });

    const diagnostics = buildDiagnostics(settlement.diagnostics);
    const gaps = buildGaps(collectedGaps);
    const additionalInputs = runRegistry.listAdditionalInputs();
    if (!runOptions?.ruleIds && !runOptions?.rulesOverride) {
      lastRuleRegistrations = runRuleRegistrations;
      sessionRegistry = buildSessionRegistry(
        normalizedConfig.additionalInputs,
        explicitRegistrations,
        lastRuleRegistrations,
      );
    }
    const observation = collector.buildObservationReport();
    const explanations = explainTarget
      ? rules.map((rule) =>
          collector.buildExplainResult({
            ruleId: rule.id,
            projects: currentProjects,
            diagnostics,
            suppressions: settlement.suppressions,
          }),
        )
      : undefined;

    return {
      reportVersion: REPORT_SCHEMA_VERSION,
      status: diagnostics.length > 0 ? "findings" : "clean",
      projects: currentProjects,
      fileOrigins: currentFileOrigins,
      additionalInputs,
      diagnostics,
      gaps,
      identity: computeReportIdentity(
        currentSnapshotDigest,
        resolveProjectEntries(normalizedConfig),
        rules,
        normalizedConfig.models,
        normalizedConfig.additionalInputs,
        normalizedConfig.adapters,
      ),
      ...(settlement.entries.length > 0
        ? { inlineIgnores: settlement.entries }
        : {}),
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
    get fileOrigins() {
      return currentFileOrigins;
    },
    get additionalInputs(): readonly AdditionalInputEntry[] {
      return sessionRegistry.listAdditionalInputs();
    },
    get memory() {
      return readMemoryStats(lastEngineRssBytes);
    },
    registerAdditionalInput: (
      filePath: string,
      source: AdditionalInputSource,
    ) => {
      assertOpen();
      explicitRegistrations.push({ filePath, source });
      return sessionRegistry.registerAdditionalInput(filePath, source);
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
      const changedAdditionalFiles = sessionRegistry.refresh();
      const nextConfig = resolveNextConfig(normalizedConfig, updateOptions);
      const nextEntries = resolveProjectEntries(nextConfig);
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
        changedAdditionalFiles,
      );
      const updatedFileOrigins = buildFileOrigins(updated.projects);

      normalizedConfig = nextConfig;
      currentSnapshotId = updated.snapshotId;
      currentSnapshotDigest = updated.snapshotDigest;
      currentProjects = updated.projects;
      currentFileOrigins = updatedFileOrigins;
      lastEngineRssBytes = updated.engineRssBytes;
      syntaxCache.clear();
      typeCache.clear();
      branchListCache.clear();
      callsValuesCache.clear();
      instanceCache.clear();
      factCache.clear();
      cachedDirectives = undefined;
      sessionRegistry = buildSessionRegistry(
        nextConfig.additionalInputs,
        explicitRegistrations,
        lastRuleRegistrations,
      );
      const updatedAdditionalInputs = sessionRegistry.listAdditionalInputs();

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
        fileOrigins: updatedFileOrigins,
        additionalInputs: updatedAdditionalInputs,
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
      branchListCache.clear();
      callsValuesCache.clear();
      instanceCache.clear();
      factCache.clear();
      cachedDirectives = undefined;
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
