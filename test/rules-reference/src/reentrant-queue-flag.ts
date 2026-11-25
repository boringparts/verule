import {
  defineModel,
  defineRule,
  type BranchEdgeInfo,
  type DeclarationRef,
  type DiagnosticBasis,
  type FieldEffect,
  type Model,
  type Rule,
  type RuleContext,
  type SyntaxNodeResult,
  type SyntaxRef,
} from "@boringparts/verule";

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

type QueueEnqueueState = {
  readonly queueDeclIds: ReadonlySet<string>;
  readonly enqueueWrites: readonly FieldEffect[];
};

type FlagClearCandidate = {
  readonly write: FieldEffect;
  readonly receiverDeclId: string;
  readonly queueReadBasis: DiagnosticBasis | null;
};

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
      const key = `${model.id}:${contractId}:${item.enqueueFunctionName}:${item.queueIdentifier}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ ...item, contractId, modelId: model.id });
      }
    }
  }

  for (const item of optionContracts ?? []) {
    const contractId = item.id ?? item.queueName;
    const key = `rule-options:${contractId}:${item.enqueueFunctionName}:${item.queueIdentifier}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ ...item, contractId, modelId: "rule-options" });
    }
  }

  return out;
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

function stripBalancedOuterParens(text: string): string {
  let current = text.trim();
  while (current.startsWith("(") && current.endsWith(")")) {
    let depth = 0;
    let balancedOuter = true;
    for (let i = 0; i < current.length; i += 1) {
      const ch = current[i];
      if (ch === "(") depth += 1;
      else if (ch === ")") {
        depth -= 1;
        if (depth === 0 && i < current.length - 1) {
          balancedOuter = false;
          break;
        }
      }
    }
    if (!balancedOuter || depth !== 0) break;
    current = current.slice(1, -1).trim();
  }
  return current;
}

function isZeroCheckCondition(conditionText: string): boolean {
  const normalized = stripBalancedOuterParens(
    conditionText.replaceAll(/\s+/g, " ").trim(),
  );
  if (normalized.startsWith("!") && !normalized.startsWith("!=")) {
    return !isZeroCheckCondition(normalized.slice(1));
  }
  return (
    /(?<![!=])(?:===|==)\s*(?:0|false)$/u.test(normalized) ||
    /^(?:0|false)\s*(?:===|==)(?!=)/u.test(normalized)
  );
}

function isReentrantSafeGuardBranch(
  branch: BranchEdgeInfo,
  contract: ResolvedContract,
): boolean {
  if (
    !branch.conditionText.includes(contract.reentrantFlagName) ||
    !branch.conditionText.includes(contract.flagProperty)
  ) {
    return false;
  }
  const isZeroCheck = isZeroCheckCondition(branch.conditionText);
  return (
    (isZeroCheck && branch.direction === "true") ||
    (!isZeroCheck && branch.direction === "false")
  );
}

async function resolveQueueDeclsInFunction(
  ctx: RuleContext,
  fn: SyntaxNodeResult,
  queueIdentifier: string,
): Promise<{
  readonly queueIds: readonly SyntaxNodeResult[];
  readonly resolvedDecls: readonly (DeclarationRef | null)[];
}> {
  const idsInFn = await ctx.findSyntax({
    kinds: ["Identifier"],
    range: {
      file: fn.location.file,
      start: fn.location.start,
      end: fn.location.end,
      match: "within",
    },
    textIncludes: [queueIdentifier],
  });
  const queueIds = idsInFn.filter((id) => id.text === queueIdentifier);
  if (queueIds.length === 0) {
    return { queueIds: [], resolvedDecls: [] };
  }
  const rows = await ctx.resolveDeclarations(queueIds.map((id) => id.ref));
  return {
    queueIds,
    resolvedDecls: rows.map((row) => row.declaration),
  };
}

async function resolveEnqueueState(
  ctx: RuleContext,
  contract: ResolvedContract,
): Promise<QueueEnqueueState | null> {
  const fnDecls = await ctx.findSyntax({
    kinds: ["FunctionDeclaration"],
    textIncludes: [contract.enqueueFunctionName],
  });
  if (fnDecls.length === 0) return null;

  const declRows = await ctx.resolveDeclarations(
    fnDecls.map((fn) => fn.ref),
    { select: { name: true } },
  );
  const enqueueFns = fnDecls.filter(
    (fn, idx) =>
      declRows[idx]?.name === contract.enqueueFunctionName &&
      fn.text.includes(contract.queuedFlagName),
  );
  if (enqueueFns.length === 0) return null;

  const enqueueEffects = await ctx.callEffects({
    targets: enqueueFns.map((fn) => fn.ref),
    followCallbacks: false,
    includeReads: true,
    includeWrites: true,
  });

  const queueDeclIds = new Set<string>();
  const enqueueWrites: FieldEffect[] = [];

  for (const [index, fn] of enqueueFns.entries()) {
    const setWrite = enqueueEffects[index]?.fieldWrites.find((w) =>
      isQueuedSetWrite(w, contract),
    );
    if (!setWrite) continue;

    ctx.checkpoint("enqueue-contract", fn.ref, "pass", () => ({
      contractId: contract.contractId,
      enqueueFunction: contract.enqueueFunctionName,
      setWrite: setWrite.location,
    }));
    enqueueWrites.push(setWrite);

    const { resolvedDecls } = await resolveQueueDeclsInFunction(
      ctx,
      fn,
      contract.queueIdentifier,
    );
    for (const decl of resolvedDecls) {
      if (decl !== null) {
        queueDeclIds.add(decl.handleId);
      }
    }
  }

  return queueDeclIds.size > 0 ? { queueDeclIds, enqueueWrites } : null;
}

async function resolveQueueItemCandidates(
  ctx: RuleContext,
  writes: readonly FieldEffect[],
  queueDeclIds: ReadonlySet<string>,
  trackedQueueReads: readonly SyntaxRef[],
): Promise<readonly FlagClearCandidate[]> {
  const uniqueDecls = new Map<string, DeclarationRef>();
  for (const write of writes) {
    if (write.receiverDeclaration !== null) {
      uniqueDecls.set(
        write.receiverDeclaration.handleId,
        write.receiverDeclaration,
      );
    }
  }
  if (uniqueDecls.size === 0) return [];

  const declList = [...uniqueDecls.values()];
  const declSyntaxRows = await ctx.syntaxOf(declList, {
    select: { location: true, initializer: true },
  });
  const initRows = declSyntaxRows
    .map((row, idx) => ({
      declId: declList[idx]!.handleId,
      row,
      initializer: row.initializer ?? null,
    }))
    .filter(
      (
        entry,
      ): entry is {
        readonly declId: string;
        readonly row: (typeof declSyntaxRows)[number];
        readonly initializer: SyntaxRef;
      } => entry.initializer !== null,
    );

  const directReadBasisByDecl = new Map<string, DiagnosticBasis>();
  if (initRows.length > 0) {
    const exprRows = await ctx.syntaxOf(
      initRows.map((e) => e.initializer),
      { select: { expression: true } },
    );
    const exprTargets = exprRows
      .map((r, idx) => ({
        declId: initRows[idx]!.declId,
        row: initRows[idx]!.row,
        expr: r.expression ?? null,
      }))
      .filter(
        (
          entry,
        ): entry is {
          readonly declId: string;
          readonly row: (typeof declSyntaxRows)[number];
          readonly expr: SyntaxRef;
        } => entry.expr !== null,
      );

    if (exprTargets.length > 0) {
      const resolvedExprs = await ctx.resolveDeclarations(
        exprTargets.map((e) => e.expr),
      );
      for (const [idx, target] of exprTargets.entries()) {
        const declId = resolvedExprs[idx]?.declaration?.handleId;
        if (declId !== undefined && queueDeclIds.has(declId)) {
          directReadBasisByDecl.set(target.declId, target.row);
        }
      }
    }
  }

  const candidates: FlagClearCandidate[] = [];
  for (const write of writes) {
    const receiverDeclId = write.receiverDeclaration?.handleId;
    if (receiverDeclId === undefined) continue;

    const directBasis = directReadBasisByDecl.get(receiverDeclId);
    if (directBasis !== undefined) {
      candidates.push({ write, receiverDeclId, queueReadBasis: directBasis });
      continue;
    }

    if (trackedQueueReads.length > 0) {
      const prop = await ctx.valuePropagation({
        from: trackedQueueReads,
        to: [write.receiverSyntax],
      });
      const targetResult = prop.results[0];
      if (targetResult?.reachable && targetResult.paths.length > 0) {
        candidates.push({
          write,
          receiverDeclId,
          queueReadBasis: targetResult,
        });
      }
    }
  }

  return candidates;
}

async function analyzeCandidateFunction(
  ctx: RuleContext,
  fn: SyntaxNodeResult,
  enqueueState: QueueEnqueueState,
  contract: ResolvedContract,
): Promise<void> {
  const { queueIds, resolvedDecls } = await resolveQueueDeclsInFunction(
    ctx,
    fn,
    contract.queueIdentifier,
  );
  if (queueIds.length === 0) {
    ctx.checkpoint("queue-scope-filter", fn.ref, "exclude", () => ({
      contractId: contract.contractId,
      reason: `Function does not reference '${contract.queueIdentifier}'.`,
    }));
    return;
  }

  const trackedQueueReads: SyntaxRef[] = [];
  for (const [idx, decl] of resolvedDecls.entries()) {
    if (decl !== null && enqueueState.queueDeclIds.has(decl.handleId)) {
      trackedQueueReads.push(queueIds[idx]!.ref);
    }
  }
  if (trackedQueueReads.length === 0) {
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

  const candidates = await resolveQueueItemCandidates(
    ctx,
    clearWrites,
    enqueueState.queueDeclIds,
    trackedQueueReads,
  );
  if (candidates.length === 0) return;

  const model = ctx.getModel(contract.modelId);
  for (const candidate of candidates) {
    const priorInvocations = eff.callbackInvocations.filter(
      (inv) =>
        inv.targetDeclaration?.handleId === candidate.receiverDeclId &&
        inv.outerCallLocation.file === candidate.write.location.file &&
        inv.outerCallLocation.end <= candidate.write.location.start,
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

    const orderedInvocations = priorInvocations.toSorted(
      (a, b) => b.outerCallLocation.end - a.outerCallLocation.end,
    );

    const scopeRef = candidate.write.cfgScope ?? fn.ref;
    const [branchGroup] = await ctx.listBranches([scopeRef]);
    const allBranches = branchGroup?.branches ?? [];
    const allSafeBranches = allBranches.filter((b) =>
      isReentrantSafeGuardBranch(b, contract),
    );

    const [overallCoverage] = await ctx.branchCoverage({
      scope: scopeRef,
      branches: allSafeBranches.map((b) => b.ref),
      targets: [candidate.write.syntax],
    });
    if (overallCoverage === undefined) continue;

    const isConfinedToOppositeGuardBranch = async (
      inv: (typeof orderedInvocations)[number],
    ): Promise<boolean> => {
      for (const safeBranch of allSafeBranches) {
        if (
          safeBranch.location.start >= inv.outerCallLocation.end ||
          inv.outerCallLocation.end > safeBranch.statementLocation.end
        ) {
          continue;
        }
        const oppositeBranch = allBranches.find(
          (b) =>
            b.condition.handleId === safeBranch.condition.handleId &&
            b.direction !== safeBranch.direction,
        );
        if (oppositeBranch === undefined) continue;

        const [[oppToInv], [safeToWrite]] = await Promise.all([
          ctx.branchCoverage({
            scope: scopeRef,
            branches: [oppositeBranch.ref],
            targets: [inv.callbackArgument],
          }),
          ctx.branchCoverage({
            scope: scopeRef,
            branches: [safeBranch.ref],
            targets: [candidate.write.syntax],
          }),
        ]);
        if (
          oppToInv?.status === "covered" &&
          safeToWrite?.status === "covered"
        ) {
          return true;
        }
      }
      return false;
    };

    let reportCoverage = overallCoverage;
    let offendingInvocation: (typeof orderedInvocations)[number] | undefined;

    if (overallCoverage.status === "covered") {
      for (const inv of orderedInvocations) {
        const postSafeBranches = allSafeBranches.filter(
          (b) => b.location.start >= inv.outerCallLocation.end,
        );
        if (postSafeBranches.length > 0) {
          const [postCoverage] = await ctx.branchCoverage({
            scope: scopeRef,
            branches: postSafeBranches.map((b) => b.ref),
            targets: [candidate.write.syntax],
          });
          if (postCoverage?.status === "covered") {
            continue;
          }
          if (await isConfinedToOppositeGuardBranch(inv)) {
            continue;
          }
          reportCoverage = postCoverage ?? overallCoverage;
          offendingInvocation = inv;
          break;
        }
        if (await isConfinedToOppositeGuardBranch(inv)) {
          continue;
        }
        offendingInvocation = inv;
        break;
      }
    } else {
      for (const inv of orderedInvocations) {
        if (!(await isConfinedToOppositeGuardBranch(inv))) {
          offendingInvocation = inv;
          break;
        }
      }
      offendingInvocation ??= orderedInvocations[0]!;
    }

    ctx.checkpoint(
      "branch-guard-coverage",
      candidate.write.syntax,
      offendingInvocation === undefined ? "exclude" : "pass",
      () => ({
        contractId: contract.contractId,
        status: reportCoverage.status,
        guardBranches: allSafeBranches.map((b) => b.conditionText),
        gaps: reportCoverage.gaps,
      }),
    );

    if (offendingInvocation === undefined) continue;

    const latestInvocation = offendingInvocation;
    const coverage = reportCoverage;

    const preClears = candidates.filter(
      (other) =>
        other.receiverDeclId === candidate.receiverDeclId &&
        other.write.location.end <= latestInvocation.outerCallLocation.start &&
        other.write.guards.some((g) =>
          g.conditionText.includes(contract.reentrantFlagName),
        ),
    );

    const basis: DiagnosticBasis[] = [
      ...(model !== undefined
        ? [model]
        : [
            {
              kind: "model" as const,
              modelId: contract.modelId,
              declaration: contract.queueName,
              message: `Contract '${contract.contractId}' requires post-callback '.${contract.flagProperty}' '${contract.queuedFlagName}' clears on '${contract.queueName}' to preserve '${contract.reentrantFlagName}' re-enqueues.`,
            },
          ]),
      ...enqueueState.enqueueWrites,
      ...(candidate.queueReadBasis !== null ? [candidate.queueReadBasis] : []),
      ...preClears.map((pre) => pre.write),
      latestInvocation,
      candidate.write,
      coverage,
    ];

    const invocationKindNote =
      latestInvocation.kind === "indirect"
        ? "indirectly via helper callback"
        : "directly";

    ctx.report({
      at: candidate.write.location,
      findingKey: `${contract.contractId}:${candidate.write.location.file}:${candidate.write.location.start}:${candidate.write.location.end}`,
      message: `Queue item clears '${contract.queuedFlagName}' on '.${contract.flagProperty}' after invoking callback ${invocationKindNote} without guarding with '!(item.${contract.flagProperty} & ${contract.reentrantFlagName})'.`,
      basis,
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

      const candidateFns = await ctx.findSyntax({
        kinds: [
          "FunctionDeclaration",
          "FunctionExpression",
          "ArrowFunction",
          "MethodDeclaration",
        ],
        textIncludes: contracts.map((c) => c.queuedFlagName),
      });

      for (const contract of contracts) {
        const matchingFns = candidateFns.filter(
          (fn) =>
            fn.text.includes(`.${contract.flagProperty}`) &&
            fn.text.includes("&=") &&
            fn.text.includes(contract.queuedFlagName),
        );
        if (matchingFns.length === 0) continue;

        const enqueueState = await resolveEnqueueState(ctx, contract);
        if (enqueueState === null) continue;

        for (const fn of matchingFns) {
          await analyzeCandidateFunction(ctx, fn, enqueueState, contract);
        }
      }
    },
  });
}

/**
 * Default instance of the generic reentrant queue flag rule.
 */
export const reentrantQueueFlagRule: Rule = createReentrantQueueFlagRule();
