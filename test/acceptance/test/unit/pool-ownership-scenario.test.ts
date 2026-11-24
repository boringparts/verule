import assert from "node:assert/strict";
import { test } from "node:test";

import { withTempHost } from "@verule/test-hosts";

import {
  generatePoolOwnershipProject,
  POOL_OWNERSHIP_SMALL_SCALE,
  POOL_OWNERSHIP_TIERS,
} from "../../src/index.ts";

void test("generatePoolOwnershipProject deterministically builds all five scale tiers with exact file and candidate counts", () => {
  for (const tier of POOL_OWNERSHIP_TIERS) {
    const first = generatePoolOwnershipProject(tier);
    const second = generatePoolOwnershipProject(tier);

    assert.deepEqual(first, second);
    assert.equal(first.sourceFiles.length, tier.fileCount);
    assert.equal(first.poolFiles.length, tier.candidateFactoryCount);
    assert.equal(
      first.sourceFiles.filter((file) => file.startsWith("src/")).length,
      tier.fileCount,
    );

    const resourcePoolOccurrences = first.sourceFiles.reduce((total, file) => {
      const content = first.files[file] ?? "";
      return total + (content.match(/new ResourcePool\(/gu)?.length ?? 0);
    }, 0);
    assert.equal(
      resourcePoolOccurrences,
      tier.candidateFactoryCount,
      `Expected ${String(tier.candidateFactoryCount)} ResourcePool factories in tier ${String(tier.fileCount)}/${String(tier.candidateFactoryCount)}`,
    );

    const configSource = first.files["verule.config.ts"] ?? "";
    assert.match(configSource, /poolResourceOwnershipModel/u);
    assert.match(configSource, /poolResourceOwnershipRule/u);
    assert.equal(configSource.includes("collapsible-list-pool"), false);
  }
});

void test("generatePoolOwnershipProject rejects invalid scale bounds", () => {
  assert.throws(
    () =>
      generatePoolOwnershipProject({ fileCount: 4, candidateFactoryCount: 1 }),
    /fileCount/u,
  );
  assert.throws(
    () =>
      generatePoolOwnershipProject({ fileCount: 10, candidateFactoryCount: 0 }),
    /candidateFactoryCount/u,
  );
});

void test("generated 64/8 small-tier project passes standalone tsc typecheck", async () => {
  const generated = generatePoolOwnershipProject(POOL_OWNERSHIP_SMALL_SCALE);
  await withTempHost({ files: generated.files }, async (tempHost) => {
    await tempHost.typecheck("tsconfig.json");
  });
});
