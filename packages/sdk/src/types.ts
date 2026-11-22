import type {
  AssignabilityPair,
  AssignabilityResult,
  CallProjectionSelection,
  DeclarationProjectionSelection,
  ProjectedCallResolutionRow,
  ProjectedCallRow,
  ProjectedDeclarationRow,
  ProjectedSignatureRow,
  ProjectedSyntaxLookupRow,
  ProjectedTypeRow,
  SignatureProjectionSelection,
  SyntaxLookupSelection,
  TypeProjectionSelection,
} from "./projection.ts";

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
  | "NewExpression"
  | "ReturnStatement"
  | "VariableDeclaration"
  | "BinaryExpression"
  | "PropertyAccessExpression"
  | "IfStatement"
  | "FunctionDeclaration"
  | "ArrowFunction"
  | "FunctionExpression"
  | "MethodDeclaration"
  | "MethodSignature"
  | "CallSignature"
  | "Constructor"
  | "FunctionType"
  | "StringLiteral"
  | "NumericLiteral"
  | "Parameter"
  | "PropertyAssignment"
  | "ShorthandPropertyAssignment"
  | "PropertyDeclaration"
  | "PropertySignature"
  | "ClassDeclaration"
  | "InterfaceDeclaration"
  | "TypeAliasDeclaration"
  | "ImportDeclaration"
  | "ImportSpecifier"
  | "ExportSpecifier"
  | "Block"
  | "TypeReference";

declare const objectKindBrand: unique symbol;
declare const sessionBrand: unique symbol;

export type ProgramObjectKind =
  | "syntax"
  | "declaration"
  | "call"
  | "signature"
  | "type";

export interface ProgramRef<K extends ProgramObjectKind = ProgramObjectKind> {
  readonly [objectKindBrand]: K;
  readonly [sessionBrand]: symbol;
  readonly projectId: string;
  readonly snapshotId: number;
  readonly handleId: string;
}

export type SyntaxRef = ProgramRef<"syntax">;
export type DeclarationRef = ProgramRef<"declaration">;
export type CallRef = ProgramRef<"call">;
export type SignatureRef = ProgramRef<"signature">;
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

export type CheckReport = {
  readonly reportVersion: typeof REPORT_SCHEMA_VERSION;
  readonly status: "clean" | "findings";
  readonly projects: readonly ProjectSummary[];
  readonly diagnostics: readonly Diagnostic[];
  readonly gaps: readonly Gap[];
};

export type SourceRange = {
  readonly file: string;
  readonly startLine?: number;
  readonly startColumn?: number;
  readonly endLine?: number;
  readonly endColumn?: number;
  readonly start?: number;
  readonly end?: number;
  readonly match?: "within" | "intersects";
};

export type FindSyntaxOptions = {
  readonly kinds?: readonly SyntaxKind[];
  readonly files?: readonly string[];
  readonly range?: SourceRange;
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
  readonly body?: SyntaxRef;
  readonly parameters?: readonly SyntaxRef[];
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
  findSyntax: (
    options: FindSyntaxOptions,
  ) => Promise<readonly SyntaxNodeResult[]>;
  typeAt: (targets: readonly SyntaxRef[]) => Promise<readonly TypeAtResult[]>;
  resolveDeclarations: <
    const S extends DeclarationProjectionSelection = Record<never, never>,
  >(
    targets: readonly (SyntaxRef | CallRef | SignatureRef)[],
    options?: { readonly select?: S },
  ) => Promise<readonly ProjectedDeclarationRow<S>[]>;
  resolveCalls: <
    const S extends CallProjectionSelection = Record<never, never>,
  >(
    targets: readonly SyntaxRef[],
    options?: { readonly select?: S },
  ) => Promise<readonly ProjectedCallResolutionRow<S>[]>;
  projectCalls: <const S extends CallProjectionSelection>(
    calls: readonly CallRef[],
    options: { readonly select: S },
  ) => Promise<readonly ProjectedCallRow<S>[]>;
  projectSignatures: <const S extends SignatureProjectionSelection>(
    signatures: readonly SignatureRef[],
    options: { readonly select: S },
  ) => Promise<readonly ProjectedSignatureRow<S>[]>;
  projectTypes: <const S extends TypeProjectionSelection>(
    types: readonly TypeRef[],
    options: { readonly select: S },
  ) => Promise<readonly ProjectedTypeRow<S>[]>;
  isAssignableTo: (
    pairs: readonly AssignabilityPair[],
  ) => Promise<readonly AssignabilityResult[]>;
  syntaxOf: <const S extends SyntaxLookupSelection = Record<never, never>>(
    targets: readonly (DeclarationRef | CallRef | SignatureRef)[],
    options?: { readonly select?: S },
  ) => Promise<readonly ProjectedSyntaxLookupRow<S>[]>;
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
};

export type NormalizedVeruleConfig = {
  readonly tsconfig?: string;
  readonly projects?: readonly string[];
  readonly rules: readonly Rule[];
};

export type OpenSessionOptions = {
  readonly cwd: string;
  readonly config?: VeruleConfig;
  readonly observe?: ObserveMode;
};

export type RunCheckOptions = OpenSessionOptions;

export type AnalysisSession = {
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  check: (rulesOverride?: readonly Rule[]) => Promise<CheckReport>;
  close: () => Promise<void>;
};
