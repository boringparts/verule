import {
  TssaeError,
  type AdditionalInputEntry,
  type AdditionalInputSource,
  type DiagnosticBasis,
  type DiagnosticLocation,
  type EngineIrCacheMetrics,
  type EngineLoweringMetrics,
  type EngineSummaryLookupMetrics,
  type Evidence,
  type ExplainCleanupPath,
  type Gap,
  type MemoryStats,
  type ObserveLimit,
  type ObserveLimitInput,
  type ObserveMode,
  type ObserveOptions,
  type ProjectContext,
  type ProjectSummary,
  type RecomputationScope,
  type SourceFileOrigin,
  type SourceTarget,
  type SummaryConflictDetails,
  type SyntaxRef,
  type TssaeErrorCode,
} from "tssae";

export type {
  AdditionalInputEntry,
  AdditionalInputSource,
  DiagnosticLocation,
  EngineIrCacheMetrics,
  EngineLoweringMetrics,
  EngineSummaryLookupMetrics,
  Evidence,
  ExplainCleanupPath,
  Gap,
  MemoryStats,
  ObserveLimit,
  ObserveLimitInput,
  ObserveMode,
  ObserveOptions,
  ProjectContext,
  ProjectSummary,
  RecomputationScope,
  SourceFileOrigin,
  SourceTarget,
  SummaryConflictDetails,
  SyntaxRef,
  TssaeErrorCode,
} from "tssae";

export const REPORT_SCHEMA_VERSION = "1" as const;

export type VeruleErrorCode = TssaeErrorCode | "RULE_EXECUTION_ERROR";

/** Execution failure raised when analysis configuration, loading, queries, or rules fail. */
export class VeruleExecutionError extends Error {
  readonly code: VeruleErrorCode;
  readonly summaryConflict?: SummaryConflictDetails;

  constructor(
    code: VeruleErrorCode,
    message: string,
    options?: ErrorOptions & {
      readonly summaryConflict?: SummaryConflictDetails;
    },
  ) {
    super(message, options);
    this.name = "VeruleExecutionError";
    this.code = code;
    if (options?.summaryConflict !== undefined) {
      this.summaryConflict = options.summaryConflict;
    }
  }
}

/** Maps upstream `TssaeError` or unknown exceptions into `VeruleExecutionError`. */
export function toVeruleError(
  error: unknown,
  fallbackCode: VeruleErrorCode = "ENGINE_ERROR",
): VeruleExecutionError {
  if (error instanceof VeruleExecutionError) {
    return error;
  }
  if (error instanceof TssaeError) {
    return new VeruleExecutionError(error.code, error.message, {
      cause: error,
      ...(error.summaryConflict !== undefined
        ? { summaryConflict: error.summaryConflict }
        : {}),
    });
  }
  if (
    error instanceof Error &&
    error.name === "TssaeError" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const summaryConflict =
      "summaryConflict" in error && error.summaryConflict !== undefined
        ? (error.summaryConflict as SummaryConflictDetails)
        : undefined;
    return new VeruleExecutionError(
      error.code as VeruleErrorCode,
      error.message,
      {
        cause: error,
        ...(summaryConflict !== undefined ? { summaryConflict } : {}),
      },
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  return new VeruleExecutionError(fallbackCode, message, { cause: error });
}

export type CheckpointOutcome = "pass" | "exclude" | "info";

export type CheckpointTarget =
  | DiagnosticLocation
  | SyntaxRef
  | { readonly location: DiagnosticLocation };

export type DiagnosticInput = {
  readonly at: DiagnosticLocation;
  readonly message: string;
  readonly findingKey?: string;
  /** Selected query results and explicit evidence, in diagnostic display order. */
  readonly basis?: readonly DiagnosticBasis[];
};

export type Diagnostic = {
  readonly id: string;
  readonly ruleId: string;
  readonly at: DiagnosticLocation;
  readonly message: string;
  readonly evidence: readonly Evidence[];
  readonly projects: readonly string[];
};

export type RuleIdentitySummary = {
  readonly id: string;
  readonly digest: string;
};

export type ReportIdentity = {
  readonly snapshotDigest: string;
  readonly configDigest: string;
  readonly rules: readonly RuleIdentitySummary[];
};

export type ObservationPhases = {
  readonly configAndOpenMs: number;
  readonly engineQueryMs: number;
  readonly ruleExecutionMs: number;
  readonly totalMs: number;
};

export type ObservationRpcMetrics = {
  readonly batches: number;
  readonly queryBatches: number;
  readonly bytesSent: number;
  readonly bytesReceived: number;
};

export type ObservationOverhead = {
  readonly checkpointMs: number;
  readonly encodeMs: number;
  readonly writeMs: number;
};

export type ObservationDetailEntry = {
  readonly kind: "query" | "checkpoint" | "engineStep";
  readonly ruleId?: string;
  readonly projectId?: string;
  readonly provider?: string;
  readonly name?: string;
  readonly outcome?: CheckpointOutcome;
  readonly cacheStatus?: "computed" | "reused";
  readonly candidateCount?: number;
  readonly durationMs?: number;
  readonly at?: DiagnosticLocation;
  readonly summary: string;
  readonly detail?: unknown;
};

export type ObservationReport = {
  readonly mode: Exclude<ObserveMode, "off">;
  readonly phases: ObservationPhases;
  readonly rpc: ObservationRpcMetrics;
  readonly overhead: ObservationOverhead;
  readonly queryCount: number;
  readonly computedQueryCount: number;
  readonly reusedQueryCount: number;
  readonly candidateCount: number;
  readonly checkpointCount: number;
  readonly providers: readonly string[];
  readonly lowering: EngineLoweringMetrics;
  readonly irCache: EngineIrCacheMetrics;
  readonly summaryLookup: EngineSummaryLookupMetrics;
  readonly limit?: ObserveLimit;
  readonly truncated: boolean;
  readonly droppedCount: number;
  readonly details?: readonly ObservationDetailEntry[];
};

export type ExplainStatus =
  | "reported"
  | "excluded_by_checkpoint"
  | "excluded_by_query"
  | "not_in_candidates"
  | "target_not_in_project"
  | "suppressed_by_ignore"
  | "blocked_by_gap"
  | "covered_by_cleanup"
  | "rule_filtered";

export type ExplainQueryStep = {
  readonly queryIndex: number;
  readonly op: string;
  readonly projectId: string;
  readonly provider: string;
  readonly cacheStatus: "computed" | "reused";
  readonly candidateCount: number;
  readonly matchedTarget: boolean;
  readonly durationMs: number;
  readonly summary?: string;
  readonly detail?: unknown;
};

export type ExplainCheckpointTrace = {
  readonly name: string;
  readonly ruleId: string;
  readonly projectId: string;
  readonly outcome: CheckpointOutcome;
  readonly at?: DiagnosticLocation;
  readonly detail?: unknown;
};

export type ExplainResult = {
  readonly ruleId: string;
  readonly target: SourceTarget;
  readonly status: ExplainStatus;
  readonly inCandidates: boolean;
  readonly summary: string;
  readonly projectsChecked: readonly string[];
  readonly matchingCandidates: readonly DiagnosticLocation[];
  readonly excludedByQuery?: ExplainQueryStep;
  readonly excludedByCheckpoint?: ExplainCheckpointTrace;
  readonly queries: readonly ExplainQueryStep[];
  readonly checkpoints: readonly ExplainCheckpointTrace[];
  readonly gaps: readonly Gap[];
  readonly providers: readonly string[];
  readonly cleanupPaths: readonly ExplainCleanupPath[];
  readonly inlineIgnore?: {
    readonly matched: boolean;
    readonly ruleId?: string;
    readonly reason?: string;
    readonly commentAt?: DiagnosticLocation;
  };
};

export type InlineIgnoreStatus =
  | "suppressed"
  | "unused"
  | "ambiguous"
  | "malformed"
  | "unknown_rule"
  | "undetermined";

export type InlineIgnoreEntry = {
  readonly status: InlineIgnoreStatus;
  readonly at: DiagnosticLocation;
  readonly targetLine?: number;
  readonly ruleId?: string;
  readonly reason?: string;
  readonly matchedLocations?: readonly DiagnosticLocation[];
  readonly message?: string;
};

export type CheckReport = {
  readonly reportVersion: typeof REPORT_SCHEMA_VERSION;
  readonly status: "clean" | "findings";
  readonly projects: readonly ProjectSummary[];
  readonly fileOrigins: readonly SourceFileOrigin[];
  readonly additionalInputs: readonly AdditionalInputEntry[];
  readonly diagnostics: readonly Diagnostic[];
  readonly gaps: readonly Gap[];
  readonly identity: ReportIdentity;
  readonly inlineIgnores?: readonly InlineIgnoreEntry[];
  readonly observation?: ObservationReport;
  readonly explanation?: ExplainResult;
  readonly explanations?: readonly ExplainResult[];
};

export type ExplainReport = CheckReport & {
  readonly explanation: ExplainResult;
};

/** Execution context exposed to Verule rules, backed by TSSAE `ProjectContext` queries. */
export type RuleContext = ProjectContext & {
  report: (diagnostic: DiagnosticInput) => void;
  /**
   * Records a named TS judgment checkpoint for explainability and detail observation.
   * When observation and explanation are disabled, `detail` is never invoked.
   */
  checkpoint: (
    name: string,
    target: CheckpointTarget,
    outcome: CheckpointOutcome,
    detail?: () => unknown,
  ) => void;
  recordGaps: (
    gaps: readonly Gap[],
    options?: { readonly relatedLocation?: DiagnosticLocation },
  ) => void;
};

export type Rule = {
  readonly id: string;
  readonly description?: string;
  readonly run: (ctx: RuleContext) => void | Promise<void>;
};

export type VeruleConfig = {
  readonly tsconfig?: string;
  readonly projects?: readonly string[];
  readonly rules?: readonly Rule[];
  readonly additionalInputs?: readonly string[];
};

export type NormalizedVeruleConfig = {
  readonly tsconfig?: string;
  readonly projects?: readonly string[];
  readonly rules: readonly Rule[];
  readonly additionalInputs: readonly string[];
};

export type SessionCheckOptions = {
  readonly rulesOverride?: readonly Rule[];
  readonly ruleIds?: readonly string[];
  readonly at?: string | SourceTarget;
  readonly observe?: ObserveMode | ObserveOptions;
  readonly observeLimit?: ObserveLimitInput;
  readonly configLoadMs?: number;
};

export type ExplainOptions = {
  readonly ruleId?: string;
  readonly at: string | SourceTarget;
  readonly observe?: ObserveMode | ObserveOptions;
  readonly observeLimit?: ObserveLimitInput;
  readonly rulesOverride?: readonly Rule[];
};

export type OpenSessionOptions = {
  readonly cwd: string;
  readonly config?: VeruleConfig | NormalizedVeruleConfig;
  readonly observe?: ObserveMode | ObserveOptions;
  readonly observeLimit?: ObserveLimitInput;
  readonly configLoadMs?: number;
};

export type RunCheckOptions = OpenSessionOptions & {
  readonly ruleIds?: readonly string[];
  readonly at?: string | SourceTarget;
};

export type SessionUpdateOptions = {
  readonly changed?: readonly string[];
  readonly created?: readonly string[];
  readonly deleted?: readonly string[];
  readonly config?: VeruleConfig | NormalizedVeruleConfig;
  readonly rules?: readonly Rule[];
  readonly entries?: readonly string[];
  readonly additionalInputs?: readonly string[];
};

export type SessionUpdateResult = {
  readonly previousSnapshotId: number;
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  readonly fileOrigins: readonly SourceFileOrigin[];
  readonly additionalInputs: readonly AdditionalInputEntry[];
  readonly recomputation: RecomputationScope;
  readonly memory: MemoryStats;
};

export type AnalysisSession = {
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  readonly fileOrigins: readonly SourceFileOrigin[];
  readonly additionalInputs: readonly AdditionalInputEntry[];
  readonly memory: MemoryStats;
  registerAdditionalInput: (
    filePath: string,
    source: AdditionalInputSource,
  ) => AdditionalInputEntry;
  check: (
    optionsOrRules?: readonly Rule[] | SessionCheckOptions,
  ) => Promise<CheckReport>;
  update: (options?: SessionUpdateOptions) => Promise<SessionUpdateResult>;
  explain: (options: ExplainOptions) => Promise<ExplainReport>;
  close: () => Promise<void>;
};

export type WatchTrigger = "initial" | "change";

export type WatchConfigLoadResult = {
  readonly config: VeruleConfig | NormalizedVeruleConfig;
  readonly watchFiles?: readonly string[];
};

export type WatchProjectOptions = {
  readonly cwd: string;
  readonly config?: VeruleConfig | NormalizedVeruleConfig;
  readonly loadConfig?: () => Promise<WatchConfigLoadResult>;
  readonly watchFiles?: readonly string[];
  readonly observe?: ObserveMode;
  readonly observeLimit?: ObserveLimitInput;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
};

export type WatchReportEvent = {
  readonly kind: "report";
  readonly sequence: number;
  readonly trigger: WatchTrigger;
  readonly snapshotId: number;
  readonly recomputation: RecomputationScope;
  readonly memory: MemoryStats;
  readonly report: CheckReport;
};

export type WatchFailureEvent = {
  readonly kind: "failed";
  readonly sequence: number;
  readonly trigger: WatchTrigger;
  readonly code: VeruleErrorCode;
  readonly message: string;
};

export type WatchEvent = WatchReportEvent | WatchFailureEvent;

export type SharedSessionOptions = {
  readonly cwd: string;
  readonly endpoint: string;
  readonly config?: VeruleConfig | NormalizedVeruleConfig;
  readonly loadConfig?: () => Promise<WatchConfigLoadResult>;
  readonly watchFiles?: readonly string[];
  readonly observe?: ObserveMode;
  readonly observeLimit?: ObserveLimitInput;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
};

export type SharedSession = {
  readonly endpoint: string;
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  readonly closed: boolean;
  waitUntilClosed: () => Promise<void>;
  close: () => Promise<void>;
};

export type RequestSharedReportOptions = {
  readonly endpoint: string;
  readonly cwd?: string;
  readonly ruleIds?: readonly string[];
  readonly at?: string | SourceTarget;
  readonly observe?: ObserveMode | ObserveOptions;
  readonly observeLimit?: ObserveLimitInput;
  readonly timeoutMs?: number;
};
