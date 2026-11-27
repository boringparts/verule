import {
  VeruleExecutionError,
  createAdditionalInputRegistry,
  defineConfig,
  defineRule,
  isSameInstance,
  registerProvenance,
  type AdditionalInputEntry,
  type AdditionalInputRegistrar,
  type AdditionalInputSource,
  type BranchCoverageItem,
  type CallEffectsResult,
  type CallRef,
  type DeclarationRef,
  type EngineLoweringMetrics,
  type ExplainCleanupPath,
  type InstanceCleanupScopeResult,
  type InstanceRef,
  type ObservationReport,
  type SignatureRef,
  type SummaryConflictDetails,
  type SyntaxRef,
  type TypeRef,
} from "@boringparts/verule";

const registrar: AdditionalInputRegistrar = createAdditionalInputRegistry({
  cwd: "/tmp/workspace",
});
const summarySource: AdditionalInputSource = {
  kind: "summary",
  id: "demo-summary-pack",
};
const regEntry: AdditionalInputEntry = registrar.registerAdditionalInput(
  "tssae.summaries.json",
  summarySource,
);
void regEntry;

function inspectSummaryConflict(err: VeruleExecutionError): number | undefined {
  const details: SummaryConflictDetails | undefined = err.summaryConflict;
  return details?.parties.length;
}
void inspectSummaryConflict;

function inspectObservation(obs: ObservationReport): EngineLoweringMetrics {
  return obs.lowering;
}
void inspectObservation;

const validRule = defineRule({
  id: "external-consumer-valid",
  run: async (ctx) => {
    const inputEntry: AdditionalInputEntry = ctx.registerAdditionalInput(
      "allowed-packages.json",
    );
    if (inputEntry.exists) {
      const raw: string = ctx.readAdditionalInput("allowed-packages.json");
      void raw;
    }
    const syntaxNodes = await ctx.findSyntax({
      range: { file: "src/app.ts", startLine: 1, endLine: 20 },
      kinds: ["CallExpression"],
    });
    const callResolutions = await ctx.resolveCalls(
      syntaxNodes.map((n) => n.ref),
      { select: { signature: true, location: true } },
    );
    const callRefs: CallRef[] = [];
    for (const row of callResolutions) {
      if (row.call !== null) {
        callRefs.push(row.call);
      }
    }
    const implResults = await ctx.resolveImplementations(callRefs);
    for (const implRes of implResults) {
      if (implRes.status === "inconclusive") {
        ctx.recordGaps(implRes.gaps);
      }
    }

    const resolvedInstances = await ctx.resolveInstances(callRefs);
    const instRefs: InstanceRef[] = [];
    for (const instRow of resolvedInstances) {
      if (instRow.status === "proved" && instRow.instance !== null) {
        instRefs.push(instRow.instance);
      }
    }
    const projectedInstances = await ctx.projectInstances(instRefs, {
      select: {
        instanceKey: true,
        originKind: true,
        allocationLocation: true,
        originSyntax: true,
        summaryId: true,
        evidence: true,
      },
    });
    const firstInst = projectedInstances[0];
    if (firstInst !== undefined && firstInst.originSyntax !== null) {
      const originSyn: SyntaxRef = firstInst.originSyntax;
      const summaryId: string | null = firstInst.summaryId;
      void originSyn;
      void summaryId;
      void isSameInstance(firstInst.instance, instRefs[0]);
    }
    const callRows = await ctx.projectCalls(callRefs, {
      select: { signature: true, returnType: true },
    });
    const sigRefs: SignatureRef[] = [];
    for (const row of callRows) {
      if (row.signature !== null) {
        sigRefs.push(row.signature);
      }
    }
    const sigRows = await ctx.projectSignatures(sigRefs, {
      select: {
        instantiatedParameterTypes: [0],
        returnType: true,
        declaration: true,
      },
    });
    const firstSig = sigRows[0];
    if (firstSig !== undefined) {
      const param0 = firstSig.instantiatedParameterTypes[0];
      if (param0 !== undefined) {
        const sourceType: TypeRef = param0.type.ref;
        const targetType: TypeRef = firstSig.returnType.ref;
        const [assign] = await ctx.isAssignableTo([
          { source: sourceType, target: targetType },
        ]);
        if (assign?.assignable) {
          const decl: DeclarationRef | null = firstSig.declaration;
          if (decl !== null) {
            const [lookedUp] = await ctx.syntaxOf([decl], {
              select: { kind: true, location: true },
            });
            const syn: SyntaxRef | null = lookedUp?.syntax ?? null;
            if (syn !== null && lookedUp?.location != null) {
              const callers = await ctx.callersOf([decl]);
              const callees = await ctx.calleesOf(callRefs);
              if (callers[0]?.completeness === "incomplete") {
                ctx.recordGaps(callers[0].gaps);
              }
              if (callees[0]?.completeness === "incomplete") {
                ctx.recordGaps(callees[0].gaps);
              }
              const prop = await ctx.valuePropagation({
                propagation: "value",
                from: syn,
                to: [decl, ...callRefs],
              });
              const firstProp = prop.results[0];
              if (firstProp?.status === "proved") {
                const domainBasis = registerProvenance({ ok: true }, [
                  {
                    kind: "summary",
                    summaryId: "demo-summary",
                    summarySource: "local",
                    message: "Matched local behavior summary.",
                  },
                ]);
                ctx.report({
                  at: lookedUp.location,
                  message: "ok",
                  basis: [firstProp.paths[0], domainBasis],
                });
              }
            }
          }
        }
      }
    }
    const cleanupResults: readonly InstanceCleanupScopeResult[] =
      await ctx.instanceCleanup({
        scopes: callRefs,
        targets: instRefs,
      });
    const effectsResults: readonly CallEffectsResult[] = await ctx.callEffects({
      targets: callRefs,
    });
    const firstEffect = effectsResults[0]?.fieldWrites[0];
    if (firstEffect !== undefined) {
      const writeSyn: SyntaxRef = firstEffect.syntax;
      const recvSyn: SyntaxRef = firstEffect.receiverSyntax;
      const covItems: readonly BranchCoverageItem[] = await ctx.branchCoverage({
        branches: [],
        targets: [writeSyn],
      });
      const firstCov = covItems[0];
      if (
        firstCov?.status === "proved" &&
        firstCov.implicitExceptions.status === "disproved"
      ) {
        void firstCov.implicitExceptions.counterexamplePath;
      }
      await ctx.resolveInstances([recvSyn]);
    }
    const firstCleanup = cleanupResults[0];
    if (firstCleanup !== undefined) {
      const disposedInst: InstanceRef | undefined =
        firstCleanup.disposedInstances[0]?.instance;
      const targetCleanup = firstCleanup.targetResults[0];
      if (
        targetCleanup?.status === "disproved" &&
        targetCleanup.implicitExceptions.status === "disproved"
      ) {
        void targetCleanup.implicitExceptions.counterexamplePath;
      }
      void disposedInst;
    }
  },
});

export const sampleExplainPath: ExplainCleanupPath | undefined = undefined;

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["allowed-packages.json"],
  rules: [validRule],
});
