import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { describe, it } from "node:test";

import {
  defineConfig,
  defineRule,
  openSession,
  runCheck,
  type SyntaxRef,
} from "@boringparts/verule";
import { withTempHost } from "@verule/test-hosts";

void describe("@boringparts/verule explain and observation", () => {
  void it("skips lazy checkpoint details when observe is off or summary, and evaluates them in detail mode", async () => {
    await withTempHost({ host: "sdk-projects/explain-basic" }, async (host) => {
      await host.typecheck();
      let detailEvalCount = 0;

      const ruleWithCheckpoint = defineRule({
        id: "rule-sink-string",
        run: async (ctx) => {
          const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const sinks = calls.filter((c) => c.text.startsWith("sink("));
          if (fns[0] && sinks[0]) {
            await ctx.branchCoverage({
              function: fns[0].ref,
              branches: [],
              targets: [sinks[0].ref],
            });
          }
          const args = sinks
            .map((c) => c.arguments?.[1])
            .filter((arg): arg is SyntaxRef => arg !== undefined);
          const types = await ctx.typeAt(args);

          for (const [index, ty] of types.entries()) {
            const call = sinks[index]!;
            if (ty.typeText === "string") {
              ctx.checkpoint("require-string-arg", call, "pass", () => {
                detailEvalCount += 1;
                return { actualType: ty.typeText };
              });
              ctx.report({
                at: call.location,
                message: "sink() received narrowed string",
                findingKey: "narrowed-string",
              });
            } else {
              ctx.checkpoint("require-string-arg", call, "exclude", () => {
                detailEvalCount += 1;
                return { actualType: ty.typeText, expected: "string" };
              });
            }
          }
        },
      });

      const config = defineConfig({
        tsconfig: "tsconfig.json",
        rules: [ruleWithCheckpoint],
      });

      // 1. Default observe = "off": zero debug fields, zero lazy detail evaluations
      const offStart = performance.now();
      const offReport = await runCheck({ cwd: host.rootDir, config });
      const offElapsedMs = performance.now() - offStart;
      assert.equal(detailEvalCount, 0);
      assert.equal("observation" in offReport, false);
      assert.equal("explanation" in offReport, false);

      // 2. observe = "summary": phase/rpc/overhead metrics present, details omitted, lazy detail skipped
      const summaryReport = await runCheck({
        cwd: host.rootDir,
        config,
        observe: "summary",
      });
      assert.equal(detailEvalCount, 0);
      assert.ok(summaryReport.observation);
      assert.equal(summaryReport.observation.mode, "summary");
      assert.equal(summaryReport.observation.truncated, false);
      assert.equal(summaryReport.observation.droppedCount, 0);
      assert.equal(summaryReport.observation.details, undefined);
      assert.ok(summaryReport.observation.phases.configAndOpenMs >= 0);
      assert.ok(summaryReport.observation.phases.engineQueryMs >= 0);
      assert.ok(summaryReport.observation.phases.ruleExecutionMs >= 0);
      assert.ok(summaryReport.observation.rpc.batches >= 2);
      assert.ok(summaryReport.observation.rpc.bytesSent > 0);
      assert.ok(summaryReport.observation.rpc.bytesReceived > 0);
      assert.ok(summaryReport.observation.overhead.checkpointMs >= 0);
      assert.ok(summaryReport.observation.overhead.encodeMs >= 0);
      assert.ok(summaryReport.observation.overhead.writeMs >= 0);
      assert.ok(summaryReport.observation.lowering.functionsLowered >= 1);
      assert.ok(summaryReport.observation.lowering.verticesCreated >= 1);
      assert.ok(summaryReport.observation.lowering.durationMs >= 0);
      assert.ok(summaryReport.observation.irCache.functionHits >= 0);
      assert.ok(summaryReport.observation.irCache.functionMisses >= 0);
      assert.ok(summaryReport.observation.irCache.filesReused >= 0);
      assert.ok(summaryReport.observation.irCache.filesInvalidated >= 0);
      assert.ok(summaryReport.observation.summaryLookup.lookups >= 0);
      assert.ok(summaryReport.observation.summaryLookup.hits >= 0);
      assert.ok(summaryReport.observation.summaryLookup.misses >= 0);
      assert.ok(
        summaryReport.observation.summaryLookup.hitsBySource.builtin >= 0,
      );

      // 3. observe = "detail": evaluates lazy callbacks, business report remains identical
      const detailStart = performance.now();
      const detailReport = await runCheck({
        cwd: host.rootDir,
        config,
        observe: "detail",
      });
      const detailElapsedMs = performance.now() - detailStart;
      assert.ok(detailEvalCount >= 2, `expected >= 2, got ${detailEvalCount}`);
      assert.ok(detailReport.observation);
      assert.equal(detailReport.observation.mode, "detail");
      assert.ok((detailReport.observation.details?.length ?? 0) >= 2);
      assert.ok(offElapsedMs >= 0 && detailElapsedMs >= 0);

      // Business report parity between observe=off and observe=detail
      assert.equal(detailReport.status, offReport.status);
      assert.deepEqual(detailReport.diagnostics, offReport.diagnostics);
      assert.deepEqual(detailReport.gaps, offReport.gaps);
      assert.deepEqual(detailReport.projects, offReport.projects);
    });
  });

  void it("marks truncation and droppedCount when observeLimit is exceeded", async () => {
    await withTempHost({ host: "sdk-projects/explain-basic" }, async (host) => {
      await host.typecheck();
      const rule = defineRule({
        id: "rule-many-checkpoints",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          for (const call of calls) {
            ctx.checkpoint("visit-call", call, "info", () => ({
              text: call.text,
              padding: "x".repeat(64),
            }));
          }
        },
      });

      const itemLimited = await runCheck({
        cwd: host.rootDir,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
        observe: "detail",
        observeLimit: { maxItems: 2 },
      });
      assert.ok(itemLimited.observation);
      assert.equal(itemLimited.observation.truncated, true);
      assert.ok(itemLimited.observation.droppedCount >= 1);
      assert.equal(itemLimited.observation.details?.length, 2);

      const byteLimited = await runCheck({
        cwd: host.rootDir,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
        observe: "detail",
        observeLimit: { maxBytes: 220 },
      });
      assert.ok(byteLimited.observation);
      assert.equal(byteLimited.observation.truncated, true);
      assert.ok(byteLimited.observation.droppedCount >= 1);
    });
  });

  void it("explains checkpoint exclusion, candidate miss, out-of-project targets, reported targets, and reused queries", async () => {
    await withTempHost({ host: "sdk-projects/explain-basic" }, async (host) => {
      await host.typecheck();
      const firstRule = defineRule({
        id: "rule-prefilter",
        run: async (ctx) => {
          await ctx.findSyntax({ kinds: ["CallExpression"] });
        },
      });
      const targetRule = defineRule({
        id: "rule-sink-string",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const sinks = calls.filter((c) => c.text.startsWith("sink("));
          const args = sinks
            .map((c) => c.arguments?.[1])
            .filter((arg): arg is SyntaxRef => arg !== undefined);
          const types = await ctx.typeAt(args);

          for (const [index, ty] of types.entries()) {
            const call = sinks[index]!;
            if (ty.typeText === "string") {
              ctx.checkpoint("require-string-arg", call, "pass", () => ({
                actualType: ty.typeText,
              }));
              ctx.report({
                at: call.location,
                message: "sink() received narrowed string",
              });
            } else {
              ctx.checkpoint("require-string-arg", call, "exclude", () => ({
                actualType: ty.typeText,
                expected: "string",
              }));
            }
          }
        },
      });

      const session = await openSession({
        cwd: host.rootDir,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [firstRule, targetRule],
        }),
      });

      try {
        // 1. Excluded by named checkpoint (line 13: return sink(mode, input);)
        const excluded = await session.explain({
          ruleId: "rule-sink-string",
          at: "src/handlers.ts:13:12",
        });
        assert.equal(excluded.explanation.status, "excluded_by_checkpoint");
        assert.equal(excluded.explanation.inCandidates, true);
        assert.equal(
          excluded.explanation.excludedByCheckpoint?.name,
          "require-string-arg",
        );
        assert.deepEqual(excluded.explanation.excludedByCheckpoint?.detail, {
          actualType: "number",
          expected: "string",
        });
        // Because firstRule already queried CallExpression in the same session, check cacheStatus tracking
        assert.ok(
          excluded.explanation.queries.some(
            (q) => q.op === "findSyntax" && q.candidateCount >= 3,
          ),
        );

        // 2. Also verify reused query tracking when running both rules in one check with explain
        const combinedExplain = await session.check({
          at: "src/handlers.ts:13:12",
          observe: "summary",
        });
        const secondRuleExplain = combinedExplain.explanations?.find(
          (item) => item.ruleId === "rule-sink-string",
        );
        assert.ok(secondRuleExplain);
        assert.ok(
          secondRuleExplain.queries.some(
            (q) => q.op === "findSyntax" && q.cacheStatus === "reused",
          ),
        );

        // 3. Not in candidates (line 1: function declaration signature, not a CallExpression)
        const notCandidate = await session.explain({
          ruleId: "rule-sink-string",
          at: "src/handlers.ts:1:1",
        });
        assert.equal(notCandidate.explanation.inCandidates, false);
        assert.equal(notCandidate.explanation.status, "not_in_candidates");
        assert.equal(
          notCandidate.explanation.excludedByQuery?.op,
          "findSyntax",
        );

        // 4. Target not in project
        const missingFile = await session.explain({
          ruleId: "rule-sink-string",
          at: "src/nonexistent.ts:5:1",
        });
        assert.equal(missingFile.explanation.inCandidates, false);
        assert.equal(missingFile.explanation.status, "target_not_in_project");

        // 5. Reported at target (line 10: return sink(mode, input);)
        const reported = await session.explain({
          ruleId: "rule-sink-string",
          at: "src/handlers.ts:10:12",
        });
        assert.equal(reported.explanation.status, "reported");
        assert.equal(reported.explanation.inCandidates, true);
      } finally {
        await session.close();
      }
    });
  });

  void it("preserves query gaps when cached relation queries are reused across same-snapshot check and explain calls", async () => {
    await withTempHost(
      { host: "sdk-projects/explain-parser" },
      async (host) => {
        host.writeText(
          "src/handlers.ts",
          [
            "declare function makeInput(): { id: number };",
            "declare function sink(value: unknown): void;",
            "",
            "export function runFlow(cb: (v: unknown) => unknown) {",
            "  const row = makeInput();",
            "  const out = cb(row);",
            "  sink(out);",
            "}",
            "",
          ].join("\n"),
        );
        await host.typecheck();

        const propRule = defineRule({
          id: "rule-prop-gap-cache",
          run: async (ctx) => {
            const calls = await ctx.findSyntax({
              files: ["src/handlers.ts"],
              kinds: ["CallExpression"],
            });
            const makeCall = calls.find((c) => c.text === "makeInput()");
            const sinkCall = calls.find((c) => c.text.startsWith("sink("));
            const argRef = sinkCall?.arguments?.[0];
            if (!makeCall || !sinkCall || !argRef) return;
            await ctx.valuePropagation({
              propagation: "value",
              from: makeCall.ref,
              to: argRef,
            });
          },
        });

        const session = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            rules: [propRule],
          }),
        });

        try {
          const first = await session.check();
          assert.ok(
            first.gaps.some((g) => g.kind === "dynamic-callee"),
            JSON.stringify(first.gaps),
          );

          // Reusing cached valuePropagation on the same snapshot MUST preserve report.gaps and explain.gaps.
          const second = await session.check({ at: "src/handlers.ts:6:15" });
          assert.equal(
            second.identity.snapshotDigest,
            first.identity.snapshotDigest,
          );
          assert.deepEqual(second.gaps, first.gaps);
          const exp =
            second.explanation ??
            second.explanations?.find(
              (item) => item.ruleId === "rule-prop-gap-cache",
            );
          assert.ok(exp);
          assert.ok(
            exp.gaps.some((g) => g.kind === "dynamic-callee"),
            JSON.stringify(exp.gaps),
          );
        } finally {
          await session.close();
        }
      },
    );
  });

  void it("collects rule-recorded domain gaps via ctx.recordGaps and tracks irCache reuse on session.update()", async () => {
    await withTempHost({ host: "sdk-projects/explain-basic" }, async (host) => {
      await host.typecheck();

      const gapRule = defineRule({
        id: "rule-record-domain-gap",
        run: async (ctx) => {
          const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const firstCall = calls[0];
          if (fns[0] && firstCall) {
            await ctx.branchCoverage({
              function: fns[0].ref,
              branches: [],
              targets: [firstCall.ref],
            });
          }
          if (firstCall) {
            ctx.recordGaps([
              {
                kind: "dynamic-schema-spread",
                message: "Dynamic spread in validation schema",
                at: firstCall.location,
              },
            ]);
          }
        },
      });

      const session = await openSession({
        cwd: host.rootDir,
        observe: "summary",
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [gapRule],
        }),
      });
      try {
        const first = await session.check({ observe: "summary" });
        assert.ok(
          first.gaps.some((g) => g.kind === "dynamic-schema-spread"),
          JSON.stringify(first.gaps),
        );
        assert.ok((first.observation?.lowering.functionsLowered ?? 0) >= 1);

        host.writeText("src/extra.ts", "export const extra = 1;\n");
        await session.update({ created: ["src/extra.ts"] });

        const afterUpdate = await session.check({ observe: "summary" });
        assert.ok(afterUpdate.observation);
        assert.ok(
          afterUpdate.observation.irCache.functionHits >= 1 ||
            afterUpdate.observation.irCache.filesReused >= 1,
          JSON.stringify(afterUpdate.observation.irCache),
        );
      } finally {
        await session.close();
      }
    });
  });
});
