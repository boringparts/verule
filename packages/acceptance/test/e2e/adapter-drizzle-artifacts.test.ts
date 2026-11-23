import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import type { QueryRowProjectionFactValue } from "@verule/adapter-drizzle";
import type {
  CheckReport,
  FactResult,
  NormalizedVeruleConfig,
} from "@verule/sdk";

const adapterPackageName = "@verule/adapter-drizzle";
const configRelativePath = "packages/app/verule.drizzle.native.config.ts";
type DrizzleProjectionResult = FactResult<
  "syntax" | "call" | "declaration",
  QueryRowProjectionFactValue
>;

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
  excludedParts: readonly string[] = [],
): void {
  const source = resolveExportedPackageRoot(packageName);
  const excluded = new Set([
    "dist",
    "host-root",
    "node_modules",
    "test",
    ...excludedParts,
  ]);
  cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const parts = relative(source, sourcePath).split(sep);
      return !parts.some((part) => excluded.has(part));
    },
  });
}

function findInstalledPackageRoot(entryPath: string): string {
  let current = dirname(entryPath);
  while (true) {
    const manifestPath = join(current, "package.json");
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        readonly name?: unknown;
      };
      if (manifest.name === adapterPackageName) return current;
    } catch {
      // Continue walking until the owning package manifest is found.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        `Could not find installed ${adapterPackageName} above ${entryPath}`,
      );
    }
    current = parent;
  }
}

async function runInstalledSdk(
  hostDir: string,
): Promise<{
  readonly report: CheckReport;
  readonly facts: readonly DrizzleProjectionResult[];
}> {
  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
  const sdk: typeof import("@verule/sdk") = await import(
    pathToFileURL(sdkPath).href
  );
  const configPath = join(hostDir, configRelativePath);
  const configModule = (await import(pathToFileURL(configPath).href)) as {
    readonly default: NormalizedVeruleConfig;
  };
  const ruleModule = (await import(
    pathToFileURL(join(hostDir, "packages/app/src/drizzle-projection-rule.ts"))
      .href
  )) as {
    readonly queriedDrizzleFacts: readonly DrizzleProjectionResult[];
  };
  assert.deepEqual(configModule.default.adapterPackages, [adapterPackageName]);
  const report = await sdk.runCheck({
    cwd: hostDir,
    adapterResolutionRoot: dirname(configPath),
    config: configModule.default,
  });
  return { report, facts: ruleModule.queriedDrizzleFacts };
}

void test("extracts Drizzle projections from the installed native package through SDK and CLI", async (t) => {
  const environmentDir = mkdtempSync(join(tmpdir(), "verule-drizzle-host-"));
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
    ["drizzle-overlay"],
  );

  const hostAppDir = join(hostDir, "packages/app");
  const hostDataDir = join(hostDir, "packages/data");
  const overlayDir = join(
    resolveExportedPackageRoot("@verule/acceptance-host-app"),
    "drizzle-overlay",
  );
  const appOverlayDir = join(overlayDir, "app");
  const dataOverlayDir = join(overlayDir, "data");
  cpSync(
    join(overlayDir, "host-root/pnpm-workspace.yaml"),
    join(hostDir, "pnpm-workspace.yaml"),
  );
  cpSync(
    join(overlayDir, "host-root/tsconfig.json"),
    join(hostDir, "tsconfig.json"),
  );
  cpSync(join(appOverlayDir, "package.json"), join(hostAppDir, "package.json"));
  cpSync(
    join(appOverlayDir, "tsconfig.json"),
    join(hostAppDir, "tsconfig.json"),
  );
  cpSync(
    join(appOverlayDir, "src/drizzle-projection-rule.ts"),
    join(hostAppDir, "src/drizzle-projection-rule.ts"),
  );
  cpSync(
    join(appOverlayDir, "verule.drizzle.native.config.ts"),
    join(hostAppDir, "verule.drizzle.native.config.ts"),
  );
  cpSync(
    join(dataOverlayDir, "package.json"),
    join(hostDataDir, "package.json"),
  );
  cpSync(
    join(dataOverlayDir, "tsconfig.json"),
    join(hostDataDir, "tsconfig.json"),
  );
  cpSync(
    join(dataOverlayDir, "src/drizzle-schema.ts"),
    join(hostDataDir, "src/drizzle-schema.ts"),
  );
  cpSync(
    join(dataOverlayDir, "src/drizzle-projections.ts"),
    join(hostDataDir, "src/drizzle-projections.ts"),
  );

  const env = process.env;
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: [adapterPackageName],
  });
  try {
    const adapterArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === adapterPackageName,
    );
    const engineArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/engine",
    );
    assert.ok(adapterArtifact);
    assert.ok(engineArtifact?.binarySha256);

    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      directPackages: ["@verule/sdk", "@verule/cli", adapterPackageName],
      storeDir,
      env,
    });
    assert.equal(installation.status, "ready", JSON.stringify(installation));

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      allowedStorePaths: [storeDir],
    });
    assert.equal(audit.engineBinarySha256, engineArtifact.binarySha256);

    const hostRequire = createRequire(join(hostDir, "package.json"));
    const hostReal = realpathSync(hostDir) + sep;
    const adapterEntry = realpathSync(
      hostRequire.resolve(`${adapterPackageName}/verule-adapter`),
    );
    assert.ok(adapterEntry.startsWith(hostReal));
    const packageRoot = findInstalledPackageRoot(adapterEntry);
    const packageManifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly verule: { readonly native: { readonly "linux-x64": string } };
    };
    const libraryPath = realpathSync(
      join(packageRoot, packageManifest.verule.native["linux-x64"]),
    );
    assert.ok(libraryPath.startsWith(hostReal));
    assert.ok(libraryPath.endsWith("libverule_adapter_drizzle.so"));
    const packedLibrary = execFileSync(
      "tar",
      [
        "-xOf",
        adapterArtifact.filename,
        "package/dist/native/libverule_adapter_drizzle.so",
      ],
      { encoding: "buffer" },
    );
    assert.equal(
      createHash("sha256").update(readFileSync(libraryPath)).digest("hex"),
      createHash("sha256").update(packedLibrary).digest("hex"),
    );

    const sdkResult = await runInstalledSdk(hostDir);
    assert.equal(sdkResult.report.status, "findings");
    assert.equal(
      sdkResult.facts.length,
      3,
      JSON.stringify(
        sdkResult.facts.map((fact) => ({
          kind: fact.value.queryKind,
          columns: fact.value.projectedColumns,
          dynamic: fact.value.hasDynamicColumns,
          gaps: fact.gaps.map((gap) => gap.kind),
          evidence: fact.evidence.map((item) => item.at?.file),
        })),
      ),
    );

    const explicit = sdkResult.facts.find((fact) =>
      fact.value.projectedColumns.includes("displayName"),
    );
    assert.ok(explicit);
    assert.deepEqual(explicit.value.projectedColumns, ["displayName", "id"]);
    assert.equal(explicit.value.columns.displayName?.sqlName, "full_name");
    assert.equal(explicit.value.hasDynamicColumns, false);
    assert.ok(
      explicit.value.columns.displayName?.evidence?.some(
        (item) =>
          item.message === 'Projected column "displayName"' &&
          item.at?.file.endsWith("drizzle-projections.ts"),
      ),
    );
    assert.ok(
      explicit.evidence.some((item) =>
        item.at?.file.endsWith("drizzle-schema.ts"),
      ),
    );

    const relational = sdkResult.facts.find(
      (fact) => fact.value.queryKind === "relational",
    );
    assert.ok(relational);
    assert.deepEqual(relational.value.projectedColumns, [
      "fullName",
      "id",
      "workspace",
    ]);
    assert.deepEqual(relational.value.relations.workspace?.columns, [
      "displayName",
      "id",
      "slug",
    ]);
    assert.ok(
      relational.evidence.some((item) =>
        item.at?.file.endsWith("drizzle-schema.ts"),
      ),
    );

    const dynamic = sdkResult.facts.find(
      (fact) => fact.value.hasDynamicColumns,
    );
    assert.ok(dynamic);
    assert.deepEqual(dynamic.value.projectedColumns, ["id"]);
    assert.ok(
      dynamic.gaps.some(
        (gap) =>
          gap.kind === "dynamic-query-projection" &&
          gap.at?.file.endsWith("drizzle-projections.ts"),
      ),
    );

    const cliResult = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: ["check", "--config", configRelativePath, "--output", "json"],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(cliResult.status, 1, cliResult.stderr + cliResult.stdout);
    assert.equal(cliResult.isolation?.controlProbeBlocked, true);
    const envelope = JSON.parse(cliResult.stdout) as CliEnvelope;
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    assert.deepEqual(envelope.data, sdkResult.report);
    assert.equal(envelope.data.diagnostics.length, 4);
    assert.equal(
      envelope.data.diagnostics.filter(
        (diagnostic) => diagnostic.ruleId === "drizzle-projection",
      ).length,
      3,
    );
    assert.ok(
      envelope.data.diagnostics.some(
        (diagnostic) =>
          diagnostic.message.includes("dynamic=true") &&
          diagnostic.message.includes("gaps=dynamic-query-projection") &&
          diagnostic.evidence.some((item) =>
            item.at?.file.endsWith("drizzle-projections.ts"),
          ),
      ),
    );

    t.diagnostic(
      `Installed ${adapterArtifact.name}@${adapterArtifact.version}; native library ${libraryPath}; engine SHA-256 ${audit.engineBinarySha256}`,
    );
  } finally {
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
