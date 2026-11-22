import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPENSTATUS_GET_GATE_PROJECTS,
  OPENSTATUS_WHOAMI_STEPS,
  runOpenStatusAdapterCostAcceptance,
} from "@verule/acceptance";

void test("compares Rust and TS Drizzle providers on OpenStatus for equivalence, latency, 3 configs, reuse, invalidation, provider selection, RPC bytes, memory, and observe overhead", async () => {
  const result = await runOpenStatusAdapterCostAcceptance();
  console.info(JSON.stringify(result, null, 2));

  // 1. Packed workspace artifacts and binary digest
  assert.equal(result.artifacts.length, 6);
  for (const pkgName of [
    "@verule/engine",
    "@verule/sdk",
    "@verule/cli",
    "@verule/adapter-zod",
    "@verule/adapter-drizzle",
    "@verule/rules-reference",
  ]) {
    const artifact = result.artifacts.find((a) => a.name === pkgName);
    assert.ok(artifact, `Missing artifact digest for ${pkgName}`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  }

  // 2. OpenStatus whoami 3-commit sequence alignment (Rust == TS)
  assert.equal(result.whoamiAlignment.length, 3);
  const expectedWhoamiDiagnostics = [1, 1, 0];
  for (let i = 0; i < result.whoamiAlignment.length; i += 1) {
    const step = result.whoamiAlignment[i]!;
    assert.equal(step.sha, OPENSTATUS_WHOAMI_STEPS[i]!.sha);
    assert.ok(step.factCount > 0);
    assert.equal(step.diagnosticCount, expectedWhoamiDiagnostics[i]);
    assert.equal(step.factsExactMatch, true);
    assert.equal(step.diagnosticsExactMatch, true);
    assert.equal(step.gapsExactMatch, true);
    assert.equal(step.evidenceExactMatch, true);
  }

  // 3. OpenStatus getGate full alignment + cold latency distributions
  assert.ok(result.getGateAlignment.tsCount > 0);
  assert.equal(
    result.getGateAlignment.tsCount,
    result.getGateAlignment.rustCount,
  );
  assert.equal(result.getGateAlignment.factsExactMatch, true);
  assert.equal(result.getGateAlignment.diagnosticsExactMatch, true);
  assert.equal(result.getGateAlignment.gapsExactMatch, true);
  assert.equal(result.getGateAlignment.evidenceExactMatch, true);

  assert.ok(result.coldLatency.ts.runsMs.length >= 3);
  assert.ok(result.coldLatency.rust.runsMs.length >= 3);
  assert.ok(result.coldLatency.ts.medianMs > 0);
  assert.ok(result.coldLatency.rust.medianMs > 0);

  // 4. Long-lived watch incremental edits (initial -> remove slug -> restore slug), each matching cold verule check
  for (const implKey of ["ts", "rust"] as const) {
    const steps = result.watchEdits[implKey];
    assert.equal(steps.length, 3);
    assert.equal(steps[0]!.label, "initial");
    assert.equal(steps[0]!.diagnosticsCount, 0);
    assert.equal(steps[0]!.matchesColdCheck, true);

    assert.equal(steps[1]!.label, "remove-slug-column");
    assert.equal(steps[1]!.diagnosticsCount, 1);
    assert.equal(steps[1]!.matchesColdCheck, true);

    assert.equal(steps[2]!.label, "restore-slug-column");
    assert.equal(steps[2]!.diagnosticsCount, 0);
    assert.equal(steps[2]!.matchesColdCheck, true);

    for (const s of steps) {
      assert.ok(s.watchFeedbackMs >= 0);
      assert.ok(s.coldCheckMs > 0);
      assert.ok(s.memory.hostRssBytes > 0);
      assert.ok(
        s.memory.engineRssBytes !== undefined && s.memory.engineRssBytes > 0,
      );
    }
  }

  // 5. Three configurations (disabled, enabled-unqueried with zero extraction, enabled-queried)
  for (const implKey of ["ts", "rust"] as const) {
    const matrix = result.threeConfigs[implKey];
    assert.equal(matrix.disabled.diagnosticsCount, 0);
    assert.equal(matrix.disabled.tsExtractions, 0);
    assert.equal(matrix.disabled.rustExtractions, 0);
    assert.equal(matrix.disabled.rustEngineExtractions, 0);

    assert.equal(matrix.enabledUnqueried.diagnosticsCount, 0);
    assert.equal(matrix.enabledUnqueried.tsExtractions, 0);
    assert.equal(matrix.enabledUnqueried.rustExtractions, 0);
    assert.equal(matrix.enabledUnqueried.rustEngineExtractions, 0);
    assert.equal(matrix.enabledUnqueried.providerObserved, false);

    assert.ok(matrix.enabledQueried.coldCheckMs > 0);
    assert.ok(matrix.enabledQueried.editCheckMs >= 0);
  }
  assert.ok(result.threeConfigs.ts.enabledQueried.tsExtractions >= 1);
  assert.ok(result.threeConfigs.rust.enabledQueried.rustExtractions >= 1);
  assert.ok(result.threeConfigs.rust.enabledQueried.rustEngineExtractions >= 1);

  // 6. Cross-rule reuse + Drizzle table & Zod schema edit invalidation (1 extraction per project across 2 rules)
  const expectedProjectExtractions = OPENSTATUS_GET_GATE_PROJECTS.length;
  for (const implKey of ["ts", "rust"] as const) {
    const reuse = result.reuseAndInvalidation[implKey];
    assert.equal(reuse.firstRuleCacheStatus, "computed");
    assert.equal(reuse.secondRuleCacheStatus, "reused");
    assert.equal(reuse.extractionsAcrossTwoRules, expectedProjectExtractions);
    assert.equal(reuse.afterTableEditRecomputed, true);
    assert.equal(reuse.afterTableEditEvidenceUpdated, true);
    assert.equal(reuse.afterSchemaEditRecomputed, true);
    assert.equal(reuse.afterSchemaEditEvidenceUpdated, true);
  }

  // 7. Automatic FactType selection vs explicit providerId selection
  assert.deepEqual(result.providerSelection.byFactType.providersUsed, [
    "drizzle",
    "drizzle-rust",
  ]);
  assert.equal(
    result.providerSelection.byFactType.tsExtractions,
    expectedProjectExtractions,
  );
  assert.equal(
    result.providerSelection.byFactType.rustExtractions,
    expectedProjectExtractions,
  );

  assert.deepEqual(result.providerSelection.explicitRust.providersUsed, [
    "drizzle-rust",
  ]);
  assert.equal(result.providerSelection.explicitRust.tsExtractions, 0);
  assert.equal(
    result.providerSelection.explicitRust.rustExtractions,
    expectedProjectExtractions,
  );

  assert.deepEqual(result.providerSelection.explicitTs.providersUsed, [
    "drizzle",
  ]);
  assert.equal(
    result.providerSelection.explicitTs.tsExtractions,
    expectedProjectExtractions,
  );
  assert.equal(result.providerSelection.explicitTs.rustExtractions, 0);

  // 8. RPC batches, bidirectional bytes, and RSS memory comparison
  const { ts: tsCost, rust: rustCost } = result.costComparison;
  assert.ok(rustCost.rpc.batches < tsCost.rpc.batches);
  assert.ok(rustCost.rpc.bytesReceived < tsCost.rpc.bytesReceived);
  assert.ok(
    rustCost.rpc.bytesSent + rustCost.rpc.bytesReceived <
      tsCost.rpc.bytesSent + tsCost.rpc.bytesReceived,
  );
  assert.ok(tsCost.memory.hostRssBytes > 0);
  assert.ok(
    tsCost.memory.engineRssBytes !== undefined &&
      tsCost.memory.engineRssBytes > 0,
  );
  assert.ok(rustCost.memory.hostRssBytes > 0);
  assert.ok(
    rustCost.memory.engineRssBytes !== undefined &&
      rustCost.memory.engineRssBytes > 0,
  );

  // 9. Observe off vs detail external wall-clock & internal overhead parity
  assert.equal(result.observeOverhead.ts.businessReportIdentical, true);
  assert.equal(result.observeOverhead.rust.businessReportIdentical, true);
  assert.ok(result.observeOverhead.ts.offExternalMs > 0);
  assert.ok(result.observeOverhead.rust.offExternalMs > 0);
});
