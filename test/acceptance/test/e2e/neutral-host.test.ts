import assert from "node:assert/strict";
import { test } from "node:test";

import { INLINE_IGNORE_RULE_ID } from "@boringparts/verule";
import type { CheckReport, VeruleConfig } from "@boringparts/verule";
import {
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "@verule/acceptance";
import { runTscTypecheck } from "@verule/test-hosts";

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
  const checkReport = await sdk.runCheck({ cwd: host.hostDir, config });
  const session = await sdk.openSession({ cwd: host.hostDir, config });
  try {
    const sessionReport = await session.check();
    assert.deepEqual(sessionReport, checkReport);
  } finally {
    await session.close();
  }
  return checkReport;
}

void test("runs the packed CLI on the neutral cross-package host", async (t) => {
  await withAcceptanceHost({}, async (host) => {
    const veruleArtifact = host.artifact("@boringparts/verule");
    const tssaeArtifact = host.artifact("tssae");
    assert.equal(veruleArtifact.version, "0.1.0");
    assert.notEqual(veruleArtifact.manifest.private, true);
    assert.deepEqual(veruleArtifact.manifest.bin, {
      verule: "./dist/cli.js",
    });
    assert.deepEqual(veruleArtifact.manifest.exports, {
      ".": {
        types: "./dist/index.d.ts",
        default: "./dist/index.js",
      },
    });
    assert.deepEqual(veruleArtifact.manifest.publishConfig, {
      access: "public",
    });
    assert.ok(tssaeArtifact.binarySha256);
    assert.equal(host.audit.cliVersion, veruleArtifact.version);
    assert.equal(host.audit.tssaeVersion, tssaeArtifact.version);
    assert.equal(host.audit.hasSourceConditionInExports, false);
    assert.equal(host.audit.engineBinarySha256, tssaeArtifact.binarySha256);
    assert.ok(host.audit.workspaceSymlinkCount > 0);

    const rootManifest = JSON.parse(host.readText("package.json")) as {
      readonly dependencies?: Record<string, string>;
      readonly devDependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(rootManifest.devDependencies ?? {}), [
      "@boringparts/verule",
    ]);
    assert.equal(rootManifest.dependencies, undefined);

    const appManifest = JSON.parse(
      host.readText("packages/app/package.json"),
    ) as {
      readonly dependencies?: Record<string, string>;
    };
    assert.deepEqual(Object.keys(appManifest.dependencies ?? {}).toSorted(), [
      "@boringparts/verule",
      "@verule/acceptance-host-data",
    ]);

    await runTscTypecheck(host.appDir, "tsconfig.json");

    const versionCmd = await host.runCli(["version"]);
    assert.equal(versionCmd.status, 0, versionCmd.stderr);
    assert.match(
      versionCmd.stdout,
      new RegExp(`^verule ${veruleArtifact.version} \\(engine .+\\)\\n$`, "u"),
    );
    const shortVersionCmd = await host.runCli(["--version"]);
    assert.equal(shortVersionCmd.status, 0, shortVersionCmd.stderr);
    assert.equal(shortVersionCmd.stdout, `verule ${veruleArtifact.version}\n`);

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
    const diag = result.report.diagnostics[0];
    assert.ok(diag, JSON.stringify(result.report.diagnostics));
    assert.equal(diag.at.file, "packages/app/src/review.ts");
    assert.equal(diag.at.line, 15);
    assert.equal(
      diag.message,
      "Review products loaded across the package boundary.",
    );
    assert.ok(
      diag.evidence.some(
        (item) =>
          item.kind === "source" &&
          item.at?.file === "packages/data/src/product.ts" &&
          item.at.line === 7 &&
          item.declaration === "findProduct",
      ),
      `Expected selected CallTargetInfo evidence from product.ts: ${JSON.stringify(diag.evidence)}`,
    );
    assert.ok(
      diag.evidence.some(
        (item) =>
          item.kind === "source" &&
          item.at?.file === "packages/app/src/review.ts" &&
          item.at.line === 16,
      ),
      `Expected selected price read / propagation evidence on review.ts:16: ${JSON.stringify(diag.evidence)}`,
    );
    assert.ok(
      diag.evidence.some(
        (item) =>
          item.kind === "note" &&
          item.at?.file === "packages/app/src/review.ts" &&
          item.at.line === 15 &&
          item.message ===
            "Business judgment: cross-package product lookups require price review.",
      ),
      `Expected custom business note on review.ts:15: ${JSON.stringify(diag.evidence)}`,
    );
    assert.equal(
      diag.evidence.some(
        (item) =>
          (item.at?.file === "packages/data/src/product.ts" &&
            item.at.line === 11) ||
          (item.at?.file === "packages/app/src/review.ts" &&
            [7, 25, 26, 35, 41, 42].includes(item.at.line)),
      ),
      false,
      `Unselected candidate evidence leaked into diagnostic: ${JSON.stringify(diag.evidence)}`,
    );
    assert.deepEqual(await runInstalledSdk(host), result.report);
    assert.ok(
      result.report.gaps.some(
        (gap) =>
          gap.kind === "dynamic-callee" &&
          gap.at?.file === "packages/app/src/review.ts",
      ),
    );

    const reportedCallTarget = findSourceTarget(reviewSource, "getProduct(id)");
    const reportedExplanation = await host.check({
      config: configPath,
      rule: "neutral-product-review",
      at: `${reviewPath}:${reportedCallTarget}`,
    });
    assert.equal(reportedExplanation.status, 1, reportedExplanation.stderr);
    assert.equal(reportedExplanation.report.explanation?.status, "reported");
    assert.ok(
      reportedExplanation.report.explanation?.checkpoints.some(
        (cp) => cp.name === "product-query-origin" && cp.outcome === "pass",
      ),
      JSON.stringify(reportedExplanation.report.explanation?.checkpoints),
    );
    assert.ok(
      reportedExplanation.report.explanation?.checkpoints.some(
        (cp) =>
          cp.name === "price-validation-reachability" && cp.outcome === "pass",
      ),
      JSON.stringify(reportedExplanation.report.explanation?.checkpoints),
    );

    const localCounterexampleTarget = findSourceTarget(
      reviewSource,
      "findProduct(id)",
    );
    const localCounterexampleExplanation = await host.check({
      config: configPath,
      rule: "neutral-product-review",
      at: `${reviewPath}:${localCounterexampleTarget}`,
    });
    assert.equal(
      localCounterexampleExplanation.status,
      1,
      localCounterexampleExplanation.stderr,
    );
    assert.equal(
      localCounterexampleExplanation.report.explanation?.status,
      "excluded_by_checkpoint",
    );
    assert.equal(
      localCounterexampleExplanation.report.explanation?.excludedByCheckpoint
        ?.name,
      "product-query-origin",
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
      `Packed Verule ${veruleArtifact.version}; engine SHA-256 ${host.audit.engineBinarySha256}; isolation ${result.isolation?.mode}`,
    );
  });
});
