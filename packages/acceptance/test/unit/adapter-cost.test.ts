import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { runControlledAdapterCostComparison } from "@verule/acceptance";

void describe("@verule/acceptance adapter-cost controlled suite", () => {
  void it("aligns Rust and TS Drizzle facts/diagnostics/evidence/gaps and measures 3-config, reuse, invalidation, provider selection, RPC, memory, and observe overhead", async () => {
    const result = await runControlledAdapterCostComparison();

    // 1. Fact-level and diagnostic-level equivalence
    assert.equal(result.factAlignment.tsCount, result.factAlignment.rustCount);
    assert.ok(result.factAlignment.tsCount >= 4);
    assert.equal(result.factAlignment.factsExactMatch, true);
    assert.equal(result.factAlignment.diagnosticsExactMatch, true);
    assert.equal(result.factAlignment.gapsExactMatch, true);
    assert.equal(result.factAlignment.evidenceExactMatch, true);

    // 2. Three configurations: disabled, enabled-unqueried (0 extractions on BOTH TS & Rust), enabled-queried
    assert.equal(result.threeConfigs.ts.disabled.diagnosticsCount, 0);
    assert.equal(result.threeConfigs.rust.disabled.diagnosticsCount, 0);

    assert.equal(result.threeConfigs.ts.enabledUnqueried.tsExtractions, 0);
    assert.equal(result.threeConfigs.ts.enabledUnqueried.rustExtractions, 0);
    assert.equal(
      result.threeConfigs.ts.enabledUnqueried.providerObserved,
      false,
    );

    assert.equal(result.threeConfigs.rust.enabledUnqueried.tsExtractions, 0);
    assert.equal(result.threeConfigs.rust.enabledUnqueried.rustExtractions, 0);
    assert.equal(
      result.threeConfigs.rust.enabledUnqueried.rustEngineExtractions,
      0,
    );
    assert.equal(
      result.threeConfigs.rust.enabledUnqueried.providerObserved,
      false,
    );

    assert.ok(result.threeConfigs.ts.enabledQueried.coldCheckMs >= 0);
    assert.ok(result.threeConfigs.ts.enabledQueried.editCheckMs >= 0);
    assert.ok(result.threeConfigs.rust.enabledQueried.coldCheckMs >= 0);
    assert.ok(result.threeConfigs.rust.enabledQueried.editCheckMs >= 0);
    assert.equal(
      result.threeConfigs.ts.enabledQueried.diagnosticsCount,
      result.threeConfigs.rust.enabledQueried.diagnosticsCount,
    );

    // 3. Cross-rule reuse & table/schema edit invalidation
    for (const side of [
      result.reuseAndInvalidation.ts,
      result.reuseAndInvalidation.rust,
    ]) {
      assert.equal(side.firstRuleCacheStatus, "computed");
      assert.equal(side.secondRuleCacheStatus, "reused");
      assert.equal(side.extractionsAcrossTwoRules, 1);
      assert.equal(side.afterTableEditRecomputed, true);
      assert.equal(side.afterTableEditEvidenceUpdated, true);
      assert.equal(side.afterSchemaEditRecomputed, true);
      assert.equal(side.afterSchemaEditEvidenceUpdated, true);
    }

    // 4. By-FactType vs explicit providerId when both adapters are enabled
    assert.deepEqual(
      result.providerSelection.byFactType.providersUsed.toSorted(),
      ["drizzle", "drizzle-rust"],
    );
    assert.ok(result.providerSelection.byFactType.tsExtractions > 0);
    assert.ok(result.providerSelection.byFactType.rustExtractions > 0);
    assert.deepEqual(result.providerSelection.explicitRust.providersUsed, [
      "drizzle-rust",
    ]);
    assert.equal(result.providerSelection.explicitRust.tsExtractions, 0);
    assert.ok(result.providerSelection.explicitRust.rustExtractions > 0);
    assert.deepEqual(result.providerSelection.explicitTs.providersUsed, [
      "drizzle",
    ]);
    assert.equal(result.providerSelection.explicitTs.rustExtractions, 0);
    assert.ok(result.providerSelection.explicitTs.tsExtractions > 0);

    // 5. Cross-language RPC batches/bytes, memory, and observation overhead
    assert.ok(
      result.costComparison.rust.rpc.batches <
        result.costComparison.ts.rpc.batches,
      `Expected Rust RPC batches (${result.costComparison.rust.rpc.batches}) < TS RPC batches (${result.costComparison.ts.rpc.batches})`,
    );
    assert.ok(
      result.costComparison.rust.rpc.bytesReceived <
        result.costComparison.ts.rpc.bytesReceived,
      `Expected Rust bytesReceived (${result.costComparison.rust.rpc.bytesReceived}) < TS bytesReceived (${result.costComparison.ts.rpc.bytesReceived})`,
    );
    assert.ok(result.costComparison.rust.memory.hostRssBytes > 0);
    assert.ok((result.costComparison.rust.memory.engineRssBytes ?? 0) > 0);
    assert.ok(result.costComparison.ts.memory.hostRssBytes > 0);
    assert.ok((result.costComparison.ts.memory.engineRssBytes ?? 0) > 0);

    assert.equal(result.observeOverhead.ts.businessReportIdentical, true);
    assert.equal(result.observeOverhead.rust.businessReportIdentical, true);
    assert.ok(result.observeOverhead.rust.offExternalMs >= 0);
    assert.ok(result.observeOverhead.rust.detailExternalMs >= 0);
    assert.ok(result.observeOverhead.rust.internal.encodeMs >= 0);
  });
});
