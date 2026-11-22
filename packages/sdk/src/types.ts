export const REPORT_SCHEMA_VERSION = "1" as const;

export type VeruleErrorCode =
  | "INVALID_CONFIG"
  | "PROJECT_LOAD_ERROR"
  | "RULE_EXECUTION_ERROR"
  | "STALE_REFERENCE"
  | "CROSS_PROJECT_REFERENCE"
  | "STALE_SNAPSHOT"
  | "SESSION_CLOSED"
  | "ENGINE_ERROR";

/** Execution failure raised when analysis configuration, loading, queries, or rules fail. */
export class VeruleExecutionError extends Error {
  readonly code: VeruleErrorCode;

  constructor(code: VeruleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VeruleExecutionError";
    this.code = code;
  }
}

export type ObserveMode = "off" | "summary" | "detail";

export type SyntaxKind =
  | "Identifier"
  | "CallExpression"
  | "ReturnStatement"
  | "VariableDeclaration"
  | "BinaryExpression"
  | "PropertyAccessExpression"
  | "IfStatement"
  | "FunctionDeclaration"
  | "ArrowFunction"
  | "FunctionExpression"
  | "MethodDeclaration"
  | "StringLiteral"
  | "NumericLiteral"
  | "Parameter"
  | "NewExpression";

declare const objectKindBrand: unique symbol;
declare const sessionBrand: unique symbol;

export type ProgramObjectKind = "syntax" | "type";

export interface ProgramRef<K extends ProgramObjectKind = ProgramObjectKind> {
  readonly [objectKindBrand]: K;
  readonly [sessionBrand]: symbol;
  readonly projectId: string;
  readonly snapshotId: number;
  readonly handleId: string;
}

export type SyntaxRef = ProgramRef<"syntax">;
export type TypeRef = ProgramRef<"type">;

const refSessionTokens = new WeakMap<object, symbol>();

export function makeProgramRef<K extends ProgramObjectKind>(
  _kind: K,
  sessionToken: symbol,
  projectId: string,
  snapshotId: number,
  handleId: string,
): ProgramRef<K> {
  const ref = {
    projectId,
    snapshotId,
    handleId,
  } as ProgramRef<K>;
  refSessionTokens.set(ref, sessionToken);
  return ref;
}

export function getRefSessionToken(ref: ProgramRef): symbol | undefined {
  return refSessionTokens.get(ref);
}

/** 1-based UTF-16 line/column and 0-based UTF-8 byte offsets in a normalized relative file. */
export type DiagnosticLocation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
  readonly start: number;
  readonly end: number;
};

export type Evidence = {
  readonly kind: "source" | "type" | "note";
  readonly message: string;
  readonly at?: DiagnosticLocation;
};

export type Gap = {
  readonly kind: string;
  readonly message: string;
  readonly at?: DiagnosticLocation;
};

export type DiagnosticInput = {
  readonly at: DiagnosticLocation;
  readonly message: string;
  readonly findingKey?: string;
  readonly evidence?: readonly Evidence[];
};

export type Diagnostic = {
  readonly id: string;
  readonly ruleId: string;
  readonly at: DiagnosticLocation;
  readonly message: string;
  readonly evidence: readonly Evidence[];
  readonly projects: readonly string[];
};

export type ProjectSummary = {
  readonly projectId: string;
  readonly configFile: string;
  readonly sourceFiles: readonly string[];
};

export type Model = {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly facts?: Readonly<Record<string, unknown>>;
};

export type RuleIdentitySummary = {
  readonly id: string;
  readonly digest: string;
};

export type ModelIdentitySummary = {
  readonly id: string;
  readonly version?: string;
  readonly digest: string;
};

export type ReportIdentity = {
  readonly snapshotDigest: string;
  readonly configDigest: string;
  readonly rules: readonly RuleIdentitySummary[];
  readonly models: readonly ModelIdentitySummary[];
};

export type CheckReport = {
  readonly reportVersion: typeof REPORT_SCHEMA_VERSION;
  readonly status: "clean" | "findings";
  readonly projects: readonly ProjectSummary[];
  readonly diagnostics: readonly Diagnostic[];
  readonly gaps: readonly Gap[];
  readonly identity: ReportIdentity;
};

export type FindSyntaxOptions = {
  readonly kinds: readonly SyntaxKind[];
  readonly files?: readonly string[];
};

export type SyntaxNodeResult = {
  readonly ref: SyntaxRef;
  readonly kind: SyntaxKind;
  readonly text: string;
  readonly location: DiagnosticLocation;
  readonly expression?: SyntaxRef;
  readonly arguments?: readonly SyntaxRef[];
  readonly name?: SyntaxRef;
  readonly initializer?: SyntaxRef;
};

export type TypeAtResult = {
  readonly target: SyntaxRef;
  readonly ref: TypeRef;
  readonly typeText: string;
  readonly isUnion: boolean;
  readonly isIntersection: boolean;
  readonly isLiteral: boolean;
  readonly literalValue?: string | number | boolean;
  readonly unionMembers?: readonly string[];
};

export type RuleContext = {
  readonly project: ProjectSummary;
  readonly models: readonly Model[];
  getModel: (id: string) => Model | undefined;
  findSyntax: (
    options: FindSyntaxOptions,
  ) => Promise<readonly SyntaxNodeResult[]>;
  typeAt: (targets: readonly SyntaxRef[]) => Promise<readonly TypeAtResult[]>;
  report: (diagnostic: DiagnosticInput) => void;
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
  readonly models?: readonly Model[];
};

export type NormalizedVeruleConfig = {
  readonly tsconfig?: string;
  readonly projects?: readonly string[];
  readonly rules: readonly Rule[];
  readonly models: readonly Model[];
};

export type OpenSessionOptions = {
  readonly cwd: string;
  readonly config?: VeruleConfig;
  readonly observe?: ObserveMode;
};

export type RunCheckOptions = OpenSessionOptions;

export type RecomputationScope = {
  readonly recomputedProjects: readonly string[];
  readonly reusedProjects: readonly string[];
  readonly recomputedFiles: readonly string[];
  readonly reusedFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly invalidatedBy: readonly string[];
};

export type MemoryStats = {
  readonly hostRssBytes: number;
  readonly engineRssBytes?: number;
};

export type SessionUpdateOptions = {
  readonly changed?: readonly string[];
  readonly created?: readonly string[];
  readonly deleted?: readonly string[];
  readonly config?: VeruleConfig;
  readonly rules?: readonly Rule[];
  readonly models?: readonly Model[];
  readonly entries?: readonly string[];
};

export type SessionUpdateResult = {
  readonly previousSnapshotId: number;
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  readonly recomputation: RecomputationScope;
  readonly memory: MemoryStats;
};

export type AnalysisSession = {
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  readonly memory: MemoryStats;
  check: (rulesOverride?: readonly Rule[]) => Promise<CheckReport>;
  update: (options?: SessionUpdateOptions) => Promise<SessionUpdateResult>;
  close: () => Promise<void>;
};

export type WatchTrigger = "initial" | "change";

export type WatchConfigLoadResult = {
  readonly config: VeruleConfig;
  readonly watchFiles?: readonly string[];
};

export type WatchProjectOptions = {
  readonly cwd: string;
  readonly config?: VeruleConfig;
  readonly loadConfig?: () => Promise<WatchConfigLoadResult>;
  readonly watchFiles?: readonly string[];
  readonly observe?: ObserveMode;
  readonly debounceMs?: number;
  readonly signal?: AbortSignal;
};

export type WatchReportEvent = {
  readonly kind: "report";
  readonly sequence: number;
  readonly trigger: WatchTrigger;
  readonly snapshotId: number;
  readonly report: CheckReport;
  readonly recomputation: RecomputationScope;
  readonly memory: MemoryStats;
};

export type WatchFailureEvent = {
  readonly kind: "failed";
  readonly sequence: number;
  readonly trigger: WatchTrigger;
  readonly code: VeruleErrorCode;
  readonly message: string;
};

export type WatchEvent = WatchReportEvent | WatchFailureEvent;
