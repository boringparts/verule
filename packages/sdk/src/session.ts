import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { EngineClient } from "./engine-client.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  getRefSessionToken,
  makeProgramRef,
  type AnalysisSession,
  type CheckReport,
  type Diagnostic,
  type DiagnosticInput,
  type DiagnosticLocation,
  type Evidence,
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
): SyntaxNodeResult {
  return {
    ref: makeProgramRef(
      "syntax",
      sessionToken,
      projectId,
      snapshotId,
      item.ref,
    ),
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

  const client = new EngineClient();
  let openResult: EngineOpenResult;
  try {
    openResult = await client.request<EngineOpenResult>("snapshot.open", {
      cwd: absCwd,
      entries: initialEntries,
    });
  } catch (err) {
    await client.close();
    throw err;
  }

  const sessionToken = Symbol("verule-session");
  let currentSnapshotId = openResult.snapshotId;
  let currentSnapshotDigest = openResult.snapshotDigest;
  let currentProjects = openResult.projects;
  let lastEngineRssBytes = openResult.engineRssBytes;
  let closed = false;

  const syntaxCache = new Map<string, Promise<readonly SyntaxNodeResult[]>>();
  const typeCache = new Map<string, Promise<TypeAtResult>>();

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
  ): RuleContext {
    const activeSnapshotId = currentSnapshotId;
    return {
      project,
      models,
      getModel: (id: string) => models.find((model) => model.id === id),
      findSyntax: (query: FindSyntaxOptions) => {
        assertOpen();
        const cacheKey = JSON.stringify([
          activeSnapshotId,
          project.projectId,
          query.kinds.toSorted(),
          query.files ? query.files.toSorted() : null,
        ]);
        const cached = syntaxCache.get(cacheKey);
        if (cached) return cached;

        const promise = client
          .request<EngineBatchResult>("query.batch", {
            snapshotId: activeSnapshotId,
            projectId: project.projectId,
            steps: [
              {
                op: "findSyntax",
                kinds: query.kinds,
                ...(query.files !== undefined ? { files: query.files } : {}),
              },
            ],
          })
          .then((batch) => {
            const items = (batch.results[0]?.items ??
              []) as readonly EngineSyntaxItem[];
            return items.map((item) =>
              toSyntaxNodeResult(
                item,
                sessionToken,
                project.projectId,
                activeSnapshotId,
              ),
            );
          });

        syntaxCache.set(cacheKey, promise);
        return promise;
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

        return Promise.all(
          targets.map((target) =>
            typeCache.get(
              `${activeSnapshotId}:${project.projectId}:${target.handleId}`,
            )!,
          ),
        );
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
    check: async (rulesOverride?: readonly Rule[]) => {
      assertOpen();
      const rules = rulesOverride
        ? validateRules(rulesOverride)
        : normalizedConfig.rules;
      const models = normalizedConfig.models;
      const collected: CollectedDiagnostic[] = [];

      for (const project of currentProjects) {
        for (const rule of rules) {
          const ctx = createRuleContext(rule.id, project, models, collected);
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
          }
        }
      }

      const diagnostics = buildDiagnostics(collected);
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
          models,
        ),
      };
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
    return await session.check();
  } finally {
    await session.close();
  }
}
