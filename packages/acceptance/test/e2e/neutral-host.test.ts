import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  installArtifactPackages,
  packWorkspaceArtifacts,
  runBareVeruleInHost,
  verifyHostArtifactResolution,
} from "@verule/acceptance";
import { INLINE_IGNORE_RULE_ID } from "@verule/sdk";
import type { CheckReport, VeruleConfig } from "@verule/sdk";

type CliEnvelope = {
  readonly kind: string;
  readonly variant: string;
  readonly data: CheckReport;
};

function resolveExportedPackageRoot(packageName: string): string {
  const manifestPath = fileURLToPath(
    import.meta.resolve(`${packageName}/package.json`),
  );
  return dirname(realpathSync(manifestPath));
}

function copyExportedPackage(
  packageName: string,
  destination: string,
  excludedFiles: readonly string[] = [],
): void {
  const source = resolveExportedPackageRoot(packageName);
  cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const parts = relative(source, sourcePath).split(sep);
      return !parts.some((part) =>
        [
          "dist",
          "host-root",
          "node_modules",
          "test",
          ...excludedFiles,
        ].includes(part),
      );
    },
  });
}

function findSourceTarget(source: string, token: string): string {
  const offset = source.indexOf(token);
  assert.notEqual(offset, -1, `Expected source to contain ${token}`);
  const preceding = source.slice(0, offset);
  const line = preceding.split("\n").length;
  const column = offset - preceding.lastIndexOf("\n");
  return `${line}:${column}`;
}

async function runInstalledSdk(hostDir: string): Promise<CheckReport> {
  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
  const sdk: typeof import("@verule/sdk") = await import(
    pathToFileURL(sdkPath).href
  );
  const configPath = pathToFileURL(
    join(hostDir, "packages/app/verule.config.ts"),
  ).href;
  const configModule = (await import(configPath)) as {
    readonly default: VeruleConfig;
  };
  assert.deepEqual(configModule.default.adapters, []);
  return sdk.runCheck({ cwd: hostDir, config: configModule.default });
}

void test("runs the packed CLI on the neutral cross-package host", async (t) => {
  const environmentDir = mkdtempSync(join(tmpdir(), "verule-neutral-host-"));
  const hostDir = join(environmentDir, "host");
  const storeDir = join(environmentDir, "pnpm-store");
  mkdirSync(join(hostDir, "packages"), { recursive: true });
  mkdirSync(storeDir);

  const hostRootTemplate = dirname(
    fileURLToPath(
      import.meta.resolve("@verule/acceptance-host-app/host-root/package.json"),
    ),
  );
  cpSync(hostRootTemplate, hostDir, { recursive: true });
  copyExportedPackage(
    "@verule/acceptance-host-data",
    join(hostDir, "packages/data"),
  );
  copyExportedPackage(
    "@verule/acceptance-host-app",
    join(hostDir, "packages/app"),
  );

  const env = process.env;
  const bundle = await packWorkspaceArtifacts();

  try {
    const cliArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/cli",
    );
    const engineArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/engine",
    );
    assert.ok(cliArtifact);
    assert.ok(engineArtifact?.binarySha256);

    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      storeDir,
      env,
    });
    assert.equal(installation.status, "ready", JSON.stringify(installation));

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      allowedStorePaths: [storeDir],
    });
    assert.equal(audit.cliVersion, cliArtifact.version);
    assert.equal(audit.engineBinarySha256, engineArtifact.binarySha256);
    assert.ok(audit.workspaceSymlinkCount > 0);

    const result = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(result.status, 1, result.stderr);
    assert.equal(result.isolation?.controlProbeBlocked, true);
    const envelope = JSON.parse(result.stdout) as CliEnvelope;
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    assert.equal(envelope.data.diagnostics.length, 1);
    assert.equal(envelope.data.diagnostics[0]?.ruleId, "neutral-member-review");
    assert.equal(
      envelope.data.diagnostics[0]?.at.file,
      "packages/app/src/review.ts",
    );
    assert.ok(
      envelope.data.diagnostics[0]?.evidence.some(
        (item) => item.at?.file === "packages/data/src/member.ts",
      ),
    );
    assert.deepEqual(await runInstalledSdk(hostDir), envelope.data);
    assert.ok(
      envelope.data.gaps.some(
        (gap) =>
          gap.kind === "dynamic-callee" &&
          gap.at?.file === "packages/app/src/review.ts",
      ),
    );

    const cachePath = join(hostDir, "packages/app/src/cache.ts");
    const cacheSource = readFileSync(cachePath, "utf8");
    const cachedCall = findSourceTarget(cacheSource, "getCachedMember(id)");
    const explanationRun = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.config.ts",
        "--rule",
        "neutral-member-review",
        "--at",
        `packages/app/src/cache.ts:${cachedCall}`,
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(explanationRun.status, 1, explanationRun.stderr);
    const explanationEnvelope = JSON.parse(
      explanationRun.stdout,
    ) as CliEnvelope;
    assert.equal(
      explanationEnvelope.data.explanation?.status,
      "not_in_candidates",
    );
    assert.equal(
      explanationEnvelope.data.explanation?.excludedByQuery?.op,
      "findSyntax",
    );
    const reviewPath = join(hostDir, "packages/app/src/review.ts");
    const reviewSource = readFileSync(reviewPath, "utf8");
    const suppressedCall = findSourceTarget(
      reviewSource,
      'getMember("legacy")',
    );
    const suppressedLine = Number(suppressedCall.split(":")[0]);
    const suppressedExplanation = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.config.ts",
        "--rule",
        "neutral-member-review",
        "--at",
        `packages/app/src/review.ts:${suppressedCall}`,
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(
      suppressedExplanation.status,
      1,
      suppressedExplanation.stderr + suppressedExplanation.stdout,
    );
    const suppressedEnvelope = JSON.parse(
      suppressedExplanation.stdout,
    ) as CliEnvelope;
    assert.equal(
      suppressedEnvelope.data.explanation?.status,
      "suppressed_by_ignore",
    );
    assert.equal(
      suppressedEnvelope.data.explanation?.inlineIgnore?.reason,
      "Keep this legacy lookup covered during migration.",
    );
    assert.ok(
      envelope.data.inlineIgnores?.some(
        (entry) =>
          entry.status === "suppressed" &&
          entry.ruleId === "neutral-member-review" &&
          entry.reason === "Keep this legacy lookup covered during migration.",
      ),
    );

    writeFileSync(
      reviewPath,
      reviewSource.replace(
        'const member = getMember("legacy");',
        'const member = getCachedMember("legacy");',
      ),
      "utf8",
    );
    const unusedIgnoreRun = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(unusedIgnoreRun.status, 1, unusedIgnoreRun.stderr);
    const unusedIgnoreEnvelope = JSON.parse(
      unusedIgnoreRun.stdout,
    ) as CliEnvelope;
    assert.ok(
      unusedIgnoreEnvelope.data.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === INLINE_IGNORE_RULE_ID,
      ),
    );
    assert.ok(
      unusedIgnoreEnvelope.data.inlineIgnores?.some(
        (entry) => entry.status === "unused",
      ),
    );
    assert.deepEqual(await runInstalledSdk(hostDir), unusedIgnoreEnvelope.data);

    const unusedSource = readFileSync(reviewPath, "utf8");
    writeFileSync(
      reviewPath,
      unusedSource.replace(
        'const member = getCachedMember("legacy");',
        'const member = getMember("legacy"); const repeated = getMember("legacy");',
      ),
      "utf8",
    );
    const ambiguousIgnoreRun = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(ambiguousIgnoreRun.status, 1, ambiguousIgnoreRun.stderr);
    const ambiguousIgnoreEnvelope = JSON.parse(
      ambiguousIgnoreRun.stdout,
    ) as CliEnvelope;
    assert.equal(
      ambiguousIgnoreEnvelope.data.diagnostics.filter(
        (diagnostic) =>
          diagnostic.ruleId === "neutral-member-review" &&
          diagnostic.at.file === "packages/app/src/review.ts" &&
          diagnostic.at.line === suppressedLine,
      ).length,
      2,
    );
    assert.ok(
      ambiguousIgnoreEnvelope.data.diagnostics.some(
        (diagnostic) => diagnostic.ruleId === INLINE_IGNORE_RULE_ID,
      ),
    );
    assert.ok(
      ambiguousIgnoreEnvelope.data.inlineIgnores?.some(
        (entry) => entry.status === "ambiguous",
      ),
    );
    assert.deepEqual(
      await runInstalledSdk(hostDir),
      ambiguousIgnoreEnvelope.data,
    );

    writeFileSync(reviewPath, reviewSource, "utf8");
    const activeCall = "const member = getMember(id);";
    assert.equal(reviewSource.split(activeCall).length - 1, 1);
    writeFileSync(
      reviewPath,
      reviewSource.replace(activeCall, "const member = getCachedMember(id);"),
      "utf8",
    );
    const revokedRun = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(revokedRun.status, 0, revokedRun.stderr);
    const revokedEnvelope = JSON.parse(revokedRun.stdout) as CliEnvelope;
    assert.equal(revokedEnvelope.variant, "clean");
    assert.deepEqual(revokedEnvelope.data.diagnostics, []);
    assert.deepEqual(await runInstalledSdk(hostDir), revokedEnvelope.data);

    const sourceFiles = new Set(
      envelope.data.projects.flatMap((project) => project.sourceFiles),
    );
    assert.ok(sourceFiles.has("packages/app/src/review.ts"));
    assert.ok(sourceFiles.has("packages/data/src/member.ts"));
    t.diagnostic(
      `Packed CLI ${cliArtifact.version}; engine SHA-256 ${audit.engineBinarySha256}; isolation ${result.isolation?.mode}`,
    );
  } finally {
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
