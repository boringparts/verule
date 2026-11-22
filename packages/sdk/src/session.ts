import { createHash } from "node:crypto";
import { resolve } from "node:path";

import { EngineClient } from "./engine-client.ts";
import { createProjectionQueries, validateProgramRefs } from "./projection.ts";
import {
  REPORT_SCHEMA_VERSION,
  VeruleExecutionError,
  makeProgramRef,
  type AnalysisSession,
  type CheckReport,
  type Diagnostic,
  type DiagnosticInput,
  type DiagnosticLocation,
  type Evidence,
  type FindSyntaxOptions,
  type Gap,
  type NormalizedVeruleConfig,
  type OpenSessionOptions,
  type ProjectSummary,
  type Rule,
  type RuleContext,
  type RunCheckOptions,
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

  const client = new EngineClient();
  let openResult: EngineOpenResult;
  try {
    openResult = await client.request<EngineOpenResult>("snapshot.open", {
      cwd: absCwd,
      entries,
    });
  } catch (err) {
    await client.close();
    throw err;
  }

  const sessionToken = Symbol("verule-session");
  const snapshotId = openResult.snapshotId;
  const projects = openResult.projects;
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

  function buildGaps(collectedGaps: readonly Gap[]): readonly Gap[] {
    const seen = new Set<string>();
    const unique: Gap[] = [];
    for (const gap of collectedGaps) {
      const key = JSON.stringify([
        gap.kind,
        gap.message,
        gap.at !== undefined ? canonicalLocationKey(gap.at) : null,
      ]);
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(gap);
      }
    }
    return unique;
  }

  function createRuleContext(
    ruleId: string,
    project: ProjectSummary,
    collected: CollectedDiagnostic[],
    collectedGaps: Gap[],
  ): RuleContext {
    const recordGaps = (gaps: readonly Gap[]): void => {
      for (const gap of gaps) {
        collectedGaps.push(gap);
      }
    };

    const projectionQueries = createProjectionQueries({
      client,
      sessionToken,
      snapshotId,
      projectId: project.projectId,
      assertOpen,
      recordGaps,
    });

    return {
      project,
      ...projectionQueries,
      findSyntax: (query: FindSyntaxOptions) => {
        assertOpen();
        const cacheKey = JSON.stringify([
          project.projectId,
          query.kinds ? query.kinds.toSorted() : null,
          query.files ? query.files.toSorted() : null,
          query.range ?? null,
        ]);
        const cached = syntaxCache.get(cacheKey);
        if (cached) return cached;

        const promise = client
          .request<EngineBatchResult>("query.batch", {
            snapshotId,
            projectId: project.projectId,
            steps: [
              {
                op: "findSyntax",
                ...(query.kinds !== undefined ? { kinds: query.kinds } : {}),
                ...(query.files !== undefined ? { files: query.files } : {}),
                ...(query.range !== undefined ? { range: query.range } : {}),
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
                snapshotId,
              ),
            );
          });

        syntaxCache.set(cacheKey, promise);
        return promise;
      },
      typeAt: async (targets: readonly SyntaxRef[]) => {
        assertOpen();
        if (targets.length === 0) return [];
        validateProgramRefs(
          targets,
          sessionToken,
          snapshotId,
          project.projectId,
        );

        const missingTargets: SyntaxRef[] = [];
        for (const target of targets) {
          const key = `${project.projectId}:${target.handleId}`;
          if (!typeCache.has(key)) {
            missingTargets.push(target);
          }
        }

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
              if (raw.gaps) {
                recordGaps(raw.gaps);
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

        return Promise.all(
          targets.map((target) =>
            typeCache.get(`${project.projectId}:${target.handleId}`)!,
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
    snapshotId,
    projects,
    check: async (rulesOverride?: readonly Rule[]) => {
      assertOpen();
      const rules = rulesOverride
        ? validateRules(rulesOverride)
        : normalizedConfig.rules;
      const collected: CollectedDiagnostic[] = [];
      const collectedGaps: Gap[] = [];

      for (const project of projects) {
        for (const rule of rules) {
          const ctx = createRuleContext(
            rule.id,
            project,
            collected,
            collectedGaps,
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
          }
        }
      }

      const diagnostics = buildDiagnostics(collected);
      const gaps = buildGaps(collectedGaps);
      return {
        reportVersion: REPORT_SCHEMA_VERSION,
        status: diagnostics.length > 0 ? "findings" : "clean",
        projects,
        diagnostics,
        gaps,
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
    return await session.check();
  } finally {
    await session.close();
  }
}
