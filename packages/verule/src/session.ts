import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

import {
  defineAdapter as tssaeDefineAdapter,
  defineModel as tssaeDefineModel,
  extractBasisEvidence,
  openProject,
  syntaxLocationOf,
  type AdditionalInputEntry,
  type AdditionalInputRegistrar,
  type AdditionalInputSource,
  type DiagnosticLocation,
  type LibraryAdapter,
  type Model,
  type ProjectContext,
  type ProjectSession,
  type QueryObserver,
  type RecomputationScope,
} from "tssae";

import {
  createAdditionalInputRegistry,
  createScopedAdditionalInputRegistrar,
  validateAdditionalInputPaths,
} from "./additional-inputs.ts";
import {
  INLINE_IGNORE_RULE_ID,
  parseInlineIgnoreDirectives,
  resolveInlineIgnores,
} from "./inline-ignore.ts";
import {
  ObservationCollector,
  normalizeObserveConfig,
  normalizeTargetSpec,
  type EngineCallIoMetrics,
} from "./observation.ts";
import {
  buildDiagnostics,
  buildGaps,
  resolveProjectEntries,
  type CollectedDiagnostic,
} from "./projects.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  toVeruleError,
  type AnalysisSession,
  type CheckReport,
  type CheckpointOutcome,
  type CheckpointTarget,
  type DiagnosticInput,
  type ExplainOptions,
  type ExplainReport,
  type Gap,
  type ModelIdentitySummary,
  type NormalizedVeruleConfig,
  type OpenSessionOptions,
  type ReportIdentity,
  type Rule,
  type RuleContext,
  type RuleIdentitySummary,
  type RunCheckOptions,
  type SessionCheckOptions,
  type SessionUpdateOptions,
  type VeruleConfig,
} from "./types.ts";

type SessionWorkspaceFileState = {
  files: readonly string[];
};

// Watch needs these paths for hashing without adding them to the public project summary.
const sessionWorkspaceFileStates = new WeakMap<
  AnalysisSession,
  SessionWorkspaceFileState
>();

/** Returns all workspace source file paths tracked by the active session for file watching. */
export function getSessionWorkspaceFiles(
  session: AnalysisSession,
): readonly string[] {
  return sessionWorkspaceFileStates.get(session)?.files ?? [];
}

function canonicalizeDir(dirPath: string): string {
  if (!existsSync(dirPath)) return dirPath;
  try {
    return realpathSync.native(dirPath);
  } catch {
    return dirPath;
  }
}

async function invokeProjectQuery<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    throw toVeruleError(err);
  }
}

function invokeProjectSync<T>(fn: () => T): T {
  try {
    return fn();
  } catch (err) {
    throw toVeruleError(err);
  }
}

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

/** Validates a project model definition and attaches provenance metadata. */
export function defineModel(model: Model): Model {
  return invokeProjectSync(() => tssaeDefineModel(model));
}

function validateModels(models: readonly Model[]): readonly Model[] {
  const seen = new Set<string>();
  const validated: Model[] = [];
  for (const model of models) {
    const normalized = defineModel(model);
    if (seen.has(normalized.id)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Duplicate model id: "${normalized.id}".`,
      );
    }
    seen.add(normalized.id);
    validated.push(normalized);
  }
  return validated;
}

function validateAdapters(
  adapters: readonly LibraryAdapter[],
): readonly LibraryAdapter[] {
  const seen = new Set<string>();
  const validated: LibraryAdapter[] = [];
  for (const adapter of adapters) {
    const normalized = invokeProjectSync(() => tssaeDefineAdapter(adapter));
    if (seen.has(normalized.id)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Duplicate adapter id: "${normalized.id}".`,
      );
    }
    seen.add(normalized.id);
    validated.push(normalized);
  }
  return validated;
}

function validateAdapterPackageNames(
  packageNames: readonly string[],
): readonly string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const rawName of packageNames) {
    if (typeof rawName !== "string" || rawName.trim() === "") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        "Adapter package names must be non-empty strings.",
      );
    }
    const packageName = rawName.trim();
    if (seen.has(packageName)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Duplicate adapter package name: "${packageName}".`,
      );
    }
    seen.add(packageName);
    normalized.push(packageName);
  }
  return normalized;
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
export function defineConfig(
  config: VeruleConfig | NormalizedVeruleConfig,
): NormalizedVeruleConfig {
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
  const configuredAdapters = config.adapters ?? [];
  const adapters = validateAdapters(
    configuredAdapters.filter(
      (adapter): adapter is LibraryAdapter => typeof adapter !== "string",
    ),
  );
  const adapterPackages = validateAdapterPackageNames([
    ...("adapterPackages" in config ? config.adapterPackages : []),
    ...configuredAdapters.filter(
      (adapter): adapter is string => typeof adapter === "string",
    ),
  ]);
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
    adapterPackages,
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
        ...(model.cleanupOperations !== undefined
          ? { cleanupOperations: model.cleanupOperations }
          : {}),
        ...(model.lifecycleEvents !== undefined
          ? { lifecycleEvents: model.lifecycleEvents }
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
  adapterPackages: readonly string[] = [],
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
      ...(adapterPackages.length > 0 ? { adapterPackages } : {}),
    }),
  );
  return {
    snapshotDigest,
    configDigest,
    rules: ruleSummaries,
    models: modelSummaries,
  };
}

function resolveCheckpointLocation(
  target: CheckpointTarget,
): DiagnosticLocation | undefined {
  if ("location" in target) {
    return target.location;
  }
  if ("file" in target && "line" in target && "start" in target) {
    return target;
  }
  return syntaxLocationOf(target);
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
    ? validateAdapters(
        options.adapters.filter(
          (adapter): adapter is LibraryAdapter => typeof adapter !== "string",
        ),
      )
    : current.adapters;
  const adapterPackages = options?.adapters
    ? validateAdapterPackageNames(
        options.adapters.filter(
          (adapter): adapter is string => typeof adapter === "string",
        ),
      )
    : current.adapterPackages;
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
      adapterPackages,
      additionalInputs,
    };
  }
  return {
    ...(current.tsconfig !== undefined ? { tsconfig: current.tsconfig } : {}),
    ...(current.projects !== undefined ? { projects: current.projects } : {}),
    rules,
    models,
    adapters,
    adapterPackages,
    additionalInputs,
  };
}

function isSessionCheckOptions(
  value: readonly Rule[] | SessionCheckOptions | undefined,
): value is SessionCheckOptions {
  return value !== undefined && !Array.isArray(value);
}

/**
 * Opens an analysis session backed by a single TSSAE `ProjectSession`.
 *
 * Call `session.close()` when finished to release the snapshot and terminate the engine process.
 */
export async function openSession(
  options: OpenSessionOptions,
): Promise<AnalysisSession> {
  let normalizedConfig = options.config
    ? defineConfig(options.config)
    : defineConfig({});
  const absCwd = resolve(options.cwd);
  const canonicalCwd = canonicalizeDir(absCwd);
  let adapterResolutionRoot = resolve(options.adapterResolutionRoot ?? absCwd);
  const sessionObserve = normalizeObserveConfig(
    options.observe,
    options.observeLimit,
  );

  let openIoMetrics: EngineCallIoMetrics | undefined;
  const openStart = performance.now();
  const tssaeSession: ProjectSession = await invokeProjectQuery(() =>
    openProject({
      cwd: absCwd,
      ...(normalizedConfig.tsconfig !== undefined
        ? { tsconfig: normalizedConfig.tsconfig }
        : {}),
      ...(normalizedConfig.projects !== undefined
        ? { projects: normalizedConfig.projects }
        : {}),
      models: normalizedConfig.models,
      adapters: [
        ...normalizedConfig.adapters,
        ...normalizedConfig.adapterPackages,
      ],
      additionalInputs: normalizedConfig.additionalInputs,
      adapterResolutionRoot,
      ...(sessionObserve.mode !== "off"
        ? {
            observe: sessionObserve,
            onRpcMetrics: (io: EngineCallIoMetrics) => {
              openIoMetrics = io;
            },
          }
        : {}),
    }),
  );
  const openDurationMs = performance.now() - openStart;

  const workspaceFileState: SessionWorkspaceFileState = {
    files: tssaeSession.workspaceSourceFiles,
  };
  let closed = false;
  let pendingOpenIoMetrics = openIoMetrics;
  let pendingOpenDurationMs = openDurationMs;
  let pendingConfigLoadMs = options.configLoadMs ?? 0;

  const explicitRegistrations: {
    readonly filePath: string;
    readonly source: AdditionalInputSource;
  }[] = [];
  let lastRuleRegistrations: {
    readonly filePath: string;
    readonly source: AdditionalInputSource;
  }[] = [];

  function syncNonConfigEntries(
    registry: ReturnType<typeof createAdditionalInputRegistry>,
    entries: readonly AdditionalInputEntry[],
  ): void {
    for (const entry of entries) {
      const targetPath = resolve(canonicalCwd, entry.file);
      for (const source of entry.sources) {
        if (source.kind !== "config") {
          registry.registerAdditionalInput(targetPath, source);
        }
      }
    }
  }

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
    tssaeEntries: readonly AdditionalInputEntry[],
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
    syncNonConfigEntries(registry, tssaeEntries);
    return registry;
  }

  let sessionRegistry = buildSessionRegistry(
    normalizedConfig.additionalInputs,
    explicitRegistrations,
    lastRuleRegistrations,
    tssaeSession.additionalInputs,
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
    projectCtx: ProjectContext,
    activeSnapshotId: number,
    collected: CollectedDiagnostic[],
    collector: ObservationCollector,
    additionalInputRegistrar: AdditionalInputRegistrar,
  ): RuleContext {
    const scopedAdditionalInputs = createScopedAdditionalInputRegistrar(
      additionalInputRegistrar,
      { kind: "rule", id: ruleId },
    );

    const assertActiveSnapshot = (): void => {
      assertOpen();
      if (activeSnapshotId !== tssaeSession.snapshotId) {
        throw new VeruleExecutionError(
          "STALE_SNAPSHOT",
          `Snapshot ${String(activeSnapshotId)} has been superseded by snapshot ${String(tssaeSession.snapshotId)}.`,
        );
      }
    };

    return {
      project: projectCtx.project,
      models: projectCtx.models,
      getModel: (id) => projectCtx.getModel(id),
      findSyntax: (query) =>
        invokeProjectQuery(() => projectCtx.findSyntax(query)),
      typeAt: (targets) => invokeProjectQuery(() => projectCtx.typeAt(targets)),
      listBranches: (functions) =>
        invokeProjectQuery(() => projectCtx.listBranches(functions)),
      branchCoverage: (query) =>
        invokeProjectQuery(() => projectCtx.branchCoverage(query)),
      resolveDeclarations: (targets, opts) =>
        invokeProjectQuery(() => projectCtx.resolveDeclarations(targets, opts)),
      resolveCalls: (targets, opts) =>
        invokeProjectQuery(() => projectCtx.resolveCalls(targets, opts)),
      projectCalls: (calls, opts) =>
        invokeProjectQuery(() => projectCtx.projectCalls(calls, opts)),
      projectSignatures: (signatures, opts) =>
        invokeProjectQuery(() =>
          projectCtx.projectSignatures(signatures, opts),
        ),
      projectTypes: (types, opts) =>
        invokeProjectQuery(() => projectCtx.projectTypes(types, opts)),
      isAssignableTo: (pairs) =>
        invokeProjectQuery(() => projectCtx.isAssignableTo(pairs)),
      syntaxOf: (targets, opts) =>
        invokeProjectQuery(() => projectCtx.syntaxOf(targets, opts)),
      callersOf: (declarations, opts) =>
        invokeProjectQuery(() => projectCtx.callersOf(declarations, opts)),
      calleesOf: (calls) =>
        invokeProjectQuery(() => projectCtx.calleesOf(calls)),
      resolveImplementations: (targets) =>
        invokeProjectQuery(() => projectCtx.resolveImplementations(targets)),
      valuePropagation: (opts) =>
        invokeProjectQuery(() => projectCtx.valuePropagation(opts)),
      resolveInstances: (targets, opts) =>
        invokeProjectQuery(() => projectCtx.resolveInstances(targets, opts)),
      projectInstances: (instances, opts) =>
        invokeProjectQuery(() => projectCtx.projectInstances(instances, opts)),
      callEffects: (opts) =>
        invokeProjectQuery(() => projectCtx.callEffects(opts)),
      instanceCleanup: (opts) =>
        invokeProjectQuery(() => projectCtx.instanceCleanup(opts)),
      facts: (factType, opts) =>
        invokeProjectQuery(() => projectCtx.facts(factType, opts)),
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
          projectId: projectCtx.project.projectId,
          at: input.at,
          message: input.message,
          ...(input.findingKey !== undefined
            ? { findingKey: input.findingKey }
            : {}),
          evidence: extractBasisEvidence(input.basis),
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
          projectId: projectCtx.project.projectId,
          name,
          outcome,
          resolveLocation: () => resolveCheckpointLocation(target),
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

    const configuredAdaptersById = new Map<
      string,
      { readonly id: string; readonly factTypeIds: readonly string[] }
    >();
    for (const adapter of normalizedConfig.adapters) {
      configuredAdaptersById.set(adapter.id, {
        id: adapter.id,
        factTypeIds: adapter.provides.map((provider) => provider.factType.id),
      });
    }
    for (const native of tssaeSession.nativeAdapters) {
      if (!configuredAdaptersById.has(native.providerId)) {
        configuredAdaptersById.set(native.providerId, {
          id: native.providerId,
          factTypeIds: [],
        });
      }
    }

    const collector = new ObservationCollector({
      mode: effectiveObserve.mode,
      ...(effectiveObserve.limit !== undefined
        ? { limit: effectiveObserve.limit }
        : {}),
      nativeAdapters: tssaeSession.nativeAdapters,
      configuredAdapters: [...configuredAdaptersById.values()],
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

    const currentSnapshotId = tssaeSession.snapshotId;
    for (const project of tssaeSession.projects) {
      for (const rule of rules) {
        let ruleEngineMs = 0;
        const ruleStart = collector.isObserveEnabled() ? performance.now() : 0;
        const observer: QueryObserver = {
          onGaps: (gaps) => {
            collectedGaps.push(...gaps);
            collector.recordRuleGaps(rule.id, gaps);
          },
          ...(collector.isObserveEnabled()
            ? {
                observe: effectiveObserve,
                onRpcMetrics: (io) => collector.recordRpcCall(io),
              }
            : {}),
          ...(explainTarget !== undefined ? { explainTarget } : {}),
          ...(collector.isActive()
            ? {
                onQueryCompleted: (event) => {
                  if (event.cacheStatus === "computed") {
                    collector.addEngineQueryMs(event.durationMs);
                    ruleEngineMs += event.durationMs;
                  }
                  collector.recordQuery({
                    ruleId: rule.id,
                    op: event.op,
                    projectId: event.projectId,
                    provider: event.provider,
                    ...(event.providers !== undefined
                      ? { providers: event.providers }
                      : {}),
                    cacheStatus: event.cacheStatus,
                    candidateCount: event.candidateCount,
                    durationMs: event.durationMs,
                    summary: event.summary,
                    ...(event.matchedLocations !== undefined
                      ? { matchedLocations: event.matchedLocations }
                      : {}),
                    ...(event.detail !== undefined
                      ? { detail: event.detail }
                      : {}),
                  });
                },
              }
            : {}),
          ...(collector.isExplainEnabled()
            ? {
                onFactExplain: (event) => {
                  collector.recordFactExplain({
                    ruleId: rule.id,
                    ...(event.subjectLocation !== undefined
                      ? { subjectLocation: event.subjectLocation }
                      : {}),
                    gaps: event.gaps,
                    localGaps: event.localGaps,
                  });
                },
                onProviderEvaluation: (evaluation) => {
                  collector.recordProviderEvaluation({
                    ruleId: rule.id,
                    evaluation,
                  });
                },
                onCleanupCovered: (event) => {
                  collector.recordCleanupPaths({
                    ruleId: rule.id,
                    targetLocations: event.targetLocations,
                    paths: event.paths,
                  });
                },
              }
            : {}),
        };

        const projectCtx = invokeProjectSync(() =>
          tssaeSession.project(project, { observer }),
        );
        const ctx = createRuleContext(
          rule.id,
          projectCtx,
          currentSnapshotId,
          collected,
          collector,
          runRegistrar,
        );
        try {
          await rule.run(ctx);
        } catch (err) {
          if (err instanceof VeruleExecutionError) {
            throw err;
          }
          const mapped = toVeruleError(err, "RULE_EXECUTION_ERROR");
          if (mapped.code !== "RULE_EXECUTION_ERROR" || err !== mapped.cause) {
            // Preserve TssaeError codes/details while wrapping generic JS rule throws with rule context.
            if (
              err instanceof Error &&
              (err.name === "TssaeError" || "code" in err)
            ) {
              throw mapped;
            }
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

    const scannedComments = await invokeProjectQuery(() =>
      tssaeSession.scanComments(
        collector.isObserveEnabled()
          ? {
              observe: effectiveObserve,
              onRpcMetrics: (io) => collector.recordRpcCall(io),
            }
          : undefined,
      ),
    );
    const scannedDirectives = parseInlineIgnoreDirectives(scannedComments);
    const settlement = resolveInlineIgnores({
      directives: scannedDirectives,
      collected,
      projects: tssaeSession.projects,
      configuredRuleIds: new Set(baseRules.map((rule) => rule.id)),
      executedRuleIds: new Set(rules.map((rule) => rule.id)),
      isPartialRuleSelection:
        runOptions?.ruleIds !== undefined && runOptions.ruleIds.length > 0,
    });

    const diagnostics = buildDiagnostics(settlement.diagnostics);
    const gaps = buildGaps(collectedGaps);
    syncNonConfigEntries(runRegistry, tssaeSession.additionalInputs);
    const additionalInputs = runRegistry.listAdditionalInputs();
    if (!runOptions?.ruleIds && !runOptions?.rulesOverride) {
      lastRuleRegistrations = runRuleRegistrations;
      sessionRegistry = buildSessionRegistry(
        normalizedConfig.additionalInputs,
        explicitRegistrations,
        lastRuleRegistrations,
        tssaeSession.additionalInputs,
      );
    } else {
      syncNonConfigEntries(sessionRegistry, tssaeSession.additionalInputs);
    }

    const observation = collector.buildObservationReport();
    const explanations = explainTarget
      ? rules.map((rule) =>
          collector.buildExplainResult({
            ruleId: rule.id,
            projects: tssaeSession.projects,
            diagnostics,
            suppressions: settlement.suppressions,
          }),
        )
      : undefined;

    return {
      reportVersion: REPORT_SCHEMA_VERSION,
      status: diagnostics.length > 0 ? "findings" : "clean",
      projects: tssaeSession.projects,
      fileOrigins: tssaeSession.fileOrigins,
      additionalInputs,
      diagnostics,
      gaps,
      identity: computeReportIdentity(
        tssaeSession.snapshotDigest,
        resolveProjectEntries(normalizedConfig),
        rules,
        normalizedConfig.models,
        normalizedConfig.additionalInputs,
        normalizedConfig.adapters,
        normalizedConfig.adapterPackages,
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

  const analysisSession: AnalysisSession = {
    get snapshotId() {
      return tssaeSession.snapshotId;
    },
    get projects() {
      return tssaeSession.projects;
    },
    get fileOrigins() {
      return tssaeSession.fileOrigins;
    },
    get additionalInputs(): readonly AdditionalInputEntry[] {
      return sessionRegistry.listAdditionalInputs();
    },
    get memory() {
      return tssaeSession.memory;
    },
    registerAdditionalInput: (
      filePath: string,
      source: AdditionalInputSource,
    ) => {
      assertOpen();
      const entry = invokeProjectSync(() =>
        tssaeSession.registerAdditionalInput(filePath, source),
      );
      explicitRegistrations.push({ filePath, source });
      return sessionRegistry.registerAdditionalInput(filePath, source) ?? entry;
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
      const nextAdapterResolutionRoot = resolve(
        updateOptions?.adapterResolutionRoot ?? adapterResolutionRoot,
      );
      const nextEntries = resolveProjectEntries(nextConfig);
      const prevIdentity = computeReportIdentity(
        "",
        resolveProjectEntries(normalizedConfig),
        normalizedConfig.rules,
        normalizedConfig.models,
        normalizedConfig.additionalInputs,
        normalizedConfig.adapters,
        normalizedConfig.adapterPackages,
      );
      const nextIdentity = computeReportIdentity(
        "",
        nextEntries,
        nextConfig.rules,
        nextConfig.models,
        nextConfig.additionalInputs,
        nextConfig.adapters,
        nextConfig.adapterPackages,
      );

      const tssaeUpdate = await invokeProjectQuery(() =>
        tssaeSession.update({
          ...(updateOptions?.changed !== undefined
            ? { changed: updateOptions.changed }
            : {}),
          ...(updateOptions?.created !== undefined
            ? { created: updateOptions.created }
            : {}),
          ...(updateOptions?.deleted !== undefined
            ? { deleted: updateOptions.deleted }
            : {}),
          adapterResolutionRoot: nextAdapterResolutionRoot,
          entries: nextEntries,
          models: nextConfig.models,
          adapters: [...nextConfig.adapters, ...nextConfig.adapterPackages],
          additionalInputs: nextConfig.additionalInputs,
        }),
      );

      const invalidatedReasons = [...tssaeUpdate.recomputation.invalidatedBy];
      const existingReasons = new Set(invalidatedReasons);
      const changedSet = new Set(updateOptions?.changed ?? []);
      for (const file of changedAdditionalFiles) {
        const marker = `additional-input:${file}`;
        if (!changedSet.has(file) && !existingReasons.has(marker)) {
          invalidatedReasons.push(marker);
          existingReasons.add(marker);
        }
      }
      if (
        stableSerialize(prevIdentity.rules) !==
          stableSerialize(nextIdentity.rules) &&
        !existingReasons.has("rules")
      ) {
        invalidatedReasons.push("rules");
        existingReasons.add("rules");
      }
      if (
        updateOptions?.config !== undefined &&
        invalidatedReasons.length === 0
      ) {
        invalidatedReasons.push("config");
      }

      normalizedConfig = nextConfig;
      adapterResolutionRoot = nextAdapterResolutionRoot;
      workspaceFileState.files = tssaeUpdate.workspaceSourceFiles;
      sessionRegistry = buildSessionRegistry(
        nextConfig.additionalInputs,
        explicitRegistrations,
        lastRuleRegistrations,
        tssaeSession.additionalInputs,
      );

      const recomputation: RecomputationScope = {
        ...tssaeUpdate.recomputation,
        invalidatedBy: invalidatedReasons,
      };

      return {
        previousSnapshotId: tssaeUpdate.previousSnapshotId,
        snapshotId: tssaeUpdate.snapshotId,
        projects: tssaeUpdate.projects,
        fileOrigins: tssaeUpdate.fileOrigins,
        additionalInputs: sessionRegistry.listAdditionalInputs(),
        recomputation,
        memory: tssaeUpdate.memory,
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
      await tssaeSession.close();
    },
  };
  sessionWorkspaceFileStates.set(analysisSession, workspaceFileState);
  return analysisSession;
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
