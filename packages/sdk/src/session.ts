import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { performance } from "node:perf_hooks";

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
  type Gap,
  type NormalizedVeruleConfig,
  type OpenSessionOptions,
  type ProjectSummary,
  type Rule,
  type RuleContext,
  type RunCheckOptions,
  type SessionCheckOptions,
  type SyntaxKind,
  type SyntaxNodeResult,
  type SyntaxRef,
  type TypeAtResult,
  type VeruleConfig,
} from "./types.ts";

type EngineOpenResult = {
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
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
  return {
    ...(config.tsconfig !== undefined ? { tsconfig: config.tsconfig } : {}),
    ...(config.projects !== undefined
      ? { projects: [...config.projects] }
      : {}),
    rules,
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

function buildGaps(collected: readonly Gap[]): readonly Gap[] {
  const unique = new Map<string, Gap>();
  for (const gap of collected) {
    const key = JSON.stringify([
      gap.kind,
      gap.message,
      gap.at !== undefined ? canonicalLocationKey(gap.at) : null,
    ]);
    if (!unique.has(key)) {
      unique.set(key, gap);
    }
  }
  return [...unique.values()].toSorted((a, b) => {
    if (a.at && b.at) {
      const locCmp = compareLocations(a.at, b.at);
      if (locCmp !== 0) return locCmp;
    } else if (a.at || b.at) {
      return a.at ? -1 : 1;
    }
    const kindCmp = a.kind.localeCompare(b.kind);
    if (kindCmp !== 0) return kindCmp;
    return a.message.localeCompare(b.message);
  });
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
  const normalizedConfig = options.config
    ? defineConfig(options.config)
    : defineConfig({});
  const entries = resolveEntries(normalizedConfig);
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
        entries,
      },
      openRpcOptions,
    );
  } catch (err) {
    await client.close();
    throw err;
  }
  const openDurationMs = performance.now() - openStart;

  const sessionToken = Symbol("verule-session");
  const snapshotId = openResult.snapshotId;
  const projects = openResult.projects;
  let closed = false;
  let pendingOpenIoMetrics = openIoMetrics;
  let pendingOpenDurationMs = openDurationMs;
  let pendingConfigLoadMs = options.configLoadMs ?? 0;

  const syntaxCache = new Map<string, Promise<readonly SyntaxNodeResult[]>>();
  const typeCache = new Map<string, Promise<TypeAtResult>>();
  const branchListCache = new Map<string, Promise<FunctionBranchesResult>>();
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
    collected: CollectedDiagnostic[],
    collectedGaps: Gap[],
    collector: ObservationCollector,
    recordRuleEngineMs: (ms: number) => void,
  ): RuleContext {
    return {
      project,
      findSyntax: async (query: FindSyntaxOptions) => {
        assertOpen();
        const cacheKey = JSON.stringify([
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
                snapshotId,
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
                  snapshotId,
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
          assertValidProgramRef(
            target,
            sessionToken,
            snapshotId,
            project.projectId,
          );
        }

        const missingTargets: SyntaxRef[] = [];
        for (const target of targets) {
          const key = `${project.projectId}:${target.handleId}`;
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
              snapshotId,
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
            const key = `${project.projectId}:${target.handleId}`;
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
                snapshotId,
              );
            });
            typeCache.set(key, itemPromise);
          }
        }

        const results = await Promise.all(
          targets.map((target) =>
            typeCache.get(`${project.projectId}:${target.handleId}`)!,
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
      listBranches: async (functions: readonly SyntaxRef[]) => {
        assertOpen();
        if (functions.length === 0) return [];

        for (const fnRef of functions) {
          assertValidProgramRef(
            fnRef,
            sessionToken,
            snapshotId,
            project.projectId,
          );
        }

        const queryStart = collector.isActive() ? performance.now() : 0;
        const missingFunctions: SyntaxRef[] = [];
        for (const fnRef of functions) {
          const key = `${project.projectId}:${fnRef.handleId}`;
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
              snapshotId,
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
            const key = `${project.projectId}:${fnRef.handleId}`;
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
                snapshotId,
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
            branchListCache.get(`${project.projectId}:${fnRef.handleId}`)!,
          ),
        );

        if (collector.isActive()) {
          const durationMs = performance.now() - queryStart;
          if (cacheStatus === "computed") {
            collector.addEngineQueryMs(durationMs);
            recordRuleEngineMs(durationMs);
          }
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

        return results;
      },
      branchCoverage: async (query: BranchCoverageOptions) => {
        assertOpen();
        if (query.function !== undefined) {
          assertValidProgramRef(
            query.function,
            sessionToken,
            snapshotId,
            project.projectId,
          );
        }
        for (const branchRef of query.branches) {
          assertValidProgramRef(
            branchRef,
            sessionToken,
            snapshotId,
            project.projectId,
          );
        }
        for (const targetRef of query.targets) {
          assertValidProgramRef(
            targetRef,
            sessionToken,
            snapshotId,
            project.projectId,
          );
        }
        if (query.targets.length === 0) return [];

        const queryStart = collector.isActive() ? performance.now() : 0;
        const batch = await client.request<EngineBatchResult>(
          "query.batch",
          {
            snapshotId,
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
    const collectedGaps: Gap[] = [];
    for (const project of projects) {
      for (const rule of rules) {
        let ruleEngineMs = 0;
        const ruleStart = collector.isObserveEnabled() ? performance.now() : 0;
        const ctx = createRuleContext(
          rule.id,
          project,
          collected,
          collectedGaps,
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
    const gaps = buildGaps(collectedGaps);
    const observation = collector.buildObservationReport();
    const explanations = explainTarget
      ? rules.map((rule) =>
          collector.buildExplainResult({
            ruleId: rule.id,
            projects,
            diagnostics,
          }),
        )
      : undefined;

    return {
      reportVersion: REPORT_SCHEMA_VERSION,
      status: diagnostics.length > 0 ? "findings" : "clean",
      projects,
      diagnostics,
      gaps,
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
    snapshotId,
    projects,
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
      try {
        await client.request("snapshot.release", { snapshotId });
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
