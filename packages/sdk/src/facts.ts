import { performance } from "node:perf_hooks";

import type { ObservationCollector } from "./observation.ts";
import { locationMatchesTarget } from "./observation.ts";
import { validateProgramRefs } from "./projection.ts";
import {
  VeruleExecutionError,
  type DiagnosticLocation,
  type Evidence,
  type FactConflictDetails,
  type FactConflictParty,
  type Gap,
  type Model,
  type ProgramObjectKind,
  type ProgramRef,
  type ProjectSummary,
  type RuleContext,
  type SyntaxRef,
} from "./types.ts";

declare const factSubjectBrand: unique symbol;
declare const factConditionBrand: unique symbol;
declare const factValueBrand: unique symbol;

/** Contribution passed to `FactType.merge` for combining multi-provider facts. */
export type FactProviderContribution<Value = unknown> = {
  readonly providerId: string;
  readonly providers: readonly string[];
  readonly value: Value;
  readonly evidence: readonly Evidence[];
  readonly gaps: readonly Gap[];
};

/** Outcome of merging two provider contributions for the same `(snapshot, project, subject, condition)`. */
export type FactMergeOutcome<Value = unknown> =
  | {
      readonly ok: true;
      readonly value: Value;
    }
  | {
      readonly ok: false;
      readonly conflict: {
        readonly message: string;
        readonly existingConclusion?: string;
        readonly incomingConclusion?: string;
        readonly existingEvidence?: readonly Evidence[];
        readonly incomingEvidence?: readonly Evidence[];
      };
    };

/** Specification passed to `defineFactType`. */
export type FactTypeSpec<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Condition = unknown,
  Value = unknown,
> = {
  readonly id: string;
  readonly description?: string;
  readonly subjectKind: SubjectKind | readonly SubjectKind[];
  readonly [factConditionBrand]?: Condition;
  merge?(
    existing: FactProviderContribution<Value>,
    incoming: FactProviderContribution<Value>,
  ): FactMergeOutcome<Value>;
};

/** Typed definition of a queryable program fact shared between adapters and rules. */
export type FactType<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Condition = unknown,
  Value = unknown,
> = {
  readonly id: string;
  readonly description?: string;
  readonly subjectKind: SubjectKind | readonly SubjectKind[];
  readonly [factSubjectBrand]?: SubjectKind;
  readonly [factConditionBrand]?: Condition;
  readonly [factValueBrand]?: Value;
  merge?(
    existing: FactProviderContribution<Value>,
    incoming: FactProviderContribution<Value>,
  ): FactMergeOutcome<Value>;
};

/** Options passed to `RuleContext.facts`. */
export type FactQueryOptions<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Condition = unknown,
> = {
  readonly targets?: readonly ProgramRef<SubjectKind>[];
  readonly providerId?: string;
  readonly condition?: Condition;
};

/** Snapshot-bound fact result returned by `RuleContext.facts`. */
export type FactResult<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Value = unknown,
> = {
  readonly factTypeId: string;
  readonly projectId: string;
  readonly snapshotId: number;
  readonly subject: ProgramRef<SubjectKind>;
  readonly value: Value;
  readonly evidence: readonly Evidence[];
  readonly gaps: readonly Gap[];
  readonly providers: readonly string[];
};

/** Options passed to `AdapterContext.extractEngineFacts`. */
export type EngineFactExtractionOptions<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Condition = unknown,
> = {
  readonly factTypeId: string;
  readonly providerId: string;
  readonly reportProviderId?: string;
  readonly targets?: readonly ProgramRef<SubjectKind>[];
  readonly condition?: Condition;
};

/** Read-only query context exposed to TypeScript `LibraryAdapter` providers. */
export type AdapterContext = {
  readonly project: ProjectSummary;
  readonly models: readonly Model[];
  getModel: (id: string) => Model | undefined;
  findSyntax: RuleContext["findSyntax"];
  typeAt: RuleContext["typeAt"];
  listBranches: RuleContext["listBranches"];
  branchCoverage: RuleContext["branchCoverage"];
  resolveDeclarations: RuleContext["resolveDeclarations"];
  resolveCalls: RuleContext["resolveCalls"];
  projectCalls: RuleContext["projectCalls"];
  projectSignatures: RuleContext["projectSignatures"];
  projectTypes: RuleContext["projectTypes"];
  isAssignableTo: RuleContext["isAssignableTo"];
  syntaxOf: RuleContext["syntaxOf"];
  callersOf: RuleContext["callersOf"];
  calleesOf: RuleContext["calleesOf"];
  resolveImplementations: RuleContext["resolveImplementations"];
  valuePropagation: RuleContext["valuePropagation"];
  callEffects: RuleContext["callEffects"];
  instanceCleanup: RuleContext["instanceCleanup"];
  /** Invokes an engine-internal built-in fact provider on the active project snapshot. */
  extractEngineFacts: <
    SubjectKind extends ProgramObjectKind,
    Condition = unknown,
    Value = unknown,
  >(
    options: EngineFactExtractionOptions<SubjectKind, Condition>,
  ) => Promise<readonly FactContribution<SubjectKind, Value>[]>;
  /** Registers a local non-source file read by this adapter as an additional input. */
  registerAdditionalInput: RuleContext["registerAdditionalInput"];
  /** Registers a local non-source file as an additional input and reads its UTF-8 content. */
  readAdditionalInput: RuleContext["readAdditionalInput"];
};

/** Request passed to a `FactProvider.extract` implementation. */
export type FactExtractionRequest<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Condition = unknown,
> = {
  readonly factType: FactType<SubjectKind, Condition>;
  readonly targets?: readonly ProgramRef<SubjectKind>[];
  readonly condition?: Condition;
};

/** Single subject contribution returned by a `FactProvider.extract` call. */
export type FactContribution<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Value = unknown,
> = {
  readonly subject: ProgramRef<SubjectKind>;
  readonly value: Value;
  readonly evidence?: readonly Evidence[];
  readonly gaps?: readonly Gap[];
};

/** Provider implementation for one `FactType` inside a `LibraryAdapter`. */
export interface FactProvider<
  SubjectKind extends ProgramObjectKind = ProgramObjectKind,
  Condition = unknown,
  Value = unknown,
> {
  readonly factType: FactType<SubjectKind, Condition, Value>;
  extract(
    ctx: AdapterContext,
    request: FactExtractionRequest<SubjectKind, Condition>,
  ):
    | readonly FactContribution<SubjectKind, Value>[]
    | Promise<readonly FactContribution<SubjectKind, Value>[]>;
}

/** Optional library adapter registered in `VeruleConfig.adapters`. */
export type LibraryAdapter = {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly provides: readonly FactProvider[];
};

/** Defines a typed `FactType` contract that multiple adapters can implement. */
export function defineFactType<
  SubjectKind extends ProgramObjectKind,
  Condition = undefined,
  Value = unknown,
>(
  spec: FactTypeSpec<SubjectKind, Condition, Value>,
): FactType<SubjectKind, Condition, Value> {
  if (typeof spec.id !== "string" || spec.id.trim() === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "FactType id must be a non-empty string.",
    );
  }
  const kinds = Array.isArray(spec.subjectKind)
    ? spec.subjectKind
    : [spec.subjectKind];
  if (kinds.length === 0) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `FactType "${spec.id}" must specify at least one subjectKind.`,
    );
  }
  return {
    id: spec.id,
    ...(spec.description !== undefined
      ? { description: spec.description }
      : {}),
    subjectKind: Array.isArray(spec.subjectKind)
      ? [...spec.subjectKind]
      : spec.subjectKind,
    ...(spec.merge !== undefined
      ? {
          merge: (
            existing: FactProviderContribution<Value>,
            incoming: FactProviderContribution<Value>,
          ) => spec.merge!(existing, incoming),
        }
      : {}),
  };
}

/** Helper for defining a strongly typed `FactProvider` entry for `defineAdapter`. */
export function defineFactProvider<
  SubjectKind extends ProgramObjectKind,
  Condition,
  Value,
>(
  factType: FactType<SubjectKind, Condition, Value>,
  extract: (
    ctx: AdapterContext,
    request: FactExtractionRequest<NoInfer<SubjectKind>, NoInfer<Condition>>,
  ) =>
    | readonly FactContribution<NoInfer<SubjectKind>, NoInfer<Value>>[]
    | Promise<
        readonly FactContribution<NoInfer<SubjectKind>, NoInfer<Value>>[]
      >,
): FactProvider<SubjectKind, Condition, Value> {
  return {
    factType,
    extract,
  };
}

/** Validates and normalizes a `LibraryAdapter` definition. */
export function defineAdapter(adapter: LibraryAdapter): LibraryAdapter {
  if (typeof adapter.id !== "string" || adapter.id.trim() === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "LibraryAdapter id must be a non-empty string.",
    );
  }
  if (adapter.version !== undefined && typeof adapter.version !== "string") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `LibraryAdapter "${adapter.id}" version must be a string when provided.`,
    );
  }
  if (!Array.isArray(adapter.provides)) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `LibraryAdapter "${adapter.id}" must specify a provides array.`,
    );
  }
  const seenFactIds = new Set<string>();
  for (const provider of adapter.provides) {
    if (
      typeof provider.factType?.id !== "string" ||
      provider.factType.id.trim() === ""
    ) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `LibraryAdapter "${adapter.id}" contains a provider with an invalid factType.`,
      );
    }
    if (seenFactIds.has(provider.factType.id)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `LibraryAdapter "${adapter.id}" declares duplicate provider for factType "${provider.factType.id}".`,
      );
    }
    if (typeof provider.extract !== "function") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `LibraryAdapter "${adapter.id}" provider for "${provider.factType.id}" must provide an extract function.`,
      );
    }
    seenFactIds.add(provider.factType.id);
  }
  return {
    id: adapter.id,
    ...(adapter.version !== undefined ? { version: adapter.version } : {}),
    ...(adapter.description !== undefined
      ? { description: adapter.description }
      : {}),
    provides: [...adapter.provides],
  };
}

/** Validates configured adapters and rejects duplicate adapter IDs. */
export function validateAdapters(
  adapters: readonly LibraryAdapter[],
): readonly LibraryAdapter[] {
  const seen = new Set<string>();
  const normalized: LibraryAdapter[] = [];
  for (const raw of adapters) {
    const adapter = defineAdapter(raw);
    if (seen.has(adapter.id)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Duplicate adapter id: "${adapter.id}".`,
      );
    }
    seen.add(adapter.id);
    normalized.push(adapter);
  }
  return normalized;
}

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function stableSerializeValue(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableSerializeValue(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted(compareCodepoint);
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableSerializeValue(record[key])}`)
    .join(",")}}`;
}

function formatEvidenceList(evidence: readonly Evidence[]): string {
  if (evidence.length === 0) return "none";
  return evidence
    .map((item) => {
      const loc = item.at
        ? ` (${item.at.file}:${item.at.line}:${item.at.column})`
        : "";
      return `${item.message}${loc}`;
    })
    .join("; ");
}

function dedupeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of items) {
    const key = stableSerializeValue(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function dedupeGaps(items: readonly Gap[]): readonly Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const item of items) {
    const key = stableSerializeValue(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

type ProviderEntry = {
  readonly adapterId: string;
  readonly provider: FactProvider;
};

type SubjectAccumulator<SubjectKind extends ProgramObjectKind, Value> = {
  readonly subject: ProgramRef<SubjectKind>;
  providerId: string;
  providers: string[];
  value: Value;
  evidence: Evidence[];
  gaps: Gap[];
};

function buildFactConflictError<
  SubjectKind extends ProgramObjectKind,
  Value,
>(params: {
  readonly factTypeId: string;
  readonly projectId: string;
  readonly snapshotId: number;
  readonly subject: ProgramRef<SubjectKind>;
  readonly condition: unknown;
  readonly syntaxLocations: WeakMap<SyntaxRef, DiagnosticLocation>;
  readonly reason: string;
  readonly existingProviders: readonly string[];
  readonly existingValue: Value;
  readonly existingConclusionSummary?: string;
  readonly existingEvidence: readonly Evidence[];
  readonly incomingProviderId: string;
  readonly incomingValue: Value;
  readonly incomingConclusionSummary?: string;
  readonly incomingEvidence: readonly Evidence[];
}): VeruleExecutionError {
  const existingProviders = [...new Set(params.existingProviders)].toSorted(
    compareCodepoint,
  );
  const partyA: FactConflictParty = {
    providerId: existingProviders.join(","),
    providers: existingProviders,
    conclusion: params.existingValue,
    conclusionSummary:
      params.existingConclusionSummary ??
      stableSerializeValue(params.existingValue),
    evidence: dedupeEvidence(params.existingEvidence),
  };
  const partyB: FactConflictParty = {
    providerId: params.incomingProviderId,
    providers: [params.incomingProviderId],
    conclusion: params.incomingValue,
    conclusionSummary:
      params.incomingConclusionSummary ??
      stableSerializeValue(params.incomingValue),
    evidence: dedupeEvidence(params.incomingEvidence),
  };
  const parties: readonly [FactConflictParty, FactConflictParty] =
    compareCodepoint(partyA.providerId, partyB.providerId) <= 0
      ? [partyA, partyB]
      : [partyB, partyA];

  const subjectLocation =
    params.syntaxLocations.get(params.subject as SyntaxRef) ??
    parties[0].evidence.find((item) => item.at !== undefined)?.at ??
    parties[1].evidence.find((item) => item.at !== undefined)?.at;

  const conflict: FactConflictDetails = {
    factTypeId: params.factTypeId,
    projectId: params.projectId,
    snapshotId: params.snapshotId,
    subjectHandleId: params.subject.handleId,
    ...(subjectLocation !== undefined ? { subjectLocation } : {}),
    ...(params.condition !== undefined ? { condition: params.condition } : {}),
    reason: params.reason,
    parties,
  };

  const subjectLocSuffix = subjectLocation
    ? ` at ${subjectLocation.file}:${subjectLocation.line}:${subjectLocation.column}`
    : "";
  const message =
    `Fact conflict for "${params.factTypeId}" on "${params.subject.handleId}"${subjectLocSuffix} ` +
    `between [${parties[0].providerId}] and [${parties[1].providerId}]: ${params.reason}. ` +
    `[${parties[0].providerId}] concluded ${parties[0].conclusionSummary} (evidence: ${formatEvidenceList(parties[0].evidence)}). ` +
    `[${parties[1].providerId}] concluded ${parties[1].conclusionSummary} (evidence: ${formatEvidenceList(parties[1].evidence)}).`;

  return new VeruleExecutionError("FACT_CONFLICT", message, { conflict });
}

function mergeContributions<
  SubjectKind extends ProgramObjectKind,
  Condition,
  Value,
>(
  factType: FactType<SubjectKind, Condition, Value>,
  projectId: string,
  snapshotId: number,
  condition: Condition | undefined,
  syntaxLocations: WeakMap<SyntaxRef, DiagnosticLocation>,
  perProvider: readonly {
    readonly adapterId: string;
    readonly contributions: readonly FactContribution<SubjectKind, Value>[];
  }[],
): readonly FactResult<SubjectKind, Value>[] {
  const orderedIds: string[] = [];
  const bySubject = new Map<string, SubjectAccumulator<SubjectKind, Value>>();

  for (const entry of perProvider) {
    // Collapse multiple entries for the same subject within a single provider if any.
    for (const contribution of entry.contributions) {
      const handleId = contribution.subject.handleId;
      const incomingEvidence = [...(contribution.evidence ?? [])];
      const incomingGaps = [...(contribution.gaps ?? [])];
      const existing = bySubject.get(handleId);

      if (!existing) {
        orderedIds.push(handleId);
        bySubject.set(handleId, {
          subject: contribution.subject,
          providerId: entry.adapterId,
          providers: [entry.adapterId],
          value: contribution.value,
          evidence: incomingEvidence,
          gaps: incomingGaps,
        });
        continue;
      }

      if (factType.merge) {
        const outcome = factType.merge(
          {
            providerId: existing.providerId,
            providers: existing.providers,
            value: existing.value,
            evidence: existing.evidence,
            gaps: existing.gaps,
          },
          {
            providerId: entry.adapterId,
            providers: [entry.adapterId],
            value: contribution.value,
            evidence: incomingEvidence,
            gaps: incomingGaps,
          },
        );
        if (!outcome.ok) {
          const existingEv =
            outcome.conflict.existingEvidence ?? existing.evidence;
          const incomingEv =
            outcome.conflict.incomingEvidence ?? incomingEvidence;
          throw buildFactConflictError({
            factTypeId: factType.id,
            projectId,
            snapshotId,
            subject: contribution.subject,
            condition,
            syntaxLocations,
            reason: outcome.conflict.message,
            existingProviders: existing.providers,
            existingValue: existing.value,
            ...(outcome.conflict.existingConclusion !== undefined
              ? {
                  existingConclusionSummary:
                    outcome.conflict.existingConclusion,
                }
              : {}),
            existingEvidence: existingEv,
            incomingProviderId: entry.adapterId,
            incomingValue: contribution.value,
            ...(outcome.conflict.incomingConclusion !== undefined
              ? {
                  incomingConclusionSummary:
                    outcome.conflict.incomingConclusion,
                }
              : {}),
            incomingEvidence: incomingEv,
          });
        }
        existing.value = outcome.value;
        existing.providers = [
          ...new Set([...existing.providers, entry.adapterId]),
        ].toSorted(compareCodepoint);
        existing.providerId = existing.providers.join(",");
        existing.evidence = [
          ...dedupeEvidence([...existing.evidence, ...incomingEvidence]),
        ];
        existing.gaps = [...dedupeGaps([...existing.gaps, ...incomingGaps])];
      } else {
        const existingSerialized = stableSerializeValue(existing.value);
        const incomingSerialized = stableSerializeValue(contribution.value);
        if (existingSerialized !== incomingSerialized) {
          throw buildFactConflictError({
            factTypeId: factType.id,
            projectId,
            snapshotId,
            subject: contribution.subject,
            condition,
            syntaxLocations,
            reason: `providers produced differing definite conclusions (${existingSerialized} vs ${incomingSerialized})`,
            existingProviders: existing.providers,
            existingValue: existing.value,
            existingConclusionSummary: existingSerialized,
            existingEvidence: existing.evidence,
            incomingProviderId: entry.adapterId,
            incomingValue: contribution.value,
            incomingConclusionSummary: incomingSerialized,
            incomingEvidence,
          });
        }
        existing.providers = [
          ...new Set([...existing.providers, entry.adapterId]),
        ].toSorted(compareCodepoint);
        existing.providerId = existing.providers.join(",");
        existing.evidence = [
          ...dedupeEvidence([...existing.evidence, ...incomingEvidence]),
        ];
        existing.gaps = [...dedupeGaps([...existing.gaps, ...incomingGaps])];
      }
    }
  }

  return orderedIds.map((handleId) => {
    const acc = bySubject.get(handleId)!;
    return {
      factTypeId: factType.id,
      projectId,
      snapshotId,
      subject: acc.subject,
      value: acc.value,
      evidence: acc.evidence,
      gaps: acc.gaps,
      providers: acc.providers,
    };
  });
}

export type CachedAdapterAdditionalInput = {
  readonly adapterId: string;
  readonly filePath: string;
};

type CachedFullEntry = {
  readonly results: readonly FactResult[];
  readonly additionalInputs: readonly CachedAdapterAdditionalInput[];
};

type CachedTargetEntry = {
  readonly item: FactResult | null;
  readonly additionalInputs: readonly CachedAdapterAdditionalInput[];
};

/** Per-session cache storing computed fact results across rules for the active snapshot. */
export class FactCache {
  readonly #fullResults = new Map<string, Promise<CachedFullEntry>>();
  readonly #fullLoadedKeys = new Set<string>();
  readonly #targetResults = new Map<string, Promise<CachedTargetEntry>>();

  clear(): void {
    this.#fullResults.clear();
    this.#fullLoadedKeys.clear();
    this.#targetResults.clear();
  }

  hasFull(key: string): boolean {
    return this.#fullResults.has(key);
  }

  getFull(key: string): Promise<CachedFullEntry> | undefined {
    return this.#fullResults.get(key);
  }

  setFull(key: string, promise: Promise<CachedFullEntry>): void {
    this.#fullResults.set(key, promise);
  }

  deleteFull(key: string): void {
    this.#fullResults.delete(key);
    this.#fullLoadedKeys.delete(key);
  }

  markFullLoaded(key: string): void {
    this.#fullLoadedKeys.add(key);
  }

  isFullLoaded(key: string): boolean {
    return this.#fullLoadedKeys.has(key);
  }

  getTarget(
    baseKey: string,
    handleId: string,
  ): Promise<CachedTargetEntry> | undefined {
    return this.#targetResults.get(`${baseKey}::${handleId}`);
  }

  setTarget(
    baseKey: string,
    handleId: string,
    promise: Promise<CachedTargetEntry>,
  ): void {
    this.#targetResults.set(`${baseKey}::${handleId}`, promise);
  }

  deleteTarget(baseKey: string, handleId: string): void {
    this.#targetResults.delete(`${baseKey}::${handleId}`);
  }
}

export async function executeFactQuery<
  SubjectKind extends ProgramObjectKind,
  Condition,
  Value,
>(params: {
  readonly factType: FactType<SubjectKind, Condition, Value>;
  readonly options: FactQueryOptions<SubjectKind, Condition> | undefined;
  readonly adapters: readonly LibraryAdapter[];
  readonly factCache: FactCache;
  readonly sessionToken: symbol;
  readonly snapshotId: number;
  readonly projectId: string;
  readonly ruleId: string;
  readonly assertActiveSnapshot: () => void;
  readonly createAdapterContext: (
    adapterId: string,
    onAdditionalInput: (filePath: string) => void,
  ) => AdapterContext;
  readonly replayAdapterAdditionalInput: (
    adapterId: string,
    filePath: string,
  ) => void;
  readonly recordGaps: (gaps: readonly Gap[]) => void;
  readonly collector: ObservationCollector;
  readonly syntaxLocations: WeakMap<SyntaxRef, DiagnosticLocation>;
}): Promise<readonly FactResult<SubjectKind, Value>[]> {
  const {
    factType,
    options,
    adapters,
    factCache,
    sessionToken,
    snapshotId,
    projectId,
    ruleId,
    assertActiveSnapshot,
    createAdapterContext,
    replayAdapterAdditionalInput,
    recordGaps,
    collector,
    syntaxLocations,
  } = params;

  assertActiveSnapshot();

  if (options?.providerId !== undefined && options.providerId.trim() === "") {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      "Fact query providerId must be a non-empty string when specified.",
    );
  }

  const targets = options?.targets;
  if (targets !== undefined) {
    if (targets.length === 0) {
      return [];
    }
    validateProgramRefs(targets, sessionToken, snapshotId, projectId);
  }

  const matchedProviders: ProviderEntry[] = [];
  let filteredAdapterFound = false;
  for (const adapter of adapters) {
    if (options?.providerId !== undefined) {
      if (adapter.id !== options.providerId) {
        continue;
      }
      filteredAdapterFound = true;
    }
    const found = adapter.provides.find(
      (provider) => provider.factType.id === factType.id,
    );
    if (found) {
      matchedProviders.push({ adapterId: adapter.id, provider: found });
    }
  }
  matchedProviders.sort((a, b) => compareCodepoint(a.adapterId, b.adapterId));

  const providerFilterStatus:
    | "matched"
    | "not_enabled"
    | "unsupported"
    | undefined =
    options?.providerId !== undefined
      ? matchedProviders.length > 0
        ? "matched"
        : filteredAdapterFound
          ? "unsupported"
          : "not_enabled"
      : undefined;

  const providersUsed = matchedProviders.map((entry) => entry.adapterId);
  const providerLabel =
    providersUsed.length === 1
      ? providersUsed[0]!
      : providersUsed.length > 1
        ? providersUsed.join(",")
        : "none";

  const providerFilterKey = options?.providerId ?? "*";
  const conditionKey = stableSerializeValue(options?.condition ?? null);
  const baseKey = JSON.stringify([
    snapshotId,
    projectId,
    factType.id,
    providerFilterKey,
    conditionKey,
  ]);

  const queryStart = collector.isActive() ? performance.now() : 0;
  let cacheStatus: "computed" | "reused";
  let results: readonly FactResult<SubjectKind, Value>[];

  const replayInputs = (
    inputs: readonly CachedAdapterAdditionalInput[],
  ): void => {
    const seen = new Set<string>();
    for (const input of inputs) {
      const key = `${input.adapterId}\0${input.filePath}`;
      if (!seen.has(key)) {
        seen.add(key);
        replayAdapterAdditionalInput(input.adapterId, input.filePath);
      }
    }
  };

  const runExtraction = async (
    requestedTargets: readonly ProgramRef<SubjectKind>[] | undefined,
  ): Promise<{
    readonly results: readonly FactResult<SubjectKind, Value>[];
    readonly additionalInputs: readonly CachedAdapterAdditionalInput[];
  }> => {
    if (matchedProviders.length === 0) {
      return { results: [], additionalInputs: [] };
    }
    const recordedInputs: CachedAdapterAdditionalInput[] = [];
    const seenRecorded = new Set<string>();
    const request: FactExtractionRequest<SubjectKind, Condition> = {
      factType: factType,
      ...(requestedTargets !== undefined ? { targets: requestedTargets } : {}),
      ...(options?.condition !== undefined
        ? { condition: options.condition }
        : {}),
    };
    const perProvider: {
      readonly adapterId: string;
      readonly contributions: readonly FactContribution<SubjectKind, Value>[];
    }[] = [];

    for (const entry of matchedProviders) {
      const adapterCtx = createAdapterContext(entry.adapterId, (filePath) => {
        const key = `${entry.adapterId}\0${filePath}`;
        if (!seenRecorded.has(key)) {
          seenRecorded.add(key);
          recordedInputs.push({ adapterId: entry.adapterId, filePath });
        }
      });
      const rawContributions = (await entry.provider.extract(
        adapterCtx,
        request,
      )) as readonly FactContribution<SubjectKind, Value>[];
      validateProgramRefs(
        rawContributions.map((item) => item.subject),
        sessionToken,
        snapshotId,
        projectId,
      );
      perProvider.push({
        adapterId: entry.adapterId,
        contributions: rawContributions,
      });
    }

    return {
      results: mergeContributions(
        factType,
        projectId,
        snapshotId,
        options?.condition,
        syntaxLocations,
        perProvider,
      ),
      additionalInputs: recordedInputs,
    };
  };

  if (targets === undefined) {
    const cachedFull = factCache.getFull(baseKey);
    if (cachedFull) {
      cacheStatus = "reused";
      const loaded = await cachedFull;
      replayInputs(loaded.additionalInputs);
      results = loaded.results as readonly FactResult<SubjectKind, Value>[];
    } else {
      cacheStatus = "computed";
      const fullPromise = runExtraction(undefined).then(
        (computed) => {
          factCache.markFullLoaded(baseKey);
          for (const item of computed.results) {
            factCache.setTarget(
              baseKey,
              item.subject.handleId,
              Promise.resolve({
                item,
                additionalInputs: computed.additionalInputs,
              }),
            );
          }
          return computed;
        },
        (err: unknown) => {
          factCache.deleteFull(baseKey);
          throw err;
        },
      );
      factCache.setFull(baseKey, fullPromise);
      const computed = await fullPromise;
      results = computed.results;
    }
  } else if (factCache.isFullLoaded(baseKey)) {
    cacheStatus = "reused";
    const loaded = await factCache.getFull(baseKey)!;
    replayInputs(loaded.additionalInputs);
    const allResults = loaded.results as readonly FactResult<
      SubjectKind,
      Value
    >[];
    const byHandle = new Map(
      allResults.map((item) => [item.subject.handleId, item]),
    );
    const matched: FactResult<SubjectKind, Value>[] = [];
    for (const target of targets) {
      const found = byHandle.get(target.handleId);
      if (found) {
        matched.push(found);
      }
    }
    results = matched;
  } else {
    const missingTargets: ProgramRef<SubjectKind>[] = [];
    const seenMissing = new Set<string>();
    for (const target of targets) {
      if (
        !factCache.getTarget(baseKey, target.handleId) &&
        !seenMissing.has(target.handleId)
      ) {
        seenMissing.add(target.handleId);
        missingTargets.push(target);
      }
    }

    if (missingTargets.length === 0) {
      cacheStatus = "reused";
    } else {
      cacheStatus = "computed";
      const batchPromise = runExtraction(missingTargets);
      for (const target of missingTargets) {
        const itemPromise = batchPromise.then(
          (computed) => ({
            item:
              computed.results.find(
                (item) => item.subject.handleId === target.handleId,
              ) ?? null,
            additionalInputs: computed.additionalInputs,
          }),
          (err: unknown) => {
            factCache.deleteTarget(baseKey, target.handleId);
            throw err;
          },
        );
        factCache.setTarget(baseKey, target.handleId, itemPromise);
      }
      await batchPromise;
    }

    const resolved = await Promise.all(
      targets.map((target) => factCache.getTarget(baseKey, target.handleId)!),
    );
    replayInputs(resolved.flatMap((entry) => entry.additionalInputs));
    results = resolved
      .map((entry) => entry.item)
      .filter((item): item is FactResult<SubjectKind, Value> => item !== null);
  }

  for (const item of results) {
    if (item.gaps.length > 0) {
      recordGaps(item.gaps);
    }
  }

  if (collector.isActive()) {
    const durationMs = performance.now() - queryStart;
    const explainTarget = collector.explainTarget;
    const matchedLocations: DiagnosticLocation[] | undefined = explainTarget
      ? collectMatchedFactLocations(results, explainTarget, syntaxLocations)
      : undefined;

    const filterSummarySuffix =
      providerFilterStatus === "not_enabled"
        ? ` (providerFilter=${options!.providerId}: not enabled)`
        : providerFilterStatus === "unsupported"
          ? ` (providerFilter=${options!.providerId}: factType unsupported)`
          : "";

    collector.recordQuery({
      ruleId,
      op: `facts:${factType.id}`,
      projectId,
      provider: providerLabel,
      providers: providersUsed,
      cacheStatus,
      candidateCount: results.length,
      durationMs,
      summary: `facts(${factType.id}) [${providerLabel}]${filterSummarySuffix} -> ${results.length} result(s)`,
      ...(matchedLocations !== undefined ? { matchedLocations } : {}),
      ...(collector.mode === "detail" || collector.isExplainEnabled()
        ? {
            detail: {
              factTypeId: factType.id,
              providers: providersUsed,
              ...(options?.providerId !== undefined
                ? {
                    providerFilter: options.providerId,
                    providerFilterStatus,
                  }
                : {}),
              candidateCount: results.length,
            },
          }
        : {}),
    });
  }

  return results;
}

function collectMatchedFactLocations<
  SubjectKind extends ProgramObjectKind,
  Value,
>(
  results: readonly FactResult<SubjectKind, Value>[],
  explainTarget: NonNullable<ObservationCollector["explainTarget"]>,
  syntaxLocations: WeakMap<SyntaxRef, DiagnosticLocation>,
): DiagnosticLocation[] {
  const matched: DiagnosticLocation[] = [];
  for (const result of results) {
    const subjectLoc = syntaxLocations.get(result.subject as SyntaxRef);
    if (subjectLoc && locationMatchesTarget(subjectLoc, explainTarget)) {
      matched.push(subjectLoc);
      continue;
    }
    const evidenceLoc = result.evidence.find(
      (ev) => ev.at && locationMatchesTarget(ev.at, explainTarget),
    )?.at;
    if (evidenceLoc) {
      matched.push(evidenceLoc);
    }
  }
  return matched;
}
