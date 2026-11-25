import {
  defineModel,
  defineRule,
  isSameInstance,
  type CallRef,
  type CleanupModelOperation,
  type CleanupScopeRef,
  type DeclarationRef,
  type DiagnosticBasis,
  type DiagnosticLocation,
  type InstanceCleanupScopeResult,
  type InstanceModelBehavior,
  type InstanceModelMatch,
  type InstanceRef,
  type InstanceResolutionResult,
  type LifecycleEventBehavior,
  type Model,
  type ProjectedDeclarationRow,
  type ProjectedSyntaxLookupRow,
  type Rule,
  type RuleContext,
  type SyntaxNodeResult,
  type SyntaxRef,
  type ValuePropagationTargetResult,
} from "@boringparts/verule";

/** Specification of a factory-delegation scope whose executions create coexisting child items. */
export type ChildItemScopeSpec = {
  readonly id: string;
  readonly kind: "factory-delegation";
  readonly label: string;
  readonly match: InstanceModelMatch;
  readonly callbackArgumentIndex?: number;
};

/** Specification of an outer container registration API whose lifetime outlives child items. */
export type OuterHostContainerSpec = {
  readonly id: string;
  readonly label: string;
  readonly match: InstanceModelMatch;
  readonly argumentIndex?: number;
};

/** Declarative facts stored on a pool/child-resource ownership model. */
export type PoolResourceOwnershipModelFacts = {
  readonly childItemScopes?: readonly ChildItemScopeSpec[];
  readonly outerHostContainers?: readonly OuterHostContainerSpec[];
};

/** Options for constructing a reusable pool/child resource ownership `Model`. */
export type PoolResourceOwnershipModelOptions = {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly instanceBehaviors?: readonly InstanceModelBehavior[];
  readonly cleanupOperations?: readonly CleanupModelOperation[];
  readonly lifecycleEvents?: readonly LifecycleEventBehavior[];
  readonly facts: PoolResourceOwnershipModelFacts;
};

/** Options for configuring the pool resource ownership rule. */
export type PoolResourceOwnershipRuleOptions = {
  readonly id?: string;
  readonly description?: string;
};

type ScopedSpec<T> = {
  readonly spec: T;
  readonly modelId: string;
};

type ParsedModelConfig = {
  readonly childItemScopes: readonly ScopedSpec<ChildItemScopeSpec>[];
  readonly outerHostContainers: readonly ScopedSpec<OuterHostContainerSpec>[];
  readonly containerInternalMatches: readonly InstanceModelMatch[];
};

type CallInfo = {
  readonly syntax: SyntaxNodeResult;
  readonly call: CallRef | null;
  readonly callee: SyntaxRef | null;
  readonly calleeDeclaration: DeclarationRef | null;
  readonly arguments: readonly SyntaxRef[];
  readonly memberName: string | null;
  readonly containerName: string | null;
  readonly receiverExpr: SyntaxRef | null;
  readonly isExternal: boolean;
  readonly declLocation: DiagnosticLocation | null;
};

type ScopeEntry = {
  readonly spec: ChildItemScopeSpec;
  readonly modelId: string;
  readonly triggerCall: CallInfo;
  readonly scopeFn: SyntaxNodeResult;
  readonly scopeRange: DiagnosticLocation;
  readonly visitedFiles: readonly string[];
};

type LocalContainerRecord = {
  readonly instance: InstanceRef;
  readonly instanceKey: string;
  readonly allocationLocation: DiagnosticLocation;
  readonly firstRegistration: CallInfo;
};

type RegistrationRecord = {
  readonly info: CallInfo;
  readonly containerSpec: OuterHostContainerSpec;
  readonly containerModelId: string;
  readonly containerExpr: SyntaxRef;
  readonly itemExpr: SyntaxRef;
  readonly propagationResults: readonly ValuePropagationTargetResult[];
};

type ScopeAstPartition = {
  readonly scopeCallsRaw: readonly SyntaxNodeResult[];
  readonly scopeFunctions: readonly SyntaxNodeResult[];
  readonly scopeVarDecls: readonly SyntaxNodeResult[];
  readonly scopeReturnStmts: readonly SyntaxNodeResult[];
  readonly scopePropAssignments: readonly SyntaxNodeResult[];
  readonly scopeShorthandProps: readonly SyntaxNodeResult[];
};

type WronglyDisposedInfo = {
  readonly site: InstanceCleanupScopeResult["disposedInstances"][number];
  readonly label: string;
  readonly declaredAt: DiagnosticLocation | null;
  readonly declRow: ProjectedDeclarationRow<{
    readonly location: true;
    readonly name: true;
  }> | null;
  readonly argSyntax: ProjectedSyntaxLookupRow<{
    readonly text: true;
    readonly location: true;
  }> | null;
  readonly argDeclRow: ProjectedDeclarationRow<{
    readonly location: true;
  }> | null;
};

type FileSyntaxCache = Map<string, readonly SyntaxNodeResult[]>;

const MAX_FACTORY_HOPS = 4;
const MAX_LOOKUP_HOPS = 2;
const MAX_LOOKUP_FILES = 32;

function normalizeRelPath(filePath: string): string {
  return filePath.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isLocationWithin(
  inner: DiagnosticLocation,
  outer: DiagnosticLocation,
): boolean {
  return (
    normalizeRelPath(inner.file) === normalizeRelPath(outer.file) &&
    inner.start >= outer.start &&
    inner.end <= outer.end
  );
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isInstanceModelMatch(value: unknown): value is InstanceModelMatch {
  if (!isObjectRecord(value)) return false;
  return (
    (value.symbol === undefined || typeof value.symbol === "string") &&
    (value.container === undefined || typeof value.container === "string") &&
    (value.member === undefined || typeof value.member === "string") &&
    (value.module === undefined || typeof value.module === "string")
  );
}

function parseChildScopeSpec(raw: unknown): ChildItemScopeSpec | null {
  if (!isObjectRecord(raw) || !isInstanceModelMatch(raw.match)) {
    return null;
  }
  if (typeof raw.id !== "string" || typeof raw.label !== "string") {
    return null;
  }
  if (raw.kind !== "factory-delegation") {
    return null;
  }
  return {
    id: raw.id,
    kind: "factory-delegation",
    label: raw.label,
    match: raw.match,
    ...(typeof raw.callbackArgumentIndex === "number"
      ? { callbackArgumentIndex: raw.callbackArgumentIndex }
      : {}),
  };
}

function parseModelConfig(models: readonly Model[]): ParsedModelConfig {
  const childItemScopes: ScopedSpec<ChildItemScopeSpec>[] = [];
  const outerHostContainers: ScopedSpec<OuterHostContainerSpec>[] = [];

  for (const model of models) {
    const facts = model.facts;
    if (isObjectRecord(facts)) {
      if (Array.isArray(facts.childItemScopes)) {
        for (const raw of facts.childItemScopes) {
          const parsed = parseChildScopeSpec(raw);
          if (parsed) {
            childItemScopes.push({ spec: parsed, modelId: model.id });
          }
        }
      }
      if (Array.isArray(facts.outerHostContainers)) {
        for (const raw of facts.outerHostContainers) {
          if (
            isObjectRecord(raw) &&
            typeof raw.id === "string" &&
            typeof raw.label === "string" &&
            isInstanceModelMatch(raw.match)
          ) {
            outerHostContainers.push({
              spec: {
                id: raw.id,
                label: raw.label,
                match: raw.match,
                ...(typeof raw.argumentIndex === "number"
                  ? { argumentIndex: raw.argumentIndex }
                  : {}),
              },
              modelId: model.id,
            });
          }
        }
      }
    }
  }

  if (outerHostContainers.length === 0) {
    for (const model of models) {
      for (const op of model.cleanupOperations ?? []) {
        if (op.kind !== "registers-into-container") continue;
        const label =
          op.match.container && op.match.member
            ? `${op.match.container}.${op.match.member}`
            : (op.match.symbol ?? op.match.member ?? "container");
        const argIndex =
          typeof op.target === "object" && op.target !== null
            ? op.target.argumentIndex
            : 0;
        outerHostContainers.push({
          spec: {
            id: label,
            label,
            match: op.match,
            argumentIndex: argIndex,
          },
          modelId: model.id,
        });
      }
    }
  }

  return {
    childItemScopes,
    outerHostContainers,
    containerInternalMatches: [
      ...outerHostContainers.map((c) => c.spec.match),
      ...models.flatMap((m) =>
        (m.cleanupOperations ?? []).map((op) => op.match),
      ),
      ...models.flatMap((m) =>
        (m.instanceBehaviors ?? [])
          .filter((b) => b.kind === "forwards-argument")
          .map((b) => b.match),
      ),
    ],
  };
}

function collectMatchKeywords(match: InstanceModelMatch): string[] {
  const out: string[] = [];
  if (match.symbol) {
    const parts = match.symbol.split(".");
    out.push(parts[parts.length - 1]!);
  }
  if (match.member) out.push(match.member);
  if (match.container && !match.member && !match.symbol) {
    out.push(match.container);
  }
  return out;
}

function matchesTargetSpec(
  match: InstanceModelMatch,
  target: {
    readonly name: string | null;
    readonly containerName: string | null;
    readonly file: string | null;
  },
): boolean {
  if (
    match.module &&
    target.file !== null &&
    !target.file.includes(match.module)
  ) {
    return false;
  }
  if (match.container && target.containerName !== match.container) {
    return false;
  }
  if (match.member && target.name !== match.member) {
    return false;
  }
  if (match.symbol) {
    if (match.symbol.includes(".")) {
      const qualified = target.containerName
        ? `${target.containerName}.${target.name ?? ""}`
        : (target.name ?? "");
      if (qualified !== match.symbol) return false;
    } else if (target.name !== match.symbol) {
      return false;
    }
  }
  return true;
}

function matchesSpec(match: InstanceModelMatch, info: CallInfo): boolean {
  return matchesTargetSpec(match, {
    name: info.memberName,
    containerName: info.containerName,
    file: info.declLocation?.file ?? null,
  });
}

function extractCalleeTextName(text: string): string | null {
  const trimmed = text.trim();
  const dotIdx = trimmed.lastIndexOf(".");
  if (dotIdx >= 0) {
    const tail = trimmed.slice(dotIdx + 1).trim();
    return tail.length > 0 ? tail : null;
  }
  return trimmed.length > 0 ? trimmed : null;
}

function baseTypeName(typeText: string): string {
  const angleIdx = typeText.indexOf("<");
  return (angleIdx >= 0 ? typeText.slice(0, angleIdx) : typeText).trim();
}

function isFunctionKind(kind: string): boolean {
  return (
    kind === "ArrowFunction" ||
    kind === "FunctionExpression" ||
    kind === "FunctionDeclaration" ||
    kind === "MethodDeclaration"
  );
}

function formatLocationShort(
  loc: DiagnosticLocation | null | undefined,
): string {
  if (!loc) return "<unknown>";
  return `${loc.file}:L${String(loc.line)}:${String(loc.column)}`;
}

async function resolveCallInfos(
  ctx: RuleContext,
  syntaxNodes: readonly SyntaxNodeResult[],
): Promise<readonly CallInfo[]> {
  if (syntaxNodes.length === 0) return [];

  const callRows = await ctx.resolveCalls(
    syntaxNodes.map((s) => s.ref),
    {
      select: {
        callee: true,
        calleeDeclaration: true,
        arguments: true,
      },
    },
  );

  const calleeRefs: SyntaxRef[] = [];
  const calleeIndices: number[] = [];
  const declTargets: (CallRef | SyntaxRef)[] = [];
  const declIndices: number[] = [];

  for (const [idx, row] of callRows.entries()) {
    if (row.callee) {
      calleeRefs.push(row.callee);
      calleeIndices.push(idx);
    }
    if (row.call) {
      declTargets.push(row.call);
      declIndices.push(idx);
    } else if (row.callee) {
      declTargets.push(row.callee);
      declIndices.push(idx);
    }
  }

  const [calleeSyntaxRows, declRows] = await Promise.all([
    calleeRefs.length > 0
      ? ctx.syntaxOf(calleeRefs, {
          select: { kind: true, text: true, expression: true, name: true },
        })
      : Promise.resolve([]),
    declTargets.length > 0
      ? ctx.resolveDeclarations(declTargets, {
          select: {
            name: true,
            containerName: true,
            kind: true,
            location: true,
            isExternal: true,
          },
        })
      : Promise.resolve([]),
  ]);

  const calleeSyntaxByIdx = new Map<
    number,
    (typeof calleeSyntaxRows)[number]
  >();
  for (const [i, row] of calleeSyntaxRows.entries()) {
    calleeSyntaxByIdx.set(calleeIndices[i]!, row);
  }

  const declByIdx = new Map<number, (typeof declRows)[number]>();
  for (const [i, row] of declRows.entries()) {
    declByIdx.set(declIndices[i]!, row);
  }

  const nameRefs: SyntaxRef[] = [];
  const nameIndices: number[] = [];
  const recvRefsForType: SyntaxRef[] = [];
  const recvIndices: number[] = [];

  for (const [idx, calleeRow] of calleeSyntaxByIdx.entries()) {
    if (calleeRow.name) {
      nameRefs.push(calleeRow.name);
      nameIndices.push(idx);
    }
    if (calleeRow.kind === "PropertyAccessExpression" && calleeRow.expression) {
      recvRefsForType.push(calleeRow.expression);
      recvIndices.push(idx);
    }
  }

  // `new ResourcePool(...)` resolves `call` to Constructor (often unnamed); resolve `callee` for class name.
  const newExprCalleeRefs: SyntaxRef[] = [];
  const newExprCalleeIndices: number[] = [];
  for (const [idx, syn] of syntaxNodes.entries()) {
    const decl = declByIdx.get(idx);
    const callee = callRows[idx]?.callee;
    if (
      syn.kind === "NewExpression" &&
      callee &&
      (!decl?.name || decl.kind === "Constructor")
    ) {
      newExprCalleeRefs.push(callee);
      newExprCalleeIndices.push(idx);
    }
  }

  const [nameRows, newClassDeclRows, recvTypes] = await Promise.all([
    nameRefs.length > 0
      ? ctx.syntaxOf(nameRefs, { select: { text: true } })
      : Promise.resolve([]),
    newExprCalleeRefs.length > 0
      ? ctx.resolveDeclarations(newExprCalleeRefs, {
          select: { name: true, location: true, isExternal: true },
        })
      : Promise.resolve([]),
    recvRefsForType.length > 0
      ? ctx.typeAt(recvRefsForType)
      : Promise.resolve([]),
  ]);

  const memberNameFromSyntax = new Map<number, string>();
  for (const [i, row] of nameRows.entries()) {
    if (row.text) memberNameFromSyntax.set(nameIndices[i]!, row.text);
  }

  const newClassDeclByIdx = new Map<
    number,
    (typeof newClassDeclRows)[number]
  >();
  for (const [i, row] of newClassDeclRows.entries()) {
    newClassDeclByIdx.set(newExprCalleeIndices[i]!, row);
  }

  const recvTypeByIdx = new Map<number, string>();
  for (const [i, row] of recvTypes.entries()) {
    recvTypeByIdx.set(recvIndices[i]!, baseTypeName(row.typeText));
  }

  return syntaxNodes.map((syn, idx) => {
    const callRow = callRows[idx]!;
    const calleeRow = calleeSyntaxByIdx.get(idx);
    const declRow = declByIdx.get(idx);
    const newClassRow = newClassDeclByIdx.get(idx);

    return {
      syntax: syn,
      call: callRow.call,
      callee: callRow.callee ?? null,
      calleeDeclaration: callRow.calleeDeclaration ?? null,
      arguments: callRow.arguments ?? [],
      memberName:
        newClassRow?.name ??
        declRow?.name ??
        memberNameFromSyntax.get(idx) ??
        (calleeRow?.text ? extractCalleeTextName(calleeRow.text) : null),
      containerName: declRow?.containerName ?? recvTypeByIdx.get(idx) ?? null,
      receiverExpr:
        calleeRow?.kind === "PropertyAccessExpression"
          ? (calleeRow.expression ?? null)
          : null,
      isExternal: newClassRow?.isExternal ?? declRow?.isExternal ?? false,
      declLocation: newClassRow?.location ?? declRow?.location ?? null,
    };
  });
}

async function getFileSyntaxNodes(
  ctx: RuleContext,
  file: string,
  cache: FileSyntaxCache,
): Promise<readonly SyntaxNodeResult[]> {
  const existing = cache.get(file);
  if (existing) return existing;
  const nodes = await ctx.findSyntax({
    files: [file],
    kinds: [
      "CallExpression",
      "NewExpression",
      "FunctionDeclaration",
      "MethodDeclaration",
      "ArrowFunction",
      "FunctionExpression",
      "VariableDeclaration",
      "ReturnStatement",
      "PropertyAssignment",
      "ShorthandPropertyAssignment",
    ],
  });
  cache.set(file, nodes);
  return nodes;
}

async function resolveScopeFunctionNode(
  ctx: RuleContext,
  cbArgRef: SyntaxRef,
  triggerFile: string,
  fileSyntaxCache: FileSyntaxCache,
): Promise<{
  readonly scopeFn: SyntaxNodeResult;
  readonly visitedFiles: readonly string[];
} | null> {
  const [argSnap] = await ctx.syntaxOf([cbArgRef], {
    select: { kind: true, location: true },
  });
  if (!argSnap?.location || !argSnap.kind) return null;

  const visitedFiles = new Set<string>([triggerFile]);
  const fileNodes = await getFileSyntaxNodes(ctx, triggerFile, fileSyntaxCache);
  let fnNode = fileNodes.find(
    (n) =>
      isFunctionKind(n.kind) &&
      n.location.start === argSnap.location!.start &&
      n.location.end === argSnap.location!.end,
  );

  if (!fnNode && !isFunctionKind(argSnap.kind)) {
    const [declRow] = await ctx.resolveDeclarations([cbArgRef], {
      select: { location: true, isExternal: true },
    });
    if (declRow?.location && !declRow.isExternal) {
      visitedFiles.add(declRow.location.file);
      const targetNodes = await getFileSyntaxNodes(
        ctx,
        declRow.location.file,
        fileSyntaxCache,
      );
      fnNode = targetNodes.find(
        (n) =>
          isFunctionKind(n.kind) &&
          n.location.start === declRow.location!.start &&
          n.location.end === declRow.location!.end,
      );
    }
  }

  if (!fnNode) return null;

  // Follow trivial wrapper arrows like `() => this.listFactory()` up to MAX_FACTORY_HOPS.
  let current = fnNode;
  for (let hop = 0; hop < MAX_FACTORY_HOPS; hop += 1) {
    const currentNodes = await getFileSyntaxNodes(
      ctx,
      current.location.file,
      fileSyntaxCache,
    );
    const innerCalls = currentNodes.filter(
      (n) =>
        n.kind === "CallExpression" &&
        isLocationWithin(n.location, current.location),
    );
    const innerVars = currentNodes.filter(
      (n) =>
        n.kind === "VariableDeclaration" &&
        isLocationWithin(n.location, current.location),
    );
    if (innerCalls.length !== 1 || innerVars.length > 0) break;

    const [resolvedCall] = await ctx.resolveCalls([innerCalls[0]!.ref]);
    if (!resolvedCall?.call) break;
    const [cRes] = await ctx.calleesOf([resolvedCall.call]);
    const targetDecl = cRes?.resolvedTargets[0];
    if (!targetDecl || targetDecl.isExternal || !targetDecl.location) break;

    visitedFiles.add(targetDecl.location.file);
    const nextNodes = await getFileSyntaxNodes(
      ctx,
      targetDecl.location.file,
      fileSyntaxCache,
    );
    const nextFn = nextNodes.find(
      (n) =>
        isFunctionKind(n.kind) &&
        n.location.start === targetDecl.location!.start &&
        n.location.end === targetDecl.location!.end,
    );
    if (!nextFn) break;
    current = nextFn;
  }
  return { scopeFn: current, visitedFiles: [...visitedFiles] };
}

async function discoverCandidateCalls(
  ctx: RuleContext,
  scopeSpecs: readonly ChildItemScopeSpec[],
): Promise<readonly SyntaxNodeResult[]> {
  const scopeKeywords = [
    ...new Set(scopeSpecs.flatMap((s) => collectMatchKeywords(s.match))),
  ];
  if (scopeKeywords.length === 0) return [];

  const aliasDecls = await ctx.findSyntax({
    kinds: ["ImportSpecifier", "VariableDeclaration"],
    textIncludes: scopeKeywords,
  });

  const effectiveKeywords = new Set<string>(scopeKeywords);
  for (const decl of aliasDecls) {
    if (decl.kind === "ImportSpecifier") {
      const asMatch = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(decl.text.trim());
      if (asMatch?.[1]) effectiveKeywords.add(asMatch[1]);
    } else if (decl.kind === "VariableDeclaration") {
      const lhsMatch = /^([A-Za-z_$][\w$]*)\s*[:=]/u.exec(decl.text.trim());
      if (lhsMatch?.[1]) effectiveKeywords.add(lhsMatch[1]);
    }
  }

  return ctx.findSyntax({
    kinds: ["CallExpression", "NewExpression"],
    calleeNames: [...effectiveKeywords],
  });
}

function buildProjectSourceLookup(
  sourceFiles: readonly string[],
): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  for (const file of sourceFiles) {
    map.set(normalizeRelPath(file), file);
  }
  return map;
}

/**
 * Derives reverse-search `lookupFiles` purely from program relations reachable
 * from the candidate pool and factory body, intersected with `ctx.project.sourceFiles`.
 */
async function discoverSemanticLookupFiles(
  ctx: RuleContext,
  entry: ScopeEntry,
  scopeCallInfos: readonly CallInfo[],
  config: ParsedModelConfig,
  fileSyntaxCache: FileSyntaxCache,
  projectSources: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  const discovered = new Set<string>();
  const addIfInProject = (filePath: string | null | undefined): boolean => {
    if (!filePath) return false;
    const matched = projectSources.get(normalizeRelPath(filePath));
    if (!matched || discovered.has(matched)) return false;
    if (discovered.size >= MAX_LOOKUP_FILES) return false;
    discovered.add(matched);
    return true;
  };

  addIfInProject(entry.triggerCall.syntax.location.file);
  addIfInProject(entry.scopeRange.file);
  for (const f of entry.visitedFiles) addIfInProject(f);

  const isModeledPrimitive = (c: CallInfo): boolean =>
    config.containerInternalMatches.some((m) => matchesSpec(m, c));

  const visitedDecls = new Set<string>();
  let frontierCalls: CallInfo[] = scopeCallInfos.filter(
    (c) => !isModeledPrimitive(c),
  );

  for (let hop = 0; hop < MAX_LOOKUP_HOPS; hop += 1) {
    const callRefs = frontierCalls
      .filter((c) => c.call !== null && !c.isExternal)
      .map((c) => c.call!);
    const argRefs = frontierCalls.flatMap((c) => c.arguments);

    for (const c of frontierCalls) {
      if (!c.isExternal && c.declLocation) {
        addIfInProject(c.declLocation.file);
      }
    }

    if (callRefs.length === 0 && argRefs.length === 0) break;

    const [calleesResults, argDecls] = await Promise.all([
      callRefs.length > 0 ? ctx.calleesOf(callRefs) : Promise.resolve([]),
      argRefs.length > 0
        ? ctx.resolveDeclarations(argRefs, {
            select: { location: true, isExternal: true },
          })
        : Promise.resolve([]),
    ]);

    for (const argDecl of argDecls) {
      if (!argDecl.isExternal && argDecl.location) {
        addIfInProject(argDecl.location.file);
      }
    }

    const nextCallNodes: SyntaxNodeResult[] = [];
    for (const cRes of calleesResults) {
      for (const target of cRes.resolvedTargets) {
        if (target.isExternal || !target.location) continue;
        addIfInProject(target.location.file);
        if (visitedDecls.has(target.declaration.handleId)) continue;
        visitedDecls.add(target.declaration.handleId);

        const targetNodes = await getFileSyntaxNodes(
          ctx,
          target.location.file,
          fileSyntaxCache,
        );
        for (const node of targetNodes) {
          if (
            (node.kind === "CallExpression" || node.kind === "NewExpression") &&
            isLocationWithin(node.location, target.location)
          ) {
            nextCallNodes.push(node);
          }
        }
      }
    }

    if (nextCallNodes.length === 0 || discovered.size >= MAX_LOOKUP_FILES) {
      break;
    }
    const resolvedNext = await resolveCallInfos(ctx, nextCallNodes);
    frontierCalls = resolvedNext.filter((c) => !isModeledPrimitive(c));
  }

  return [...discovered].toSorted();
}

function partitionScopeAst(
  fileNodes: readonly SyntaxNodeResult[],
  entry: ScopeEntry,
): ScopeAstPartition {
  const scopeCallsRaw: SyntaxNodeResult[] = [];
  const scopeFunctions: SyntaxNodeResult[] = [];
  const scopeVarDecls: SyntaxNodeResult[] = [];
  const scopeReturnStmts: SyntaxNodeResult[] = [];
  const scopePropAssignments: SyntaxNodeResult[] = [];
  const scopeShorthandProps: SyntaxNodeResult[] = [];

  for (const n of fileNodes) {
    if (!isLocationWithin(n.location, entry.scopeRange)) continue;
    if (
      (n.kind === "CallExpression" || n.kind === "NewExpression") &&
      !(
        n.location.start === entry.triggerCall.syntax.location.start &&
        n.location.end === entry.triggerCall.syntax.location.end
      )
    ) {
      scopeCallsRaw.push(n);
    } else if (isFunctionKind(n.kind)) {
      scopeFunctions.push(n);
    } else if (n.kind === "VariableDeclaration") {
      scopeVarDecls.push(n);
    } else if (n.kind === "ReturnStatement") {
      scopeReturnStmts.push(n);
    } else if (n.kind === "PropertyAssignment") {
      scopePropAssignments.push(n);
    } else if (n.kind === "ShorthandPropertyAssignment") {
      scopeShorthandProps.push(n);
    }
  }

  return {
    scopeCallsRaw,
    scopeFunctions,
    scopeVarDecls,
    scopeReturnStmts,
    scopePropAssignments,
    scopeShorthandProps,
  };
}

function resolveEnclosingScopeFunction(
  loc: DiagnosticLocation,
  allFunctions: readonly SyntaxNodeResult[],
  rootScope: SyntaxNodeResult,
): SyntaxNodeResult {
  let best = rootScope;
  let bestSpan = rootScope.location.end - rootScope.location.start;
  for (const fn of allFunctions) {
    if (
      isLocationWithin(loc, fn.location) &&
      isLocationWithin(fn.location, rootScope.location)
    ) {
      const span = fn.location.end - fn.location.start;
      if (span < bestSpan) {
        bestSpan = span;
        best = fn;
      }
    }
  }
  return best;
}

async function extractChildEndScopes(
  ctx: RuleContext,
  entry: ScopeEntry,
  partition: ScopeAstPartition,
): Promise<{
  readonly childEndScopes: readonly CleanupScopeRef[];
  readonly childEndRanges: readonly DiagnosticLocation[];
  readonly returnedExprs: readonly SyntaxRef[];
}> {
  const childEndScopes: CleanupScopeRef[] = [];
  const childEndRanges: DiagnosticLocation[] = [];
  const returnedExprs: SyntaxRef[] = [];

  const directReturns = partition.scopeReturnStmts.filter(
    (r) =>
      resolveEnclosingScopeFunction(
        r.location,
        partition.scopeFunctions,
        entry.scopeFn,
      ) === entry.scopeFn,
  );
  if (directReturns.length > 0) {
    const retSyntax = await ctx.syntaxOf(
      directReturns.map((r) => r.ref),
      { select: { expression: true } },
    );
    const retExprRefs = retSyntax
      .map((s) => s.expression)
      .filter((e): e is SyntaxRef => e !== undefined);
    const retExprSnaps =
      retExprRefs.length > 0
        ? await ctx.syntaxOf(retExprRefs, {
            select: { kind: true, location: true },
          })
        : [];
    let snapCursor = 0;

    for (const [idx, r] of directReturns.entries()) {
      const retExpr = retSyntax[idx]?.expression;
      if (!retExpr) continue;
      returnedExprs.push(retExpr);

      const retExprSnap = retExprSnaps[snapCursor];
      snapCursor += 1;
      const wrapperLoc =
        retExprSnap?.kind === "ObjectLiteralExpression" && retExprSnap.location
          ? retExprSnap.location
          : r.location;

      const isNestedInsideWrapper = (loc: DiagnosticLocation): boolean =>
        partition.scopeCallsRaw.some(
          (c) =>
            isLocationWithin(c.location, wrapperLoc) &&
            isLocationWithin(loc, c.location),
        ) ||
        partition.scopeFunctions.some(
          (f) =>
            f !== entry.scopeFn &&
            isLocationWithin(f.location, wrapperLoc) &&
            isLocationWithin(loc, f.location) &&
            !(loc.start === f.location.start && loc.end === f.location.end),
        );

      const topProps = partition.scopePropAssignments.filter(
        (p) =>
          isLocationWithin(p.location, wrapperLoc) &&
          !isNestedInsideWrapper(p.location),
      );
      if (topProps.length > 0) {
        const propRows = await ctx.syntaxOf(
          topProps.map((p) => p.ref),
          { select: { initializer: true } },
        );
        for (const [pIdx, propNode] of topProps.entries()) {
          const initRef = propRows[pIdx]?.initializer;
          if (!initRef) continue;
          if (/^\s*dispose\s*:/u.test(propNode.text)) {
            childEndScopes.push(initRef);
            childEndRanges.push(propNode.location);
          } else {
            returnedExprs.push(initRef);
          }
        }
      }

      const topShorthands = partition.scopeShorthandProps.filter(
        (sp) =>
          isLocationWithin(sp.location, wrapperLoc) &&
          !isNestedInsideWrapper(sp.location),
      );
      for (const sp of topShorthands) {
        const targetRef = sp.name ?? sp.ref;
        if (sp.text.trim() === "dispose") {
          childEndScopes.push(targetRef);
          childEndRanges.push(sp.location);
        } else {
          returnedExprs.push(targetRef);
        }
      }

      const disposeMethod = partition.scopeFunctions.find(
        (m) =>
          m.kind === "MethodDeclaration" &&
          isLocationWithin(m.location, wrapperLoc) &&
          !isNestedInsideWrapper(m.location) &&
          /^\s*(?:public\s+)?dispose\s*\(/u.test(m.text),
      );
      if (disposeMethod) {
        childEndScopes.push(disposeMethod.ref);
        childEndRanges.push(disposeMethod.location);
      }
    }
  } else if (entry.scopeFn.kind === "ArrowFunction" && entry.scopeFn.body) {
    returnedExprs.push(entry.scopeFn.body);
  }

  return { childEndScopes, childEndRanges, returnedExprs };
}

async function isInsideModeledContainerImpl(
  ctx: RuleContext,
  loc: DiagnosticLocation,
  config: ParsedModelConfig,
  fileSyntaxCache: FileSyntaxCache,
): Promise<boolean> {
  const fileNodes = await getFileSyntaxNodes(ctx, loc.file, fileSyntaxCache);
  const fns = fileNodes.filter(
    (n) => isFunctionKind(n.kind) && isLocationWithin(loc, n.location),
  );
  if (fns.length === 0) return false;
  let innermost = fns[0]!;
  for (const fn of fns) {
    if (
      fn.location.end - fn.location.start <
      innermost.location.end - innermost.location.start
    ) {
      innermost = fn;
    }
  }
  const [decl] = await ctx.resolveDeclarations([innermost.ref], {
    select: { name: true, containerName: true },
  });
  if (!decl) return false;
  return config.containerInternalMatches.some((m) =>
    matchesTargetSpec(m, {
      name: decl.name,
      containerName: decl.containerName,
      file: innermost.location.file,
    }),
  );
}

async function collectRegistrations(
  ctx: RuleContext,
  entry: ScopeEntry,
  partition: ScopeAstPartition,
  scopeCallInfos: readonly CallInfo[],
  childEndRanges: readonly DiagnosticLocation[],
  config: ParsedModelConfig,
  fileSyntaxCache: FileSyntaxCache,
  lookupFiles: readonly string[],
  checkedItemExprHandles: Set<string>,
): Promise<readonly RegistrationRecord[]> {
  const isInsideChildEnd = (loc: DiagnosticLocation): boolean =>
    childEndRanges.some((r) => isLocationWithin(loc, r));

  const directRegCalls = new Set<string>();
  const regCalls: RegistrationRecord[] = [];
  for (const callInfo of scopeCallInfos) {
    if (isInsideChildEnd(callInfo.syntax.location)) continue;
    for (const { spec, modelId } of config.outerHostContainers) {
      if (!matchesSpec(spec.match, callInfo)) continue;
      directRegCalls.add(callInfo.syntax.ref.handleId);
      const itemExpr = callInfo.arguments[spec.argumentIndex ?? 0];
      if (callInfo.receiverExpr && itemExpr) {
        regCalls.push({
          info: callInfo,
          containerSpec: spec,
          containerModelId: modelId,
          containerExpr: callInfo.receiverExpr,
          itemExpr,
          propagationResults: [],
        });
      }
      break;
    }
  }

  const hasRemoteCandidates =
    lookupFiles.length > 0 &&
    (partition.scopeVarDecls.some((v) => v.initializer) ||
      scopeCallInfos.length > 0);
  if (!hasRemoteCandidates) return regCalls;

  const outerKeywords = [
    ...new Set(
      config.outerHostContainers.flatMap(({ spec }) =>
        collectMatchKeywords(spec.match),
      ),
    ),
  ];
  if (outerKeywords.length === 0) return regCalls;

  const reverseCandidates = await ctx.findSyntax({
    files: lookupFiles,
    kinds: ["CallExpression", "NewExpression"],
    calleeNames: outerKeywords,
  });
  const reverseInfos = await resolveCallInfos(ctx, reverseCandidates);

  const remoteRegistrations: {
    readonly info: CallInfo;
    readonly containerSpec: OuterHostContainerSpec;
    readonly containerModelId: string;
    readonly containerExpr: SyntaxRef;
    readonly itemExpr: SyntaxRef;
  }[] = [];

  for (const info of reverseInfos) {
    if (isLocationWithin(info.syntax.location, entry.scopeRange)) continue;
    const matched = config.outerHostContainers.find(({ spec }) =>
      matchesSpec(spec.match, info),
    );
    if (!matched || !info.receiverExpr) continue;
    const itemExpr = info.arguments[matched.spec.argumentIndex ?? 0];
    if (!itemExpr) continue;
    if (
      await isInsideModeledContainerImpl(
        ctx,
        info.syntax.location,
        config,
        fileSyntaxCache,
      )
    ) {
      continue;
    }
    remoteRegistrations.push({
      info,
      containerSpec: matched.spec,
      containerModelId: matched.modelId,
      containerExpr: info.receiverExpr,
      itemExpr,
    });
  }

  if (remoteRegistrations.length === 0) return regCalls;

  const sourceValues = [
    ...partition.scopeVarDecls
      .filter((decl) => decl.initializer && !isInsideChildEnd(decl.location))
      .map((decl) => decl.initializer!),
    ...scopeCallInfos
      .filter(
        (call) =>
          !isInsideChildEnd(call.syntax.location) &&
          !directRegCalls.has(call.syntax.ref.handleId),
      )
      .flatMap((call) => call.arguments),
  ].filter(
    (ref, index, refs) =>
      refs.findIndex((c) => c.handleId === ref.handleId) === index,
  );

  if (sourceValues.length === 0) return regCalls;

  const propagation = await ctx.valuePropagation({
    propagation: "value",
    from: sourceValues,
    to: remoteRegistrations.map((reg) => reg.itemExpr),
    lookupFiles,
  });

  const rowsByTarget = new Map<string, ValuePropagationTargetResult[]>();
  for (const row of propagation.results) {
    if (!row.reachable) continue;
    const rows = rowsByTarget.get(row.to.handleId) ?? [];
    rows.push(row);
    rowsByTarget.set(row.to.handleId, rows);
  }

  for (const registration of remoteRegistrations) {
    const rows = rowsByTarget.get(registration.itemExpr.handleId) ?? [];
    if (rows.length === 0) continue;
    for (const row of rows) checkedItemExprHandles.add(row.from.handleId);
    regCalls.push({
      ...registration,
      propagationResults: rows,
    });
  }

  return regCalls;
}

async function findWronglyDisposedInstances(
  ctx: RuleContext,
  cleanupRes: InstanceCleanupScopeResult,
  expectedInstance: InstanceRef,
  expectedSyntax: SyntaxRef,
  scopeRange: DiagnosticLocation,
): Promise<readonly WronglyDisposedInfo[]> {
  const candidates = cleanupRes.disposedInstances.filter(
    (d) => !isSameInstance(d.instance, expectedInstance),
  );
  if (candidates.length === 0) return [];

  const [expectedTypeRow] = await ctx.typeAt([expectedSyntax]);
  const expectedTypeText = expectedTypeRow
    ? baseTypeName(expectedTypeRow.typeText)
    : "";

  const out: WronglyDisposedInfo[] = [];
  for (const cand of candidates) {
    const [siteRow] = await ctx.syntaxOf([cand.syntax], {
      select: { expression: true, text: true },
    });
    const recvExpr = siteRow?.expression
      ? (
          await ctx.syntaxOf([siteRow.expression], {
            select: { expression: true, text: true },
          })
        )[0]?.expression
      : undefined;

    let label = siteRow?.text ?? cand.instanceKey;
    let declaredAt: DiagnosticLocation | null = null;
    let declRow: WronglyDisposedInfo["declRow"] = null;
    let argSyntax: WronglyDisposedInfo["argSyntax"] = null;
    let argDeclRow: WronglyDisposedInfo["argDeclRow"] = null;
    let receiverDeclName: string | null = null;

    if (recvExpr) {
      const [[recvSyn], [recvDecl]] = await Promise.all([
        ctx.syntaxOf([recvExpr], { select: { text: true } }),
        ctx.resolveDeclarations([recvExpr], {
          select: { location: true, name: true },
        }),
      ]);
      if (recvSyn?.text) label = recvSyn.text;
      if (recvDecl?.location) {
        declaredAt = recvDecl.location;
        declRow = recvDecl;
      }
      if (recvDecl?.name) {
        label = recvDecl.name;
        receiverDeclName = recvDecl.name;
      }
    }

    if (cand.viaCall) {
      const [callTargets] = await ctx.calleesOf([cand.viaCall]);
      const bindings =
        callTargets?.resolvedTargets.flatMap((t) => t.parameterBindings) ?? [];
      const binding =
        bindings.find((b) => b.parameterName === receiverDeclName) ??
        bindings[0];
      if (binding) {
        const [[argSyn], [argDecl]] = await Promise.all([
          ctx.syntaxOf([binding.argument], {
            select: { text: true, location: true },
          }),
          ctx.resolveDeclarations([binding.argument], {
            select: { location: true },
          }),
        ]);
        if (argSyn) argSyntax = argSyn;
        if (argSyn?.text) label = argSyn.text;
        if (argDecl) argDeclRow = argDecl;
        if (argDecl?.location) declaredAt = argDecl.location;
      }
    }

    const allocatedOutsideScope =
      cand.allocationLocation === null ||
      !isLocationWithin(cand.allocationLocation, scopeRange);
    if (allocatedOutsideScope) {
      out.push({
        site: cand,
        label,
        declaredAt,
        declRow,
        argSyntax,
        argDeclRow,
      });
      continue;
    }

    if (recvExpr && expectedTypeText.length > 0) {
      const [candTypeRow] = await ctx.typeAt([recvExpr]);
      if (
        candTypeRow &&
        baseTypeName(candTypeRow.typeText) === expectedTypeText
      ) {
        out.push({
          site: cand,
          label,
          declaredAt,
          declRow,
          argSyntax,
          argDeclRow,
        });
      }
    }
  }

  return out;
}

function appendWronglyDisposedBasis(
  basis: DiagnosticBasis[],
  wronglyDisposed: readonly WronglyDisposedInfo[],
): void {
  for (const w of wronglyDisposed) {
    basis.push(w.site);
    if (w.argSyntax) basis.push(w.argSyntax);
    if (w.argDeclRow) basis.push(w.argDeclRow);
    if (w.declRow) basis.push(w.declRow);
  }
}

function formatWrongClause(
  wronglyDisposed: readonly WronglyDisposedInfo[],
  prefix: string,
): string {
  if (wronglyDisposed.length === 0) return "";
  const names = wronglyDisposed.map((w) => w.label).join(", ");
  const locs = wronglyDisposed
    .map((w) => formatLocationShort(w.site.location))
    .join(", ");
  const decls = wronglyDisposed.some((w) => w.declaredAt)
    ? `, declared at ${wronglyDisposed
        .map((w) => formatLocationShort(w.declaredAt))
        .join(", ")}`
    : "";
  return `${prefix}'${names}' at ${locs}${decls}`;
}

function appendScopeOriginBasis(
  basis: DiagnosticBasis[],
  ctx: RuleContext,
  entry: ScopeEntry,
  extraModelId?: string,
): void {
  const scopeModel = ctx.getModel(entry.modelId);
  if (scopeModel) basis.push(scopeModel);
  if (extraModelId && extraModelId !== entry.modelId) {
    const extraModel = ctx.getModel(extraModelId);
    if (extraModel) basis.push(extraModel);
  }
  basis.push(entry.triggerCall.syntax);
  if (
    entry.scopeFn.location.file !== entry.triggerCall.syntax.location.file ||
    entry.scopeFn.location.start !== entry.triggerCall.syntax.location.start
  ) {
    basis.push(entry.scopeFn);
  }
}

async function surfaceExternalCleanupGaps(
  ctx: RuleContext,
  scopeCallInfos: readonly CallInfo[],
  childEndRanges: readonly DiagnosticLocation[],
  targetInstance: InstanceRef,
  lookupFiles: readonly string[],
): Promise<void> {
  const endCalls = scopeCallInfos.filter(
    (c) =>
      c.isExternal &&
      c.arguments.length > 0 &&
      childEndRanges.some((r) => isLocationWithin(c.syntax.location, r)),
  );
  if (endCalls.length === 0) return;

  const argResolutions = await ctx.resolveInstances(
    endCalls.flatMap((c) => c.arguments),
    { lookupFiles },
  );
  const matchingCallSyntaxes: SyntaxRef[] = [];
  let cursor = 0;
  for (const callInfo of endCalls) {
    let passesTarget = false;
    for (let i = 0; i < callInfo.arguments.length; i += 1) {
      const res = argResolutions[cursor];
      cursor += 1;
      if (res?.instance && isSameInstance(res.instance, targetInstance)) {
        passesTarget = true;
      }
    }
    if (passesTarget) matchingCallSyntaxes.push(callInfo.syntax.ref);
  }
  if (matchingCallSyntaxes.length > 0) {
    await ctx.resolveInstances(matchingCallSyntaxes, { lookupFiles });
  }
}

async function evaluateRegistrations(
  ctx: RuleContext,
  entry: ScopeEntry,
  regCalls: readonly RegistrationRecord[],
  childEndScopes: readonly CleanupScopeRef[],
  lookupFiles: readonly string[],
  checkedItemExprHandles: Set<string>,
  reportedKeys: Set<string>,
): Promise<{
  readonly localContainersByKey: ReadonlyMap<string, LocalContainerRecord>;
  readonly localContainerVarLocKeys: ReadonlySet<string>;
  readonly registeredDeclIds: ReadonlySet<string>;
}> {
  const localContainersByKey = new Map<string, LocalContainerRecord>();
  const localContainerVarLocKeys = new Set<string>();
  const registeredDeclIds = new Set<string>();

  if (regCalls.length === 0) {
    return {
      localContainersByKey,
      localContainerVarLocKeys,
      registeredDeclIds,
    };
  }

  const [containerResolutions, itemDeclRows, itemSynRows] = await Promise.all([
    ctx.resolveInstances(
      regCalls.map((r) => r.containerExpr),
      { lookupFiles },
    ),
    ctx.resolveDeclarations(
      regCalls.map((r) => r.itemExpr),
      { select: { kind: true, isExternal: true } },
    ),
    ctx.syntaxOf(
      regCalls.map((r) => r.itemExpr),
      { select: { kind: true, text: true, location: true } },
    ),
  ]);

  for (const [idx, reg] of regCalls.entries()) {
    checkedItemExprHandles.add(reg.info.syntax.ref.handleId);
    checkedItemExprHandles.add(reg.itemExpr.handleId);

    const itemDecl = itemDeclRows[idx];
    if (itemDecl?.declaration) {
      registeredDeclIds.add(itemDecl.declaration.handleId);
    }

    const containerRes = containerResolutions[idx];
    const isLocalContainer =
      containerRes?.allocationLocation !== null &&
      containerRes?.allocationLocation !== undefined &&
      isLocationWithin(containerRes.allocationLocation, entry.scopeRange);

    if (isLocalContainer && containerRes.instance && containerRes.instanceKey) {
      if (!localContainersByKey.has(containerRes.instanceKey)) {
        localContainersByKey.set(containerRes.instanceKey, {
          instance: containerRes.instance,
          instanceKey: containerRes.instanceKey,
          allocationLocation: containerRes.allocationLocation,
          firstRegistration: reg.info,
        });
        localContainerVarLocKeys.add(
          `${containerRes.allocationLocation.file}:${String(containerRes.allocationLocation.start)}:${String(containerRes.allocationLocation.end)}`,
        );
      }
      continue;
    }

    const itemSyn = itemSynRows[idx];
    const isDynamicLocalCallback =
      itemSyn?.kind === "CallExpression" &&
      !itemDecl?.isExternal &&
      (itemDecl?.kind === "Parameter" ||
        itemDecl?.kind === "FunctionType" ||
        itemDecl?.kind === "CallSignature" ||
        itemDecl?.kind === "MethodSignature" ||
        itemDecl === undefined ||
        itemDecl.kind === null);

    let itemRes: InstanceResolutionResult | undefined;
    if (!isDynamicLocalCallback) {
      [itemRes] = await ctx.resolveInstances([reg.itemExpr], { lookupFiles });
    }

    let coveredOnChildEnd = false;
    let cleanupScopeRes: InstanceCleanupScopeResult | undefined;
    if (itemRes?.instance && childEndScopes.length > 0) {
      const cleanupResults = await ctx.instanceCleanup({
        scopes: childEndScopes,
        targets: [itemRes.instance],
        lookupFiles,
      });
      cleanupScopeRes = cleanupResults[0];
      if (
        cleanupResults.length > 0 &&
        cleanupResults.every((r) => r.targetResults[0]?.cleanedOnAllPaths)
      ) {
        coveredOnChildEnd = true;
      }
    }

    if (coveredOnChildEnd) {
      ctx.checkpoint(
        "outer-registered-child-disposed-on-end",
        reg.info.syntax.location,
        "pass",
        () => ({
          scopeId: entry.spec.id,
          instanceKey: itemRes?.instanceKey ?? null,
        }),
      );
      continue;
    }

    const findingKey = `${entry.spec.id}:outer-reg:${reg.info.syntax.location.file}:${String(reg.info.syntax.location.start)}:${String(reg.info.syntax.location.end)}`;
    if (reportedKeys.has(findingKey)) continue;
    reportedKeys.add(findingKey);

    const wronglyDisposed =
      cleanupScopeRes && itemRes?.instance
        ? await findWronglyDisposedInstances(
            ctx,
            cleanupScopeRes,
            itemRes.instance,
            reg.itemExpr,
            entry.scopeRange,
          )
        : [];

    const basis: DiagnosticBasis[] = [];
    appendScopeOriginBasis(basis, ctx, entry, reg.containerModelId);
    basis.push(reg.info.syntax, {
      kind: "model",
      modelId: reg.containerModelId,
      message: `${reg.containerSpec.label} registers child resource onto outer host container`,
      at: reg.info.syntax.location,
    });
    if (itemRes) basis.push(itemRes);
    basis.push(...reg.propagationResults);
    appendWronglyDisposedBasis(basis, wronglyDisposed);

    const wrongClause = formatWrongClause(
      wronglyDisposed,
      " (child cleanup instead disposed ",
    );
    const closedWrongClause = wrongClause.length > 0 ? `${wrongClause})` : "";
    const targetDesc =
      itemSyn?.text?.slice(0, 60) ?? itemRes?.instanceKey ?? "child resource";

    ctx.report({
      at: reg.info.syntax.location,
      findingKey,
      message: `Child resource '${targetDesc}' inside ${entry.spec.label} is registered on outer host container (${reg.containerSpec.label}) without being disposed when the child item ends${closedWrongClause}.`,
      basis,
    });
  }

  return { localContainersByKey, localContainerVarLocKeys, registeredDeclIds };
}

async function verifyLocalContainers(
  ctx: RuleContext,
  entry: ScopeEntry,
  localContainersByKey: ReadonlyMap<string, LocalContainerRecord>,
  childEndScopes: readonly CleanupScopeRef[],
  returnedExprs: readonly SyntaxRef[],
  lookupFiles: readonly string[],
  reportedKeys: Set<string>,
): Promise<void> {
  for (const localContainer of localContainersByKey.values()) {
    let covered = false;
    let cleanupScopeRes: InstanceCleanupScopeResult | undefined;

    if (
      returnedExprs.length > 0 &&
      localContainer.firstRegistration.receiverExpr
    ) {
      const prop = await ctx.valuePropagation({
        propagation: "value",
        from: [localContainer.firstRegistration.receiverExpr],
        to: returnedExprs,
        lookupFiles,
      });
      if (prop.reachableTargets.length > 0) covered = true;
    }

    if (!covered && childEndScopes.length > 0) {
      const cleanupResults = await ctx.instanceCleanup({
        scopes: childEndScopes,
        targets: [localContainer.instance],
        lookupFiles,
      });
      cleanupScopeRes = cleanupResults[0];
      if (
        cleanupResults.length > 0 &&
        cleanupResults.every((r) => r.targetResults[0]?.cleanedOnAllPaths)
      ) {
        covered = true;
      }
    }

    if (covered) {
      ctx.checkpoint(
        "local-child-container-disposed",
        localContainer.allocationLocation,
        "pass",
        () => ({
          scopeId: entry.spec.id,
          instanceKey: localContainer.instanceKey,
        }),
      );
      continue;
    }

    const findingKey = `${entry.spec.id}:local-store:${localContainer.allocationLocation.file}:${String(localContainer.allocationLocation.start)}:${String(localContainer.allocationLocation.end)}`;
    if (reportedKeys.has(findingKey)) continue;
    reportedKeys.add(findingKey);

    const wronglyDisposed =
      cleanupScopeRes && localContainer.firstRegistration.receiverExpr
        ? await findWronglyDisposedInstances(
            ctx,
            cleanupScopeRes,
            localContainer.instance,
            localContainer.firstRegistration.receiverExpr,
            entry.scopeRange,
          )
        : [];

    const basis: DiagnosticBasis[] = [];
    appendScopeOriginBasis(basis, ctx, entry);
    basis.push(localContainer.firstRegistration.syntax);
    appendWronglyDisposedBasis(basis, wronglyDisposed);

    const wrongClause = formatWrongClause(wronglyDisposed, " (disposed ");
    const closedWrongClause =
      wrongClause.length > 0 ? `${wrongClause} instead)` : "";

    ctx.report({
      at: localContainer.allocationLocation,
      findingKey,
      message: `Per-item container '${localContainer.instanceKey}' inside ${entry.spec.label} is not disposed when the child item ends${closedWrongClause}.`,
      basis,
    });
  }
}

async function verifyUnregisteredDisposables(
  ctx: RuleContext,
  entry: ScopeEntry,
  partition: ScopeAstPartition,
  scopeCallInfos: readonly CallInfo[],
  childEndScopes: readonly CleanupScopeRef[],
  childEndRanges: readonly DiagnosticLocation[],
  returnedExprs: readonly SyntaxRef[],
  localContainerVarLocKeys: ReadonlySet<string>,
  registeredDeclIds: ReadonlySet<string>,
  checkedItemExprHandles: ReadonlySet<string>,
  lookupFiles: readonly string[],
  reportedKeys: Set<string>,
): Promise<void> {
  const isInsideChildEnd = (loc: DiagnosticLocation): boolean =>
    childEndRanges.some((r) => isLocationWithin(loc, r));

  const candidateVars = partition.scopeVarDecls.filter((v) => {
    if (isInsideChildEnd(v.location)) return false;
    if (!v.initializer) return false;
    const locKey = `${v.location.file}:${String(v.location.start)}:${String(v.location.end)}`;
    return !localContainerVarLocKeys.has(locKey);
  });
  if (candidateVars.length === 0) return;

  const [initSyns, varDeclRows] = await Promise.all([
    ctx.syntaxOf(
      candidateVars.map((v) => v.initializer!),
      { select: { kind: true, text: true, location: true } },
    ),
    ctx.resolveDeclarations(candidateVars.map((v) => v.ref)),
  ]);

  const callOrNewVars: {
    readonly initRef: SyntaxRef;
    readonly initText: string;
    readonly initLoc: DiagnosticLocation;
  }[] = [];

  for (const [idx, varDecl] of candidateVars.entries()) {
    const syn = initSyns[idx];
    if (!syn?.location) continue;
    if (syn.kind !== "CallExpression" && syn.kind !== "NewExpression") continue;
    if (checkedItemExprHandles.has(varDecl.initializer!.handleId)) continue;
    const declId = varDeclRows[idx]?.declaration?.handleId;
    if (declId && registeredDeclIds.has(declId)) continue;

    callOrNewVars.push({
      initRef: varDecl.initializer!,
      initText: syn.text ?? varDecl.text,
      initLoc: syn.location,
    });
  }
  if (callOrNewVars.length === 0) return;

  const varTypes = await ctx.typeAt(callOrNewVars.map((v) => v.initRef));
  const projectedTypes =
    varTypes.length > 0
      ? await ctx.projectTypes(
          varTypes.map((t) => t.ref),
          { select: { properties: true } },
        )
      : [];

  const disposableVars = callOrNewVars.filter((_, idx) =>
    (projectedTypes[idx]?.properties ?? []).some((p) => p.name === "dispose"),
  );
  if (disposableVars.length === 0) return;

  const returnedHandleIds = new Set<string>();
  if (returnedExprs.length > 0) {
    const prop = await ctx.valuePropagation({
      propagation: "value",
      from: disposableVars.map((v) => v.initRef),
      to: returnedExprs,
      lookupFiles,
    });
    for (const row of prop.results) {
      if (row.reachable) returnedHandleIds.add(row.from.handleId);
    }
  }

  const remainingVars = disposableVars.filter(
    (v) => !returnedHandleIds.has(v.initRef.handleId),
  );
  if (remainingVars.length === 0) return;

  const instResolutions = await ctx.resolveInstances(
    remainingVars.map((v) => v.initRef),
    { lookupFiles },
  );

  for (const [idx, item] of remainingVars.entries()) {
    const instRes = instResolutions[idx];
    if (!instRes?.instance) continue;

    let covered = false;
    let cleanupScopeRes: InstanceCleanupScopeResult | undefined;
    if (childEndScopes.length > 0) {
      const cleanupResults = await ctx.instanceCleanup({
        scopes: childEndScopes,
        targets: [instRes.instance],
        lookupFiles,
      });
      cleanupScopeRes = cleanupResults[0];
      if (
        cleanupResults.length > 0 &&
        cleanupResults.every((r) => r.targetResults[0]?.cleanedOnAllPaths)
      ) {
        covered = true;
      }
    }

    if (covered) {
      ctx.checkpoint(
        "child-allocated-resource-disposed",
        item.initLoc,
        "pass",
        () => ({
          scopeId: entry.spec.id,
          instanceKey: instRes.instanceKey,
        }),
      );
      continue;
    }

    if (childEndRanges.length > 0) {
      await surfaceExternalCleanupGaps(
        ctx,
        scopeCallInfos,
        childEndRanges,
        instRes.instance,
        lookupFiles,
      );
    }

    const findingKey = `${entry.spec.id}:var-leak:${item.initLoc.file}:${String(item.initLoc.start)}:${String(item.initLoc.end)}`;
    if (reportedKeys.has(findingKey)) continue;
    reportedKeys.add(findingKey);

    const wronglyDisposed = cleanupScopeRes
      ? await findWronglyDisposedInstances(
          ctx,
          cleanupScopeRes,
          instRes.instance,
          item.initRef,
          entry.scopeRange,
        )
      : [];

    const basis: DiagnosticBasis[] = [];
    appendScopeOriginBasis(basis, ctx, entry);
    basis.push(instRes);
    appendWronglyDisposedBasis(basis, wronglyDisposed);

    const wrongClause = formatWrongClause(
      wronglyDisposed,
      "; child cleanup instead disposed ",
    );

    ctx.report({
      at: item.initLoc,
      findingKey,
      message: `Child resource '${item.initText.slice(0, 60)}' (${formatLocationShort(item.initLoc)}) allocated inside ${entry.spec.label} is not disposed when the child item ends${wrongClause}.`,
      basis,
    });
  }
}

async function checkChildScope(
  ctx: RuleContext,
  entry: ScopeEntry,
  config: ParsedModelConfig,
  fileSyntaxCache: FileSyntaxCache,
  projectSources: ReadonlyMap<string, string>,
  reportedKeys: Set<string>,
): Promise<void> {
  const fileNodes = await getFileSyntaxNodes(
    ctx,
    entry.scopeRange.file,
    fileSyntaxCache,
  );
  const partition = partitionScopeAst(fileNodes, entry);
  const scopeCallInfos = await resolveCallInfos(ctx, partition.scopeCallsRaw);
  const lookupFiles = await discoverSemanticLookupFiles(
    ctx,
    entry,
    scopeCallInfos,
    config,
    fileSyntaxCache,
    projectSources,
  );

  ctx.checkpoint(
    "child-ownership-reverse-domain",
    entry.scopeRange,
    "info",
    () => ({
      scopeId: entry.spec.id,
      lookupFiles,
    }),
  );

  const { childEndScopes, childEndRanges, returnedExprs } =
    await extractChildEndScopes(ctx, entry, partition);

  const checkedItemExprHandles = new Set<string>();
  const regCalls = await collectRegistrations(
    ctx,
    entry,
    partition,
    scopeCallInfos,
    childEndRanges,
    config,
    fileSyntaxCache,
    lookupFiles,
    checkedItemExprHandles,
  );

  const { localContainersByKey, localContainerVarLocKeys, registeredDeclIds } =
    await evaluateRegistrations(
      ctx,
      entry,
      regCalls,
      childEndScopes,
      lookupFiles,
      checkedItemExprHandles,
      reportedKeys,
    );

  await verifyLocalContainers(
    ctx,
    entry,
    localContainersByKey,
    childEndScopes,
    returnedExprs,
    lookupFiles,
    reportedKeys,
  );

  await verifyUnregisteredDisposables(
    ctx,
    entry,
    partition,
    scopeCallInfos,
    childEndScopes,
    childEndRanges,
    returnedExprs,
    localContainerVarLocKeys,
    registeredDeclIds,
    checkedItemExprHandles,
    lookupFiles,
    reportedKeys,
  );
}

/**
 * Declares a model specifying pool/child-item scopes, outer host registration
 * containers, and instance allocation/cleanup behaviors.
 */
export function definePoolResourceOwnershipModel(
  options: PoolResourceOwnershipModelOptions,
): Model {
  return defineModel({
    id: options.id,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    ...(options.instanceBehaviors !== undefined
      ? { instanceBehaviors: options.instanceBehaviors }
      : {}),
    ...(options.cleanupOperations !== undefined
      ? { cleanupOperations: options.cleanupOperations }
      : {}),
    ...(options.lifecycleEvents !== undefined
      ? { lifecycleEvents: options.lifecycleEvents }
      : {}),
    facts: options.facts,
  });
}

/**
 * Shared project model calibrated against VS Code PR #290505 for `ResourcePool`,
 * `Disposable._register`, `DisposableStore.add/delete`, and `IInstantiationService.createInstance`.
 */
export const poolResourceOwnershipModel: Model =
  definePoolResourceOwnershipModel({
    id: "pool-resource-ownership",
    version: "1",
    description:
      "Models Disposable._register, DisposableStore.add/delete, IInstantiationService.createInstance, and ResourcePool item factories.",
    instanceBehaviors: [
      {
        kind: "forwards-argument",
        match: { container: "Disposable", member: "_register" },
        argumentIndex: 0,
        description: "Disposable._register returns its registered disposable",
      },
      {
        kind: "forwards-argument",
        match: { container: "DisposableStore", member: "add" },
        argumentIndex: 0,
        description: "DisposableStore.add returns its added disposable",
      },
      {
        kind: "allocates-fresh-instance",
        match: {
          container: "IInstantiationService",
          member: "createInstance",
        },
        description:
          "IInstantiationService.createInstance allocates a fresh component instance",
      },
    ],
    cleanupOperations: [
      {
        kind: "disposes-target",
        match: { member: "dispose" },
        target: "receiver",
        description: ".dispose() disposes the receiver resource instance",
      },
      {
        kind: "registers-into-container",
        match: { container: "Disposable", member: "_register" },
        target: { argumentIndex: 0 },
        containerTarget: "receiver",
        description:
          "Disposable._register registers child into the outer Disposable host",
      },
      {
        kind: "registers-into-container",
        match: { container: "DisposableStore", member: "add" },
        target: { argumentIndex: 0 },
        containerTarget: "receiver",
        description:
          "DisposableStore.add registers child into the DisposableStore container",
      },
      {
        kind: "detaches-from-container",
        match: { container: "DisposableStore", member: "delete" },
        target: { argumentIndex: 0 },
        containerTarget: "receiver",
        description:
          "DisposableStore.delete detaches a child item from the DisposableStore container",
      },
      {
        kind: "detaches-from-container",
        match: { container: "DisposableStore", member: "deleteAndLeak" },
        target: { argumentIndex: 0 },
        containerTarget: "receiver",
        description:
          "DisposableStore.deleteAndLeak detaches a child item from DisposableStore without disposing it",
      },
    ],
    facts: {
      childItemScopes: [
        {
          id: "resource-pool",
          kind: "factory-delegation",
          label: "ResourcePool item factory",
          match: { symbol: "ResourcePool" },
          callbackArgumentIndex: 0,
        },
      ],
      outerHostContainers: [
        {
          id: "disposable-register",
          label: "Disposable._register",
          match: { container: "Disposable", member: "_register" },
          argumentIndex: 0,
        },
        {
          id: "disposable-store-add",
          label: "DisposableStore.add",
          match: { container: "DisposableStore", member: "add" },
          argumentIndex: 0,
        },
      ],
    },
  });

/**
 * Creates a rule verifying that resources created inside coexisting pool/child
 * item factories are owned and disposed by each item rather than registered on
 * an outer host container or leaked on item disposal.
 */
export function createPoolResourceOwnershipRule(
  options: PoolResourceOwnershipRuleOptions = {},
): Rule {
  return defineRule({
    id: options.id ?? "pool-resource-ownership",
    description:
      options.description ??
      "Verify that resources created inside pool item factories are owned and disposed per item rather than registered on an outer host container.",
    run: async (ctx) => {
      const config = parseModelConfig(ctx.models);
      if (config.childItemScopes.length === 0) return;

      const scopeSpecs = config.childItemScopes.map((s) => s.spec);
      const candidateCalls = await discoverCandidateCalls(ctx, scopeSpecs);
      if (candidateCalls.length === 0) return;

      ctx.checkpoint(
        "child-ownership-candidate-domain",
        candidateCalls[0]!.location,
        "info",
        () => ({ candidateCallCount: candidateCalls.length }),
      );

      const fileSyntaxCache: FileSyntaxCache = new Map();
      const callInfos = await resolveCallInfos(ctx, candidateCalls);
      const projectSources = buildProjectSourceLookup(ctx.project.sourceFiles);

      const scopeEntries: ScopeEntry[] = [];
      for (const info of callInfos) {
        const matched = config.childItemScopes.find(({ spec }) =>
          matchesSpec(spec.match, info),
        );
        if (!matched) continue;

        ctx.checkpoint(
          "child-ownership-seed",
          info.syntax.location,
          "pass",
          () => ({
            scopeId: matched.spec.id,
            scopeKind: matched.spec.kind,
            seedFile: info.syntax.location.file,
          }),
        );

        const cbArg = info.arguments[matched.spec.callbackArgumentIndex ?? 0];
        if (!cbArg) continue;

        const resolvedScope = await resolveScopeFunctionNode(
          ctx,
          cbArg,
          info.syntax.location.file,
          fileSyntaxCache,
        );
        if (!resolvedScope) continue;

        scopeEntries.push({
          spec: matched.spec,
          modelId: matched.modelId,
          triggerCall: info,
          scopeFn: resolvedScope.scopeFn,
          scopeRange: resolvedScope.scopeFn.location,
          visitedFiles: resolvedScope.visitedFiles,
        });
      }

      const reportedKeys = new Set<string>();
      for (const entry of scopeEntries) {
        await checkChildScope(
          ctx,
          entry,
          config,
          fileSyntaxCache,
          projectSources,
          reportedKeys,
        );
      }
    },
  });
}

/** Default rule checking pool item resource ownership via `poolResourceOwnershipModel` or custom models. */
export const poolResourceOwnershipRule: Rule =
  createPoolResourceOwnershipRule();
