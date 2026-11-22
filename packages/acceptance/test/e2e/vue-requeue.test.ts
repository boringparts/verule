import assert from "node:assert/strict";
import { test } from "node:test";

import {
  VUE_REQUEUE_AFTER_SHA,
  VUE_REQUEUE_BEFORE_SHA,
  VUE_REQUEUE_PACKAGE_BATCH,
  packWorkspaceArtifacts,
  runVueRequeueReplay,
} from "@verule/acceptance";

void test("replays Vue reentrant scheduler fix (7257e6a3 -> d18d6aa1) in isolated out-of-repo checkouts with locally packed artifacts", async () => {
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: VUE_REQUEUE_PACKAGE_BATCH,
  });

  try {
    const outcome = await runVueRequeueReplay({
      bundle,
      isolated: true,
    });

    assert.equal(
      outcome.before.status,
      "completed",
      outcome.before.status === "preparation-failed"
        ? `Before preparation failed: ${outcome.before.message}\n${outcome.before.stderr}`
        : "Expected before replay to complete",
    );
    assert.equal(
      outcome.after.status,
      "completed",
      outcome.after.status === "preparation-failed"
        ? `After preparation failed: ${outcome.after.message}\n${outcome.after.stderr}`
        : "Expected after replay to complete",
    );

    if (
      outcome.before.status !== "completed" ||
      outcome.after.status !== "completed"
    ) {
      return;
    }

    // 1. Artifact resolution & dev-repo isolation checks
    for (const run of [outcome.before, outcome.after]) {
      assert.equal(run.isolation?.controlProbeBlocked, true);
      assert.ok(
        run.resolutionAudit.resolvedDirectPackages["@verule/rules-reference"],
      );
      assert.equal(run.report.projects.length, 1);
      assert.equal(run.report.projects[0]?.configFile, "tsconfig.json");
      assert.ok(
        (run.report.projects[0]?.sourceFiles.length ?? 0) >= 400,
        `Expected Vue root tsconfig.json to cover full project (>=400 project TS files), got ${String(run.report.projects[0]?.sourceFiles.length)}`,
      );
      assert.ok(
        run.report.projects[0]?.sourceFiles.includes(
          "packages/runtime-core/src/scheduler.ts",
        ),
      );
      assert.ok(
        run.report.projects[0]?.sourceFiles.includes(
          "packages/runtime-core/src/errorHandling.ts",
        ),
      );
    }

    // 2. Pre-fix (7257e6a3): hits both L165 (direct cb()) and L242 (indirect callWithErrorHandling), zero false positives on pre-clears, finally drain, and flushPostFlushCbs
    assert.equal(outcome.before.sha, VUE_REQUEUE_BEFORE_SHA);
    assert.equal(outcome.before.exitCode, 1);
    assert.equal(outcome.before.variant, "findings");
    assert.equal(outcome.before.report.status, "findings");
    assert.equal(outcome.before.report.diagnostics.length, 2);

    assert.deepEqual(
      outcome.before.report.diagnostics.map((d) => ({
        file: d.at.file,
        line: d.at.line,
      })),
      [
        { file: "packages/runtime-core/src/scheduler.ts", line: 165 },
        { file: "packages/runtime-core/src/scheduler.ts", line: 242 },
      ],
    );

    const preFlushDiag = outcome.before.report.diagnostics[0]!;
    assert.ok(
      preFlushDiag.evidence.some(
        (e) => e.kind === "model" && e.modelId === "vue-main-scheduler-queue",
      ),
    );
    assert.ok(
      preFlushDiag.evidence.some(
        (e) =>
          e.message.includes("enqueue-sets-queued") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 111,
      ),
    );
    assert.ok(
      preFlushDiag.evidence.some(
        (e) =>
          e.message.includes("main-queue-read") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 151,
      ),
    );
    assert.ok(
      preFlushDiag.evidence.some(
        (e) =>
          e.message.includes("pre-call-allow-recurse-preclear") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 162,
      ),
    );
    assert.ok(
      preFlushDiag.evidence.some(
        (e) =>
          e.message.includes("direct-callback-call") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 164,
      ),
    );
    assert.ok(
      preFlushDiag.evidence.some(
        (e) =>
          e.message.includes("unguarded-post-callback-clear") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 165,
      ),
    );
    assert.ok(
      preFlushDiag.evidence.some((e) =>
        e.message.includes("Target reached along bypass path"),
      ),
    );

    const flushJobsDiag = outcome.before.report.diagnostics[1]!;
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("enqueue-sets-queued") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 111,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("main-queue-read") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 229,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("pre-call-allow-recurse-preclear") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 235,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("indirect-callback-call") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 237,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("callback-helper-declaration") &&
          e.at?.file === "packages/runtime-core/src/errorHandling.ts" &&
          e.at.line === 70,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("helper-invokes-param") &&
          e.at?.file === "packages/runtime-core/src/errorHandling.ts" &&
          e.at.line === 77,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some(
        (e) =>
          e.message.includes("unguarded-post-callback-clear") &&
          e.at?.file === "packages/runtime-core/src/scheduler.ts" &&
          e.at.line === 242,
      ),
    );
    assert.ok(
      flushJobsDiag.evidence.some((e) =>
        e.message.includes("Target reached along bypass path"),
      ),
    );

    // 3. Post-fix (d18d6aa1): all violations cleared (0 findings, exit 0)
    assert.equal(outcome.after.sha, VUE_REQUEUE_AFTER_SHA);
    assert.equal(outcome.after.exitCode, 0);
    assert.equal(outcome.after.variant, "clean");
    assert.equal(outcome.after.report.status, "clean");
    assert.equal(outcome.after.report.diagnostics.length, 0);

    console.info(
      JSON.stringify(
        {
          before: {
            sha: outcome.before.sha,
            exitCode: outcome.before.exitCode,
            prepareMs: Math.round(outcome.before.prepareMs),
            durationMs: Math.round(outcome.before.durationMs),
            projects: outcome.before.report.projects.map((p) => ({
              configFile: p.configFile,
              fileCount: p.sourceFiles.length,
            })),
            diagnostics: outcome.before.report.diagnostics.map((d) => ({
              ruleId: d.ruleId,
              at: `${d.at.file}:${d.at.line}:${d.at.column}`,
              message: d.message,
              evidence: d.evidence.map((e) => ({
                kind: e.kind,
                at:
                  e.at === undefined
                    ? undefined
                    : `${e.at.file}:${e.at.line}:${e.at.column}`,
                message: e.message,
              })),
            })),
            gapsCount: outcome.before.report.gaps.length,
          },
          after: {
            sha: outcome.after.sha,
            exitCode: outcome.after.exitCode,
            prepareMs: Math.round(outcome.after.prepareMs),
            durationMs: Math.round(outcome.after.durationMs),
            projects: outcome.after.report.projects.map((p) => ({
              configFile: p.configFile,
              fileCount: p.sourceFiles.length,
            })),
            diagnosticsCount: outcome.after.report.diagnostics.length,
            gapsCount: outcome.after.report.gaps.length,
          },
        },
        null,
        2,
      ),
    );
  } finally {
    bundle.dispose();
  }
});
