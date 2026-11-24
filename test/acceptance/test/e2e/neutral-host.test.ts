import assert from "node:assert/strict";
import { test } from "node:test";

import {
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "@verule/acceptance";
import { INLINE_IGNORE_RULE_ID } from "@verule/sdk";
import type { CheckReport, VeruleConfig } from "@verule/sdk";

const configPath = "packages/app/verule.config.ts";
const reviewPath = "packages/app/src/review.ts";
const cachePath = "packages/app/src/cache.ts";

function findSourceTarget(source: string, token: string): string {
  const offset = source.indexOf(token);
  assert.notEqual(offset, -1, `Expected source to contain ${token}`);
  const preceding = source.slice(0, offset);
  const line = preceding.split("\n").length;
  const column = offset - preceding.lastIndexOf("\n");
  return `${line}:${column}`;
}

async function runInstalledSdk(
  host: PreparedAcceptanceHost,
): Promise<CheckReport> {
  const sdk = await host.loadSdk();
  const config = await host.loadConfig<VeruleConfig>(configPath);
  assert.deepEqual(config.adapters, []);
  return sdk.runCheck({ cwd: host.hostDir, config });
}

void test("runs the packed CLI on the neutral cross-package host", async (t) => {
  await withAcceptanceHost({}, async (host) => {
    const cliArtifact = host.artifact("@verule/cli");
    const engineArtifact = host.artifact("@verule/engine");
    assert.ok(engineArtifact.binarySha256);
    assert.equal(host.audit.cliVersion, cliArtifact.version);
    assert.equal(host.audit.engineBinarySha256, engineArtifact.binarySha256);
    assert.ok(host.audit.workspaceSymlinkCount > 0);

    const reviewSource = host.readText(reviewPath);
    const result = await host.check({ config: configPath });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.isolation?.controlProbeBlocked, true);
    assert.equal(result.variant, "findings");
    assert.equal(
      result.report.diagnostics.length,
      1,
      JSON.stringify(result.report.diagnostics),
    );
    assert.equal(
      result.report.diagnostics[0]?.ruleId,
      "neutral-product-review",
      JSON.stringify(result.report.diagnostics),
    );
    assert.ok(
      result.report.diagnostics[0]?.evidence.some(
        (item) =>
          item.at?.file === "packages/data/src/product.ts" &&
          item.message ===
            "The call resolves to the data package product query.",
      ),
    );
    assert.ok(
      result.report.diagnostics[0]?.evidence.some(
        (item) =>
          item.at?.file === "packages/app/src/review.ts" &&
          item.message === "The returned product reaches its price validation.",
      ),
    );
    assert.equal(
      result.report.diagnostics[0]?.at.file,
      "packages/app/src/review.ts",
    );
    assert.ok(
      result.report.diagnostics[0]?.evidence.some(
        (item) => item.at?.file === "packages/data/src/product.ts",
      ),
    );
    assert.deepEqual(await runInstalledSdk(host), result.report);
    assert.ok(
      result.report.gaps.some(
        (gap) =>
          gap.kind === "dynamic-callee" &&
          gap.at?.file === "packages/app/src/review.ts",
      ),
    );

    host.replaceText(
      reviewPath,
      "const product = getProduct(id);",
      'const loadedProduct = getProduct(id);\n  const product = { id, name: "Local product", price: 1 };',
    );
    const disconnectedRun = await host.check({ config: configPath });
    assert.equal(disconnectedRun.status, 0, disconnectedRun.stderr);
    assert.deepEqual(disconnectedRun.report.diagnostics, []);
    assert.deepEqual(await runInstalledSdk(host), disconnectedRun.report);
    host.writeText(reviewPath, reviewSource);

    const cacheSource = host.readText(cachePath);
    const cachedCall = findSourceTarget(cacheSource, "getCachedProduct(id)");
    const explanationRun = await host.check({
      config: configPath,
      rule: "neutral-product-review",
      at: `${cachePath}:${cachedCall}`,
    });
    assert.equal(explanationRun.status, 1, explanationRun.stderr);
    assert.equal(
      explanationRun.report.explanation?.status,
      "not_in_candidates",
    );
    assert.equal(
      explanationRun.report.explanation?.excludedByQuery?.op,
      "findSyntax",
    );

    const suppressedCall = findSourceTarget(
      reviewSource,
      'getProduct("legacy")',
    );
    const suppressedLine = Number(suppressedCall.split(":")[0]);
    const suppressedExplanation = await host.check({
      config: configPath,
      rule: "neutral-product-review",
      at: `${reviewPath}:${suppressedCall}`,
    });
    assert.equal(
      suppressedExplanation.status,
      1,
      suppressedExplanation.stderr + suppressedExplanation.stdout,
    );
    assert.equal(
      suppressedExplanation.report.explanation?.status,
      "suppressed_by_ignore",
    );
    assert.equal(
      suppressedExplanation.report.explanation?.inlineIgnore?.reason,
      "Keep this legacy lookup covered during migration.",
    );
    assert.ok(
      result.report.inlineIgnores?.some(
        (entry) =>
          entry.status === "suppressed" &&
          entry.ruleId === "neutral-product-review" &&
          entry.reason === "Keep this legacy lookup covered during migration.",
      ),
    );

    host.replaceText(
      reviewPath,
      'const product = getProduct("legacy");',
      'const product = getCachedProduct("legacy");',
    );
    const unusedIgnoreRun = await host.check({ config: configPath });
    assert.equal(unusedIgnoreRun.status, 1, unusedIgnoreRun.stderr);
    assert.ok(
      unusedIgnoreRun.report.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === INLINE_IGNORE_RULE_ID,
      ),
    );
    assert.ok(
      unusedIgnoreRun.report.inlineIgnores?.some(
        (entry) => entry.status === "unused",
      ),
    );
    assert.deepEqual(await runInstalledSdk(host), unusedIgnoreRun.report);

    host.replaceText(
      reviewPath,
      'const product = getCachedProduct("legacy");',
      'const product = getProduct("legacy"); const repeatedProduct = getProduct("legacy"); if (product.price <= 0 || repeatedProduct.price <= 0) { invoke(product); }',
    );
    const ambiguousIgnoreRun = await host.check({ config: configPath });
    assert.equal(ambiguousIgnoreRun.status, 1, ambiguousIgnoreRun.stderr);
    assert.equal(
      ambiguousIgnoreRun.report.diagnostics.filter(
        (diagnostic) =>
          diagnostic.ruleId === "neutral-product-review" &&
          diagnostic.at.file === "packages/app/src/review.ts" &&
          diagnostic.at.line === suppressedLine,
      ).length,
      2,
    );
    assert.ok(
      ambiguousIgnoreRun.report.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === INLINE_IGNORE_RULE_ID,
      ),
    );
    assert.ok(
      ambiguousIgnoreRun.report.inlineIgnores?.some(
        (entry) => entry.status === "ambiguous",
      ),
    );
    assert.deepEqual(await runInstalledSdk(host), ambiguousIgnoreRun.report);

    host.writeText(reviewPath, reviewSource);
    const activeCall = "const product = getProduct(id);";
    assert.equal(reviewSource.split(activeCall).length - 1, 1);
    host.replaceText(
      reviewPath,
      activeCall,
      "const product = getCachedProduct(id);",
    );
    const revokedRun = await host.check({ config: configPath });
    assert.equal(revokedRun.status, 0, revokedRun.stderr);
    assert.equal(revokedRun.variant, "clean");
    assert.deepEqual(revokedRun.report.diagnostics, []);
    assert.deepEqual(await runInstalledSdk(host), revokedRun.report);

    const sourceFiles = new Set(
      result.report.projects.flatMap((project) => project.sourceFiles),
    );
    assert.ok(sourceFiles.has("packages/app/src/review.ts"));
    assert.ok(sourceFiles.has("packages/data/src/product.ts"));
    t.diagnostic(
      `Packed CLI ${cliArtifact.version}; engine SHA-256 ${host.audit.engineBinarySha256}; isolation ${result.isolation?.mode}`,
    );
  });
});
