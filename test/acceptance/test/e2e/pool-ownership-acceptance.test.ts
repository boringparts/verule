import assert from "node:assert/strict";
import { test } from "node:test";

import {
  addUnlistedProbePoolsFile,
  appendUnrelatedBackgroundComment,
  assertPoolOwnershipClean,
  assertPoolOwnershipDiagnostic,
  assertPoolOwnershipInitialFindings,
  assertPoolOwnershipReportsReconcile,
  fixPoolOwnershipViolation,
  fixUnlistedProbePool,
  POOL_OWNERSHIP_SMALL_SCALE,
  removeUnlistedProbePoolsFile,
  restorePoolOwnershipViolation,
  verifyPoolOwnershipScaleAndCandidates,
  withPoolOwnershipHost,
} from "@verule/acceptance";
import { runTscTypecheck } from "@verule/test-hosts";

void test("verifies 64/8 pool ownership scenario via installed CLI, watch replay, cold-check reconciliation, and unlisted caller probe", async (t) => {
  await withPoolOwnershipHost(
    { scale: POOL_OWNERSHIP_SMALL_SCALE },
    async (host, spec) => {
      await runTscTypecheck(host.appDir, "tsconfig.json");

      const initialCold = await host.check({
        config: spec.configPath,
        timeoutMs: 60_000,
      });
      assert.equal(initialCold.status, 1, initialCold.stderr);
      assert.equal(initialCold.isolation?.controlProbeBlocked, true);
      assertPoolOwnershipInitialFindings(initialCold.report, spec);

      const initialAudit = await verifyPoolOwnershipScaleAndCandidates(
        host,
        spec,
      );
      assert.equal(initialAudit.fileCount, 64);
      assert.equal(initialAudit.candidateCallCount, 8);

      const watch = await host.startWatch({
        config: spec.configPath,
        timeoutMs: 90_000,
      });
      try {
        const watchInitial = await watch.nextReport();
        assert.equal(watchInitial.trigger, "initial");
        assertPoolOwnershipInitialFindings(watchInitial, spec);
        assertPoolOwnershipReportsReconcile(
          watchInitial,
          initialCold.report,
          "initial watch report",
        );

        fixPoolOwnershipViolation(host, spec);
        const watchAfterFix = await watch.nextReport();
        assert.equal(watchAfterFix.trigger, "change");
        assert.ok(
          watchAfterFix.snapshotId > watchInitial.snapshotId,
          `Expected snapshotId to advance (${String(watchInitial.snapshotId)} -> ${String(watchAfterFix.snapshotId)})`,
        );
        assertPoolOwnershipClean(watchAfterFix, spec);

        await runTscTypecheck(host.appDir, "tsconfig.json");
        const coldAfterFix = await host.check({
          config: spec.configPath,
          timeoutMs: 60_000,
        });
        assert.equal(coldAfterFix.status, 0, coldAfterFix.stderr);
        assertPoolOwnershipClean(coldAfterFix.report, spec);
        assertPoolOwnershipReportsReconcile(
          watchAfterFix,
          coldAfterFix.report,
          "edit 1: ownership fixed",
        );

        restorePoolOwnershipViolation(host, spec);
        const watchRestored = await watch.nextReport();
        assert.equal(watchRestored.trigger, "change");
        assert.ok(
          watchRestored.snapshotId > watchAfterFix.snapshotId,
          `Expected snapshotId to advance (${String(watchAfterFix.snapshotId)} -> ${String(watchRestored.snapshotId)})`,
        );
        assertPoolOwnershipInitialFindings(watchRestored, spec);

        const coldRestored = await host.check({
          config: spec.configPath,
          timeoutMs: 60_000,
        });
        assert.equal(coldRestored.status, 1, coldRestored.stderr);
        assertPoolOwnershipReportsReconcile(
          watchRestored,
          coldRestored.report,
          "edit 2: violation restored",
        );

        appendUnrelatedBackgroundComment(
          host,
          spec,
          "watch-unrelated-background-edit",
        );
        const watchUnrelated = await watch.nextReport();
        assert.equal(watchUnrelated.trigger, "change");
        assert.ok(
          watchUnrelated.snapshotId > watchRestored.snapshotId,
          `Expected snapshotId to advance (${String(watchRestored.snapshotId)} -> ${String(watchUnrelated.snapshotId)})`,
        );
        assert.ok(watchUnrelated.sequence > watchRestored.sequence);
        assert.ok(
          watchUnrelated.recomputation.invalidatedBy.includes(
            `changed:${spec.unrelatedFile}`,
          ),
          JSON.stringify(watchUnrelated.recomputation),
        );
        assertPoolOwnershipInitialFindings(watchUnrelated, spec);
        assert.deepEqual(watchUnrelated.diagnostics, watchRestored.diagnostics);
        assert.deepEqual(watchUnrelated.gaps, watchRestored.gaps);

        const coldUnrelated = await host.check({
          config: spec.configPath,
          timeoutMs: 60_000,
        });
        assert.equal(coldUnrelated.status, 1, coldUnrelated.stderr);
        assertPoolOwnershipReportsReconcile(
          watchUnrelated,
          coldUnrelated.report,
          "edit 3: unrelated background comment",
        );
      } finally {
        const watchExit = await watch.close();
        assert.equal(watchExit.code, 0, watchExit.stderr);
      }

      // Generalization probe: unlisted new directory & differently named pools without config/rule changes
      const probe = addUnlistedProbePoolsFile(host, spec);
      await runTscTypecheck(host.appDir, "tsconfig.json");

      const probeAudit = await verifyPoolOwnershipScaleAndCandidates(
        host,
        spec,
        {
          expectedFileCount: spec.scale.fileCount + 1,
          expectedCandidateCount: spec.scale.candidateFactoryCount + 2,
        },
      );
      assert.equal(probeAudit.report.status, "findings");
      assert.equal(
        probeAudit.report.diagnostics.length,
        2,
        JSON.stringify(probeAudit.report.diagnostics),
      );
      const baseDiag = probeAudit.report.diagnostics.find(
        (d) => d.at.file === spec.violatingFile,
      );
      const probeDiag = probeAudit.report.diagnostics.find(
        (d) => d.at.file === probe.file,
      );
      assert.ok(
        baseDiag,
        `Missing base diagnostic in ${JSON.stringify(probeAudit.report.diagnostics)}`,
      );
      assert.ok(
        probeDiag,
        `Missing probe diagnostic in ${JSON.stringify(probeAudit.report.diagnostics)}`,
      );
      assertPoolOwnershipDiagnostic(
        baseDiag,
        spec.violatingFile,
        spec.violatingLine,
      );
      assertPoolOwnershipDiagnostic(probeDiag, probe.file, probe.violatingLine);

      fixUnlistedProbePool(host, spec);
      await runTscTypecheck(host.appDir, "tsconfig.json");
      const afterProbeFix = await host.check({
        config: spec.configPath,
        timeoutMs: 60_000,
      });
      assert.equal(afterProbeFix.status, 1, afterProbeFix.stderr);
      assert.equal(afterProbeFix.report.fileOrigins.length, 65);
      assert.equal(
        afterProbeFix.report.diagnostics.length,
        1,
        JSON.stringify(afterProbeFix.report.diagnostics),
      );
      assertPoolOwnershipDiagnostic(
        afterProbeFix.report.diagnostics[0]!,
        spec.violatingFile,
        spec.violatingLine,
      );

      removeUnlistedProbePoolsFile(host, spec);
      t.diagnostic(
        `Verified 64/8 pool-ownership host (CLI=${host.audit.cliVersion}, isolation=${initialCold.isolation?.mode}, files=${String(initialAudit.fileCount)}, candidates=${String(initialAudit.candidateCallCount)})`,
      );
    },
  );
});
