import {
  defineModel,
  defineRule,
  type BranchEdgeInfo,
  type CallEffectsResult,
  type DeclarationRef,
  type DiagnosticLocation,
  type Evidence,
  type FieldEffect,
  type Model,
  type Rule,
  type RuleContext,
  type SyntaxNodeResult,
  type SyntaxRef,
} from "@verule/sdk";

/** Declarative contract describing a reentrant queue, its queued flag, and its reentrancy opt-in flag. */
export type ReentrantQueueContract = {
  readonly id?: string;
  /** Logical queue identifier surfaced in diagnostics and evidence (e.g. `"main-scheduler-queue"`). */
  readonly queueName: string;
  /** Name of the function that sets the queued bitflag and enqueues items. */
  readonly enqueueFunctionName: string;
  /** Identifier of the queue collection variable read by flush loops. */
  readonly queueIdentifier: string;
  /** Property name on queued items storing the bitmask flags (e.g. `"flags"`). */
  readonly flagProperty: string;
  /** Enum/constant member name representing the queued bit (e.g. `"QUEUED"`). */
  readonly queuedFlagName: string;
  /** Enum/constant member name allowing recursive re-enqueue during callback execution (e.g. `"ALLOW_RECURSE"`). */
  readonly reentrantFlagName: string;
};

export type ReentrantQueueModelOptions = {
  readonly id: string;
  readonly version?: string;
  readonly description?: string;
  readonly contracts: readonly ReentrantQueueContract[];
};

export type ReentrantQueueFlagRuleOptions = {
  readonly id?: string;
  readonly description?: string;
  readonly contracts?: readonly ReentrantQueueContract[];
};

type ResolvedContract = ReentrantQueueContract & {
  readonly contractId: string;
  readonly modelId: string;
};

type LocationKey = string;

type QueueEnqueueState = {
  readonly queueDeclKeys: ReadonlySet<LocationKey>;
  readonly enqueueEvidence: readonly Evidence[];
};

type CallbackInvocationMatch = {
  readonly kind: "direct" | "indirect";
  readonly itemDeclKey: LocationKey;
  readonly callLocation: DiagnosticLocation;
  readonly helperDeclLocation?: DiagnosticLocation;
  readonly helperInvokeLocation?: DiagnosticLocation;
  readonly evidence: readonly Evidence[];
};

type FlagClearCandidate = {
  readonly write: FieldEffect;
  readonly itemDeclKey: LocationKey;
  readonly itemDeclLocation: DiagnosticLocation;
  readonly queueReadLocation: DiagnosticLocation;
};

function locationKey(loc: DiagnosticLocation): LocationKey {
  return `${loc.file}:${loc.start}:${loc.end}`;
}

function insideSpan(
  inner: DiagnosticLocation,
  outer: DiagnosticLocation,
): boolean {
  return (
    inner.file === outer.file &&
    inner.start >= outer.start &&
    inner.end <= outer.end
  );
}

function spanLength(loc: DiagnosticLocation): number {
  return loc.end - loc.start;
}

function dedupeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function hasNonEmptyStringProperty(obj: object, key: string): boolean {
  if (!(key in obj)) return false;
  const val: unknown = Reflect.get(obj, key);
  return typeof val === "string" && val.length > 0;
}

function isReentrantQueueContract(
  value: unknown,
): value is ReentrantQueueContract {
  if (typeof value !== "object" || value === null) return false;
  return (
    hasNonEmptyStringProperty(value, "queueName") &&
    hasNonEmptyStringProperty(value, "enqueueFunctionName") &&
    hasNonEmptyStringProperty(value, "queueIdentifier") &&
    hasNonEmptyStringProperty(value, "flagProperty") &&
    hasNonEmptyStringProperty(value, "queuedFlagName") &&
    hasNonEmptyStringProperty(value, "reentrantFlagName")
  );
}

function extractContracts(
  ctx: RuleContext,
  optionContracts: readonly ReentrantQueueContract[] | undefined,
): readonly ResolvedContract[] {
  const out: ResolvedContract[] = [];
  const seen = new Set<string>();

  for (const model of ctx.models) {
    const raw = model.facts?.reentrantQueueContracts;
    if (!Array.isArray(raw)) continue;
    for (const item of raw) {
      if (!isReentrantQueueContract(item)) continue;
      const contractId = item.id ?? item.queueName;
      const dedupeKey = `${model.id}:${contractId}:${item.enqueueFunctionName}:${item.queueIdentifier}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        out.push({
          ...item,
          contractId,
          modelId: model.id,
        });
      }
    }
  }

  if (optionContracts !== undefined) {
    for (const item of optionContracts) {
      const contractId = item.id ?? item.queueName;
      const dedupeKey = `rule-options:${contractId}:${item.enqueueFunctionName}:${item.queueIdentifier}`;
      if (!seen.has(dedupeKey)) {
        seen.add(dedupeKey);
        out.push({
          ...item,
          contractId,
          modelId: "rule-options",
        });
      }
    }
  }

  return out;
}

function extractDeclaredFunctionName(fn: SyntaxNodeResult): string | null {
  const match =
    /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/u.exec(
      fn.text.trimStart(),
    );
  return match?.[1] ?? null;
}

function matchesFlagClearSyntax(
  text: string,
  contract: ResolvedContract,
): boolean {
  return (
    text.includes(`.${contract.flagProperty}`) &&
    text.includes("&=") &&
    text.includes("~") &&
    text.includes(contract.queuedFlagName)
  );
}

function isQueuedClearWrite(
  write: FieldEffect,
  contract: ResolvedContract,
): boolean {
  return (
    write.viaCall === null &&
    write.propertyName === contract.flagProperty &&
    write.operator === "&=" &&
    (write.valueText?.includes(contract.queuedFlagName) ?? false)
  );
}

function isQueuedSetWrite(
  write: FieldEffect,
  contract: ResolvedContract,
): boolean {
  return (
    write.propertyName === contract.flagProperty &&
    (write.operator === "|=" || write.operator === "=") &&
    (write.valueText?.includes(contract.queuedFlagName) ?? false)
  );
}

function isPostCallbackReentrantGuardBranch(
  branch: BranchEdgeInfo,
  invocationEnd: number,
  contract: ResolvedContract,
): boolean {
  if (branch.location.start < invocationEnd) {
    return false;
  }
  if (
    !branch.conditionText.includes(contract.reentrantFlagName) ||
    !branch.conditionText.includes(contract.flagProperty)
  ) {
    return false;
  }

  const trimmed = branch.conditionText.trimStart();
  const isNegated = trimmed.startsWith("!");
  return (
    (isNegated && branch.direction === "true") ||
    (!isNegated && branch.direction === "false")
  );
}

async function resolveEnqueueState(
  ctx: RuleContext,
  contract: ResolvedContract,
): Promise<QueueEnqueueState | null> {
  const fnDecls = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
  const enqueueFns = fnDecls.filter(
    (fn) =>
      extractDeclaredFunctionName(fn) === contract.enqueueFunctionName &&
      fn.text.includes(contract.queuedFlagName),
  );

  if (enqueueFns.length === 0) {
    return null;
  }

  const enqueueEffects = await ctx.callEffects({
    targets: enqueueFns.map((fn) => fn.ref),
    followCallbacks: false,
    includeReads: true,
    includeWrites: true,
  });

  const queueDeclKeys = new Set<LocationKey>();
  const enqueueEvidence: Evidence[] = [];

  for (const [index, fn] of enqueueFns.entries()) {
    const eff = enqueueEffects[index]!;
    const setWrite = eff.fieldWrites.find((w) => isQueuedSetWrite(w, contract));
    if (!setWrite) continue;

    ctx.checkpoint("enqueue-contract", fn.ref, "pass", () => ({
      contractId: contract.contractId,
      enqueueFunction: contract.enqueueFunctionName,
      setWrite: setWrite.location,
    }));

    enqueueEvidence.push({
      kind: "source",
      message: `enqueue-sets-queued: '${contract.enqueueFunctionName}' marks '.${contract.flagProperty}' with '${contract.queuedFlagName}' before queuing.`,
      at: setWrite.location,
    });

    const idsInFn = await ctx.findSyntax({
      kinds: ["Identifier"],
      range: {
        file: fn.location.file,
        start: fn.location.start,
        end: fn.location.end,
        match: "within",
      },
    });
    const queueIds = idsInFn.filter(
      (id) => id.text === contract.queueIdentifier,
    );
    if (queueIds.length > 0) {
      const resolved = await ctx.resolveDeclarations(
        queueIds.map((id) => id.ref),
        { select: { location: true } },
      );
      for (const row of resolved) {
        if (row.location !== null) {
          queueDeclKeys.add(locationKey(row.location));
        }
      }
    }
  }

  if (queueDeclKeys.size === 0) {
    return null;
  }

  return {
    queueDeclKeys,
    enqueueEvidence,
  };
}

async function resolveQueueItemDeclarations(
  ctx: RuleContext,
  fn: SyntaxNodeResult,
  writes: readonly FieldEffect[],
  queueDeclKeys: ReadonlySet<LocationKey>,
  contract: ResolvedContract,
): Promise<readonly FlagClearCandidate[]> {
  if (writes.length === 0) return [];

  const resolvedRecvs = await ctx.resolveDeclarations(
    writes.map((w) => w.receiverSyntax),
    { select: { location: true } },
  );

  const varDeclsInFn = await ctx.findSyntax({
    kinds: ["VariableDeclaration"],
    range: {
      file: fn.location.file,
      start: fn.location.start,
      end: fn.location.end,
      match: "within",
    },
  });
  const idsInFn = await ctx.findSyntax({
    kinds: ["Identifier"],
    range: {
      file: fn.location.file,
      start: fn.location.start,
      end: fn.location.end,
      match: "within",
    },
  });

  const queueIdsInFn = idsInFn.filter(
    (id) => id.text === contract.queueIdentifier,
  );
  const resolvedQueueIds =
    queueIdsInFn.length > 0
      ? await ctx.resolveDeclarations(
          queueIdsInFn.map((id) => id.ref),
          { select: { location: true } },
        )
      : [];

  const trackedQueueReads: SyntaxNodeResult[] = [];
  for (const [idx, idNode] of queueIdsInFn.entries()) {
    const loc = resolvedQueueIds[idx]?.location;
    if (
      loc !== null &&
      loc !== undefined &&
      queueDeclKeys.has(locationKey(loc))
    ) {
      trackedQueueReads.push(idNode);
    }
  }

  const varDeclByKey = new Map<LocationKey, SyntaxNodeResult>();
  for (const decl of varDeclsInFn) {
    varDeclByKey.set(locationKey(decl.location), decl);
  }

  const candidates: FlagClearCandidate[] = [];
  for (const [index, write] of writes.entries()) {
    const declLoc = resolvedRecvs[index]?.location;
    if (declLoc === null || declLoc === undefined) continue;
    const itemDeclKey = locationKey(declLoc);

    const varDecl = varDeclByKey.get(itemDeclKey);
    const matchingQueueRead =
      varDecl !== undefined
        ? trackedQueueReads.find((qId) =>
            insideSpan(qId.location, varDecl.location),
          )
        : undefined;

    if (matchingQueueRead !== undefined && varDecl !== undefined) {
      candidates.push({
        write,
        itemDeclKey,
        itemDeclLocation: declLoc,
        queueReadLocation: varDecl.location,
      });
      continue;
    }

    // Fallback for aliased local variables propagated from a tracked queue element read.
    if (trackedQueueReads.length > 0) {
      const prop = await ctx.valuePropagation({
        from: trackedQueueReads.map((q) => q.ref),
        to: [write.receiverSyntax],
      });
      const firstPath = prop.results[0]?.paths[0];
      if (prop.results[0]?.reachable && firstPath !== undefined) {
        candidates.push({
          write,
          itemDeclKey,
          itemDeclLocation: declLoc,
          queueReadLocation: declLoc,
        });
      }
    }
  }

  return candidates;
}

async function collectItemCallbackInvocations(
  ctx: RuleContext,
  eff: CallEffectsResult,
  targetItemKeys: ReadonlySet<LocationKey>,
): Promise<readonly CallbackInvocationMatch[]> {
  const matches: CallbackInvocationMatch[] = [];

  if (eff.calls.length > 0) {
    const projectedCalls = await ctx.projectCalls(eff.calls, {
      select: {
        location: true,
        callee: true,
        calleeDeclaration: true,
        arguments: true,
      },
    });

    const calleeTargets = projectedCalls
      .map((c) => c.callee)
      .filter((c): c is SyntaxRef => c !== null);
    const calleeDecls =
      calleeTargets.length > 0
        ? await ctx.resolveDeclarations(calleeTargets, {
            select: { location: true },
          })
        : [];

    const calleeDeclBySyntax = new Map<SyntaxRef, DiagnosticLocation>();
    for (const [idx, target] of calleeTargets.entries()) {
      const loc = calleeDecls[idx]?.location;
      if (loc !== null && loc !== undefined) {
        calleeDeclBySyntax.set(target, loc);
      }
    }

    for (const callRow of projectedCalls) {
      if (callRow.callee === null) continue;
      const calleeDeclLoc = calleeDeclBySyntax.get(callRow.callee);
      if (calleeDeclLoc === undefined) continue;
      const declKey = locationKey(calleeDeclLoc);
      if (!targetItemKeys.has(declKey)) continue;

      matches.push({
        kind: "direct",
        itemDeclKey: declKey,
        callLocation: callRow.location,
        evidence: [
          {
            kind: "source",
            message:
              "direct-callback-call: Queue item is invoked directly here and may re-enqueue itself.",
            at: callRow.location,
          },
        ],
      });
    }

    if (eff.callbackInvocations.length > 0) {
      const cbArgDecls = await ctx.resolveDeclarations(
        eff.callbackInvocations.map((cb) => cb.callbackArgument),
        { select: { location: true } },
      );
      const cbArgSyntaxInfo = await ctx.syntaxOf(
        eff.callbackInvocations.map((cb) => cb.callbackArgument),
        { select: { location: true } },
      );

      const helperDeclRefs: DeclarationRef[] = [];
      const outerCallsForCb: ((typeof projectedCalls)[number] | undefined)[] =
        [];

      for (const [idx] of eff.callbackInvocations.entries()) {
        const argLoc = cbArgSyntaxInfo[idx]?.location;
        const outerCall =
          argLoc !== undefined && argLoc !== null
            ? projectedCalls
                .filter((c) => insideSpan(argLoc, c.location))
                .toSorted(
                  (a, b) => spanLength(a.location) - spanLength(b.location),
                )[0]
            : undefined;
        outerCallsForCb.push(outerCall);
        if (
          outerCall?.calleeDeclaration !== null &&
          outerCall?.calleeDeclaration !== undefined
        ) {
          helperDeclRefs.push(outerCall.calleeDeclaration);
        }
      }

      const helperSyntaxRows =
        helperDeclRefs.length > 0
          ? await ctx.syntaxOf(helperDeclRefs, { select: { location: true } })
          : [];
      const helperLocByDecl = new Map<DeclarationRef, DiagnosticLocation>();
      for (const [idx, ref] of helperDeclRefs.entries()) {
        const loc = helperSyntaxRows[idx]?.location;
        if (loc !== null && loc !== undefined) {
          helperLocByDecl.set(ref, loc);
        }
      }

      const seenIndirect = new Set<string>();
      for (const [idx, cbInv] of eff.callbackInvocations.entries()) {
        const argDeclLoc = cbArgDecls[idx]?.location;
        if (argDeclLoc === null || argDeclLoc === undefined) continue;
        const declKey = locationKey(argDeclLoc);
        if (!targetItemKeys.has(declKey)) continue;

        const outerCall = outerCallsForCb[idx];
        const callLocation = outerCall?.location ?? cbInv.location;
        const helperDeclLoc =
          outerCall?.calleeDeclaration !== null &&
          outerCall?.calleeDeclaration !== undefined
            ? helperLocByDecl.get(outerCall.calleeDeclaration)
            : undefined;

        const dedupeKey = `${declKey}|${locationKey(callLocation)}|${cbInv.location.file}:${cbInv.location.line}`;
        if (seenIndirect.has(dedupeKey)) continue;
        seenIndirect.add(dedupeKey);

        const evidence: Evidence[] = [
          {
            kind: "source",
            message:
              "indirect-callback-call: Queue item is passed as a callback argument to a helper.",
            at: callLocation,
          },
          ...(helperDeclLoc !== undefined
            ? [
                {
                  kind: "source" as const,
                  message:
                    "callback-helper-declaration: Helper accepts callback parameter.",
                  at: helperDeclLoc,
                },
              ]
            : []),
          {
            kind: "source",
            message:
              "helper-invokes-param: Helper synchronously invokes the callback parameter and may trigger re-enqueue.",
            at: cbInv.location,
          },
        ];

        matches.push({
          kind: "indirect",
          itemDeclKey: declKey,
          callLocation,
          ...(helperDeclLoc !== undefined
            ? { helperDeclLocation: helperDeclLoc }
            : {}),
          helperInvokeLocation: cbInv.location,
          evidence,
        });
      }
    }
  }

  return matches;
}

async function analyzeCandidateFunction(
  ctx: RuleContext,
  fn: SyntaxNodeResult,
  fileBlocks: readonly SyntaxNodeResult[],
  enqueueState: QueueEnqueueState,
  contract: ResolvedContract,
): Promise<void> {
  const idsInFn = await ctx.findSyntax({
    kinds: ["Identifier"],
    range: {
      file: fn.location.file,
      start: fn.location.start,
      end: fn.location.end,
      match: "within",
    },
  });
  const queueIds = idsInFn.filter((id) => id.text === contract.queueIdentifier);
  if (queueIds.length === 0) {
    ctx.checkpoint("queue-scope-filter", fn.ref, "exclude", () => ({
      contractId: contract.contractId,
      reason: `Function does not reference '${contract.queueIdentifier}'.`,
    }));
    return;
  }

  const resolvedQueueRefs = await ctx.resolveDeclarations(
    queueIds.map((id) => id.ref),
    { select: { location: true } },
  );
  const referencesTrackedQueue = resolvedQueueRefs.some(
    (row) =>
      row.location !== null &&
      enqueueState.queueDeclKeys.has(locationKey(row.location)),
  );
  if (!referencesTrackedQueue) {
    ctx.checkpoint("queue-scope-filter", fn.ref, "exclude", () => ({
      contractId: contract.contractId,
      reason: `'${contract.queueIdentifier}' resolves to a different declaration than the tracked queue.`,
    }));
    return;
  }

  const [eff] = await ctx.callEffects({
    targets: [fn.ref],
    followCallbacks: true,
    includeReads: true,
    includeWrites: true,
  });
  if (eff === undefined) return;

  const clearWrites = eff.fieldWrites.filter((w) =>
    isQueuedClearWrite(w, contract),
  );
  if (clearWrites.length === 0) return;

  const candidates = await resolveQueueItemDeclarations(
    ctx,
    fn,
    clearWrites,
    enqueueState.queueDeclKeys,
    contract,
  );
  if (candidates.length === 0) return;

  const targetItemKeys = new Set(candidates.map((c) => c.itemDeclKey));
  const invocations = await collectItemCallbackInvocations(
    ctx,
    eff,
    targetItemKeys,
  );

  for (const candidate of candidates) {
    const priorInvocations = invocations.filter(
      (inv) =>
        inv.itemDeclKey === candidate.itemDeclKey &&
        inv.callLocation.file === candidate.write.location.file &&
        inv.callLocation.end <= candidate.write.location.start,
    );

    if (priorInvocations.length === 0) {
      ctx.checkpoint(
        "post-callback-clear-filter",
        candidate.write.syntax,
        "exclude",
        () => ({
          contractId: contract.contractId,
          reason:
            "Flag clear occurs before callback invocation or on a non-invoking queue drain path.",
        }),
      );
      continue;
    }

    const latestInvocation = priorInvocations.toSorted(
      (a, b) => b.callLocation.end - a.callLocation.end,
    )[0]!;

    const enclosingScopeBlock = fileBlocks
      .filter(
        (block) =>
          !insideSpan(fn.location, block.location) &&
          insideSpan(block.location, fn.location) &&
          insideSpan(latestInvocation.callLocation, block.location) &&
          insideSpan(candidate.write.location, block.location),
      )
      .toSorted((a, b) => spanLength(a.location) - spanLength(b.location))[0];

    const scopeRef = enclosingScopeBlock?.ref ?? fn.ref;
    const [branchGroup] = await ctx.listBranches([scopeRef]);
    const branches = branchGroup?.branches ?? [];

    const guardBranches = branches.filter((b) =>
      isPostCallbackReentrantGuardBranch(
        b,
        latestInvocation.callLocation.end,
        contract,
      ),
    );

    const [coverage] = await ctx.branchCoverage({
      scope: scopeRef,
      branches: guardBranches.map((b) => b.ref),
      targets: [candidate.write.syntax],
    });

    if (coverage === undefined) continue;

    ctx.checkpoint(
      "branch-guard-coverage",
      candidate.write.syntax,
      coverage.status === "covered" ? "exclude" : "pass",
      () => ({
        contractId: contract.contractId,
        status: coverage.status,
        guardBranches: guardBranches.map((b) => b.conditionText),
        gaps: coverage.gaps,
      }),
    );

    if (coverage.status === "covered") {
      continue;
    }

    const preClears = candidates.filter(
      (other) =>
        other.itemDeclKey === candidate.itemDeclKey &&
        other.write.location.end <= latestInvocation.callLocation.start &&
        other.write.guards.some((g) =>
          g.conditionText.includes(contract.reentrantFlagName),
        ),
    );

    const evidence = dedupeEvidence([
      {
        kind: "model",
        modelId: contract.modelId,
        declaration: contract.queueName,
        message: `Model '${contract.modelId}' requires post-callback '.${contract.flagProperty}' '${contract.queuedFlagName}' clears on '${contract.queueName}' to preserve '${contract.reentrantFlagName}' re-enqueues.`,
      },
      ...enqueueState.enqueueEvidence,
      {
        kind: "source",
        message: `main-queue-read: Queue item read from '${contract.queueIdentifier}'.`,
        at: candidate.queueReadLocation,
      },
      ...preClears.map((pre): Evidence => ({
        kind: "source",
        message: `pre-call-allow-recurse-preclear: Pre-call clear checks '${contract.reentrantFlagName}' before callback invocation.`,
        at: pre.write.location,
      })),
      ...latestInvocation.evidence,
      {
        kind: "source",
        message: `unguarded-post-callback-clear: Post-callback clear unconditionally strips '${contract.queuedFlagName}' after callback execution.`,
        at: candidate.write.location,
      },
      ...coverage.evidence,
    ]);

    const invocationKindNote =
      latestInvocation.kind === "indirect"
        ? "indirectly via helper callback"
        : "directly";

    ctx.report({
      at: candidate.write.location,
      findingKey: `${contract.contractId}:${locationKey(candidate.write.location)}`,
      message: `Queue item clears '${contract.queuedFlagName}' on '.${contract.flagProperty}' after invoking callback ${invocationKindNote} without guarding with '!(item.${contract.flagProperty} & ${contract.reentrantFlagName})'.`,
      evidence,
    });
  }
}

/**
 * Declares a model describing a reentrant task queue whose `QUEUED` bitflag must
 * not be unconditionally cleared after invoking a reentrant callback.
 */
export function defineReentrantQueueModel(
  options: ReentrantQueueModelOptions,
): Model {
  return defineModel({
    id: options.id,
    ...(options.version !== undefined ? { version: options.version } : {}),
    ...(options.description !== undefined
      ? { description: options.description }
      : {}),
    facts: {
      reentrantQueueContracts: options.contracts,
    },
  });
}

/**
 * Project model for Vue's main scheduler queue (`queueJob` / `queue` / `SchedulerJobFlags.QUEUED` / `ALLOW_RECURSE`).
 */
export const vueSchedulerQueueModel: Model = defineReentrantQueueModel({
  id: "vue-main-scheduler-queue",
  version: "1.0.0",
  description:
    "Vue main scheduler queue model: queueJob marks QUEUED on queue items; post-callback clears must preserve ALLOW_RECURSE re-enqueued flags.",
  contracts: [
    {
      id: "main-scheduler-queue",
      queueName: "main-scheduler-queue",
      enqueueFunctionName: "queueJob",
      queueIdentifier: "queue",
      flagProperty: "flags",
      queuedFlagName: "QUEUED",
      reentrantFlagName: "ALLOW_RECURSE",
    },
  ],
});

/**
 * Creates a rule verifying that post-callback bitflag clears on reentrant queue
 * items are guarded so re-enqueued items do not lose their `QUEUED` state.
 */
export function createReentrantQueueFlagRule(
  options: ReentrantQueueFlagRuleOptions = {},
): Rule {
  return defineRule({
    id: options.id ?? "reentrant-queue-flag",
    description:
      options.description ??
      "Require post-callback queued flag clears on reentrant queue items to be guarded against re-enqueue flags.",
    run: async (ctx) => {
      const contracts = extractContracts(ctx, options.contracts);
      if (contracts.length === 0) return;

      const binaryExprs = await ctx.findSyntax({ kinds: ["BinaryExpression"] });

      for (const contract of contracts) {
        const candidateWrites = binaryExprs.filter((expr) =>
          matchesFlagClearSyntax(expr.text, contract),
        );
        if (candidateWrites.length === 0) continue;

        const enqueueState = await resolveEnqueueState(ctx, contract);
        if (enqueueState === null) continue;

        const files = [
          ...new Set(candidateWrites.map((expr) => expr.location.file)),
        ].toSorted();

        for (const file of files) {
          const writesInFile = candidateWrites.filter(
            (w) => w.location.file === file,
          );
          const fnsInFile = await ctx.findSyntax({
            files: [file],
            kinds: [
              "FunctionDeclaration",
              "FunctionExpression",
              "ArrowFunction",
              "MethodDeclaration",
            ],
          });
          const blocksInFile = await ctx.findSyntax({
            files: [file],
            kinds: ["Block"],
          });

          const candidateFns = new Map<LocationKey, SyntaxNodeResult>();
          for (const writeExpr of writesInFile) {
            const enclosing = fnsInFile
              .filter((fn) => insideSpan(writeExpr.location, fn.location))
              .toSorted(
                (a, b) => spanLength(a.location) - spanLength(b.location),
              )[0];
            if (enclosing !== undefined) {
              candidateFns.set(locationKey(enclosing.location), enclosing);
            }
          }

          for (const fn of candidateFns.values()) {
            await analyzeCandidateFunction(
              ctx,
              fn,
              blocksInFile,
              enqueueState,
              contract,
            );
          }
        }
      }
    },
  });
}

/**
 * Default instance of the generic reentrant queue flag rule.
 */
export const reentrantQueueFlagRule: Rule = createReentrantQueueFlagRule();
