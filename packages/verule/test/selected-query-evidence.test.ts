import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  defineConfig,
  defineRule,
  evidenceOf,
  extractBasisEvidence,
  openSession,
  registerProvenance,
  runCheck,
  type DiagnosticBasis,
  type Evidence,
} from "@boringparts/verule";
import { withTempHost } from "@verule/test-hosts";

void describe("@boringparts/verule selected query evidence", () => {
  void it("threads provenance from selected CallTargetInfo, ValuePropagationPath/TargetResult, SyntaxNodeResult, and custom Evidence while excluding unselected candidates", async () => {
    await withTempHost(
      { host: "sdk-queries/selected-evidence-propagation" },
      async (host) => {
        await host.typecheck();

        const policyEvidence: Evidence = {
          kind: "summary",
          summaryId: "restricted-data-policy",
          summarySource: "local",
          message: "Restricted loader outputs must not reach public sinks.",
        };

        const rule = defineRule({
          id: "selected-relation-basis",
          run: async (ctx) => {
            const calls = await ctx.findSyntax({
              files: ["src/app.ts"],
              kinds: ["CallExpression"],
            });
            const resolvedCalls = await ctx.resolveCalls(
              calls.map((c) => c.ref),
              { select: { location: true, arguments: true } },
            );
            const calleeResults = await ctx.calleesOf(
              resolvedCalls
                .map((r) => r.call)
                .filter((c): c is NonNullable<typeof c> => c !== null),
            );
            const calleesByHandle = new Map(
              calleeResults.map((item) => [item.call.handleId, item]),
            );

            const loaderEntries: {
              readonly callSyntax: (typeof calls)[number];
              readonly callRef: NonNullable<
                (typeof resolvedCalls)[number]["call"]
              >;
              readonly targetInfo: (typeof calleeResults)[number]["resolvedTargets"][number];
              readonly isRestricted: boolean;
            }[] = [];

            const sinkArgs: {
              readonly argRef: NonNullable<
                NonNullable<(typeof resolvedCalls)[number]["arguments"]>[number]
              >;
              readonly callLoc: NonNullable<(typeof calls)[number]>["location"];
            }[] = [];

            for (const [index, resolved] of resolvedCalls.entries()) {
              const callSyntax = calls[index];
              if (!callSyntax || resolved.call === null) continue;
              const callees = calleesByHandle.get(resolved.call.handleId);
              if (!callees) continue;

              for (const targetInfo of callees.resolvedTargets) {
                if (
                  targetInfo.name === "loadRestricted" ||
                  targetInfo.name === "loadPublic"
                ) {
                  loaderEntries.push({
                    callSyntax,
                    callRef: resolved.call,
                    targetInfo,
                    isRestricted: targetInfo.name === "loadRestricted",
                  });
                }
                if (targetInfo.name === "sink" && resolved.arguments?.[0]) {
                  sinkArgs.push({
                    argRef: resolved.arguments[0],
                    callLoc: callSyntax.location,
                  });
                }
              }
            }

            const restrictedLoader = loaderEntries.find((e) => e.isRestricted);
            assert.ok(restrictedLoader);

            const propagation = await ctx.valuePropagation({
              propagation: "value",
              from: loaderEntries.map((e) => e.callSyntax.ref),
              to: sinkArgs.map((s) => s.argRef),
            });

            const selectedFlow = propagation.results.find(
              (res) =>
                res.from.handleId ===
                  restrictedLoader.callSyntax.ref.handleId &&
                res.status === "proved",
            );
            assert.ok(selectedFlow && selectedFlow.status === "proved");
            const selectedPath = selectedFlow.paths[0];
            assert.ok(selectedPath);

            const matchedSink = sinkArgs.find(
              (s) => s.argRef.handleId === selectedFlow.to.handleId,
            );
            assert.ok(matchedSink);

            ctx.checkpoint(
              "selected-sink-flow",
              matchedSink.callLoc,
              "pass",
              () => ({ target: selectedFlow.to.handleId }),
            );

            const customNote: Evidence = {
              kind: "note",
              message: "Business rule: restricted data cannot enter sink().",
              at: matchedSink.callLoc,
            };

            const basis: readonly DiagnosticBasis[] = [
              policyEvidence,
              restrictedLoader.targetInfo,
              selectedPath,
              restrictedLoader.callSyntax,
              customNote,
              // Repeated query results and notes retain their first-seen positions.
              selectedPath,
              customNote,
            ];

            ctx.report({
              at: matchedSink.callLoc,
              message: "Restricted data reaches sink().",
              basis,
            });
          },
        });

        const session = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            rules: [rule],
          }),
        });
        try {
          const report = await session.check({
            at: "src/app.ts:6:3",
            observe: "detail",
          });
          assert.equal(report.diagnostics.length, 1);
          const diag = report.diagnostics[0]!;
          assert.equal(diag.at.file, "src/app.ts");
          assert.equal(diag.at.line, 6);

          // Policy summary evidence is emitted first as requested in basis order.
          assert.deepEqual(diag.evidence[0], policyEvidence);

          // Target declaration evidence points to loadRestricted in src/sources.ts.
          assert.ok(
            diag.evidence.some(
              (ev) =>
                ev.kind === "source" &&
                ev.at?.file === "src/sources.ts" &&
                ev.at.line === 1 &&
                ev.declaration === "loadRestricted",
            ),
            JSON.stringify(diag.evidence),
          );

          // Propagation path evidence reaches line 6 sink(restricted).
          assert.ok(
            diag.evidence.some(
              (ev) =>
                ev.kind === "source" &&
                ev.at?.file === "src/app.ts" &&
                ev.at.line === 6,
            ),
            JSON.stringify(diag.evidence),
          );

          // Custom note appears once (deduplicated) at the end.
          const customNotes = diag.evidence.filter(
            (ev) =>
              ev.kind === "note" &&
              ev.message ===
                "Business rule: restricted data cannot enter sink().",
          );
          assert.equal(customNotes.length, 1);
          assert.deepEqual(diag.evidence.at(-1), customNotes[0]);

          // Unselected candidates (loadPublic on line 5 of sources.ts and line 5/7 of app.ts) must NOT leak.
          assert.equal(
            diag.evidence.some(
              (ev) =>
                ev.declaration === "loadPublic" ||
                (ev.at?.file === "src/sources.ts" && ev.at.line === 5) ||
                (ev.at?.file === "src/app.ts" &&
                  (ev.at.line === 5 || ev.at.line === 7)),
            ),
            false,
            JSON.stringify(diag.evidence),
          );

          // Named checkpoint remains recorded in explain output.
          assert.ok(
            report.explanation?.checkpoints.some(
              (cp) => cp.name === "selected-sink-flow" && cp.outcome === "pass",
            ),
          );
        } finally {
          await session.close();
        }
      },
    );
  });

  void it("isolates FieldEffect and CallbackInvocationInfo evidence from CallEffectsResult aggregate evidence", async () => {
    await withTempHost(
      { host: "sdk-queries/selected-evidence-callbacks" },
      async (host) => {
        await host.typecheck();

        const rule = defineRule({
          id: "selected-effect-and-callback",
          run: async (ctx) => {
            const fns = await ctx.findSyntax({
              files: ["src/queue.ts"],
              kinds: ["FunctionDeclaration"],
            });
            const flushFn = fns.find((fn) =>
              fn.text.includes("export function flush"),
            );
            assert.ok(flushFn);

            const [effects] = await ctx.callEffects({
              targets: [flushFn.ref],
              followCallbacks: true,
            });
            assert.ok(effects);

            const flagsWrite = effects.fieldWrites.find(
              (w) => w.propertyName === "flags",
            );
            const cbInvocation = effects.callbackInvocations[0];
            assert.ok(flagsWrite);
            assert.ok(cbInvocation);

            // Aggregate CallEffectsResult contains job.safe = 1 on line 9; selecting only flagsWrite + cbInvocation must exclude line 9.
            ctx.report({
              at: flagsWrite.location,
              message: "Selected field write inside callback.",
              basis: [flagsWrite, cbInvocation],
            });
          },
        });

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
        });

        assert.equal(report.diagnostics.length, 1);
        const diag = report.diagnostics[0]!;
        assert.ok(
          diag.evidence.some(
            (ev) => ev.at?.file === "src/queue.ts" && ev.at.line === 11,
          ),
          JSON.stringify(diag.evidence),
        );
        assert.ok(
          diag.evidence.some(
            (ev) => ev.at?.file === "src/queue.ts" && ev.at.line === 6,
          ),
          JSON.stringify(diag.evidence),
        );
        assert.equal(
          diag.evidence.some(
            (ev) => ev.at?.file === "src/queue.ts" && ev.at.line === 9,
          ),
          false,
          `Aggregate read/write leaked into selected diagnostic: ${JSON.stringify(diag.evidence)}`,
        );
      },
    );
  });

  void it("supports BranchEdgeInfo, BranchCoverageItem, instance/cleanup/impl results, and projected lookup rows", async () => {
    await withTempHost(
      { host: "sdk-queries/selected-evidence-relations" },
      async (host) => {
        await host.typecheck();

        host.writeText(
          "tssae.summaries.json",
          JSON.stringify(
            {
              id: "resource-cleanup-summary",
              entries: [
                {
                  match: { memberPath: ["Resource", "prototype", "dispose"] },
                  effects: {
                    completeness: "complete",
                    resourceOps: [
                      {
                        kind: "disposes-target",
                        target: "receiver",
                      },
                    ],
                  },
                },
              ],
            },
            null,
            2,
          ),
        );

        const rule = defineRule({
          id: "selected-other-relations",
          run: async (ctx) => {
            const fns = await ctx.findSyntax({
              files: ["src/impl.ts"],
              kinds: ["FunctionDeclaration"],
            });
            const runFn = fns.find((fn) =>
              fn.text.includes("export function run"),
            );
            assert.ok(runFn);

            const calls = await ctx.findSyntax({
              files: ["src/impl.ts"],
              kinds: ["CallExpression"],
            });
            const makeCall = calls.find((c) => c.text === "makeResource()");
            const disposeCall = calls.find((c) => c.text === "res.dispose()");
            assert.ok(makeCall);
            assert.ok(disposeCall);

            const [branchesRes] = await ctx.listBranches([runFn.ref]);
            assert.ok(branchesRes);
            const trueBranch = branchesRes.branches.find(
              (b) => b.direction === "true",
            );
            assert.ok(trueBranch);

            const [covItem] = await ctx.branchCoverage({
              function: runFn.ref,
              branches: [trueBranch.ref],
              targets: [disposeCall.ref],
            });
            assert.ok(covItem);

            const [instRes] = await ctx.resolveInstances([makeCall.ref]);
            assert.ok(
              instRes &&
                instRes.status === "proved" &&
                instRes.instance !== null,
            );
            const instInfo = instRes.instances[0];

            const [projInstWithLoc] = await ctx.projectInstances(
              [instRes.instance],
              { select: { allocationLocation: true, originKind: true } },
            );
            const [projInstWithoutLoc] = await ctx.projectInstances(
              [instRes.instance],
              { select: { originKind: true } },
            );
            assert.ok(projInstWithLoc && projInstWithoutLoc);

            const [cleanupScope] = await ctx.instanceCleanup({
              scopes: [runFn.ref],
              targets: [instRes.instance],
            });
            const targetCleanup = cleanupScope?.targetResults[0];
            const cleanupSite = targetCleanup?.cleanupSites[0];
            assert.ok(targetCleanup && cleanupSite);

            const [implRes] = await ctx.resolveImplementations([makeCall.ref]);
            assert.ok(implRes);

            const [declWithLoc] = await ctx.resolveDeclarations(
              [makeCall.ref],
              {
                select: { location: true, name: true },
              },
            );
            const [declWithoutLoc] = await ctx.resolveDeclarations(
              [makeCall.ref],
              {
                select: { isExternal: true },
              },
            );
            const [syntaxWithLoc] = await ctx.syntaxOf([makeCall.ref], {
              select: { location: true, kind: true },
            });
            const [syntaxWithoutLoc] = await ctx.syntaxOf([makeCall.ref], {
              select: { text: true },
            });
            const [callWithLoc] = await ctx.resolveCalls([makeCall.ref], {
              select: { location: true },
            });
            assert.ok(
              declWithLoc &&
                declWithoutLoc &&
                syntaxWithLoc &&
                syntaxWithoutLoc &&
                callWithLoc,
            );

            const [projectedCall] =
              callWithLoc.call !== null
                ? await ctx.projectCalls([callWithLoc.call], {
                    select: { location: true },
                  })
                : [];
            assert.ok(projectedCall);

            ctx.report({
              at: disposeCall.location,
              message: "Selected relation bundle diagnostic.",
              basis: [
                trueBranch,
                covItem,
                instInfo,
                instRes,
                projInstWithLoc,
                projInstWithoutLoc,
                targetCleanup,
                cleanupSite,
                implRes,
                declWithLoc,
                declWithoutLoc,
                syntaxWithLoc,
                syntaxWithoutLoc,
                callWithLoc,
                projectedCall,
              ],
            });
          },
        });

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            rules: [rule],
          }),
        });

        assert.equal(report.diagnostics.length, 1);
        const diag = report.diagnostics[0]!;
        assert.ok(
          diag.evidence.some((ev) => ev.at?.line === 9 && ev.kind === "source"),
          `Expected branch evidence on line 9: ${JSON.stringify(diag.evidence)}`,
        );
        assert.ok(
          diag.evidence.some(
            (ev) => ev.at?.line === 4 && ev.declaration === "makeResource",
          ),
          `Expected declaration evidence on line 4: ${JSON.stringify(diag.evidence)}`,
        );
        assert.ok(
          diag.evidence.some((ev) => ev.at?.line === 5),
          `Expected instance allocation evidence on line 5: ${JSON.stringify(diag.evidence)}`,
        );
        assert.ok(
          diag.evidence.some((ev) => ev.at?.line === 10),
          `Expected cleanup site evidence on line 10: ${JSON.stringify(diag.evidence)}`,
        );
      },
    );
  });

  void it("threads provenance registered via registerProvenance() through evidenceOf() and rule reports", async () => {
    await withTempHost(
      { host: "sdk-queries/selected-evidence-relations" },
      async (host) => {
        await host.typecheck();

        const rule = defineRule({
          id: "domain-provenance-rule",
          run: async (ctx) => {
            const calls = await ctx.findSyntax({
              files: ["src/impl.ts"],
              kinds: ["CallExpression"],
            });
            const makeCall = calls.find((c) => c.text === "makeResource()");
            assert.ok(makeCall);

            const domainItem = registerProvenance(
              { schemaName: "userSchema" },
              [
                {
                  kind: "source",
                  message:
                    "Domain provenance attached via registerProvenance()",
                  at: makeCall.location,
                },
              ],
            );
            assert.equal(evidenceOf(domainItem).length, 1);

            const combined = extractBasisEvidence([
              domainItem,
              {
                kind: "note",
                message: "Rule diagnostic note",
                at: makeCall.location,
              },
            ]);
            assert.equal(combined.length, 2);

            ctx.report({
              at: makeCall.location,
              message: "Domain provenance diagnostic.",
              basis: [domainItem],
            });
          },
        });

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
        });

        assert.equal(report.diagnostics.length, 1);
        assert.ok(
          report.diagnostics[0]!.evidence.some(
            (ev) =>
              ev.kind === "source" &&
              ev.message ===
                "Domain provenance attached via registerProvenance()",
          ),
        );
      },
    );
  });
});
