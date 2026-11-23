import assert from "node:assert/strict";
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
import { dirname, join, relative, resolve, sep } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  installArtifactPackages,
  packWorkspaceArtifacts,
  runBareVeruleInHost,
  verifyHostArtifactResolution,
} from "@verule/acceptance";
import type { CheckReport, NormalizedVeruleConfig } from "@verule/sdk";

const adapterPackageName = "@verule/adapter-fixture";

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

function copyExportedPackage(packageName: string, destination: string): void {
  const source = resolveExportedPackageRoot(packageName);
  cpSync(source, destination, {
    recursive: true,
    filter: (sourcePath) => {
      const parts = relative(source, sourcePath).split(sep);
      return !parts.some((part) =>
        ["dist", "host-root", "node_modules", "test"].includes(part),
      );
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
      // Keep walking to the package's installed root.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find installed package above ${entryPath}`);
    }
    current = parent;
  }
}

async function runInstalledSdk(hostDir: string): Promise<CheckReport> {
  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
  const sdk: typeof import("@verule/sdk") = await import(
    pathToFileURL(sdkPath).href
  );
  const configFile = join(hostDir, "packages/app/verule.native.config.ts");
  const configModule = (await import(pathToFileURL(configFile).href)) as {
    readonly default: NormalizedVeruleConfig;
  };
  assert.deepEqual(configModule.default.adapterPackages, [adapterPackageName]);
  return sdk.runCheck({
    cwd: hostDir,
    adapterResolutionRoot: dirname(configFile),
    config: configModule.default,
  });
}

void test("loads an installed native adapter from a nested app config", async (t) => {
  const environmentDir = mkdtempSync(join(tmpdir(), "verule-native-host-"));
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
    assert.deepEqual(installation.directPackages, [
      "@verule/sdk",
      "@verule/cli",
      adapterPackageName,
    ]);

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      allowedStorePaths: [storeDir],
    });
    assert.equal(audit.engineBinarySha256, engineArtifact.binarySha256);

    const appRequire = createRequire(
      join(hostDir, "packages/app/package.json"),
    );
    const entryPath = realpathSync(
      appRequire.resolve(`${adapterPackageName}/verule-adapter`),
    );
    const packageRoot = findInstalledPackageRoot(entryPath);
    const packageManifest = JSON.parse(
      readFileSync(join(packageRoot, "package.json"), "utf8"),
    ) as {
      readonly name: string;
      readonly version: string;
      readonly verule: {
        readonly native: { readonly "linux-x64": string };
      };
    };
    assert.equal(packageManifest.name, adapterPackageName);
    assert.equal(packageManifest.version, adapterArtifact.version);
    const libraryPath = realpathSync(
      resolve(packageRoot, packageManifest.verule.native["linux-x64"]),
    );
    assert.ok(packageRoot.startsWith(hostDir));
    assert.ok(libraryPath.startsWith(hostDir));
    assert.ok(libraryPath.endsWith("libverule_test_adapter.so"));

    const result = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.native.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.isolation?.controlProbeBlocked, true);
    const envelope = JSON.parse(result.stdout) as CliEnvelope;
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    const nativeDiagnostic = envelope.data.diagnostics.find(
      (diagnostic) => diagnostic.ruleId === "native-fact",
    );
    assert.ok(nativeDiagnostic, JSON.stringify(envelope.data.diagnostics));
    assert.ok(
      nativeDiagnostic.message.includes("getProduct(id)") &&
        nativeDiagnostic.message.includes("host-installed-input"),
      nativeDiagnostic.message,
    );
    assert.ok(
      nativeDiagnostic.evidence.some(
        (item) =>
          item.message ===
            "Fixture adapter read this call from the active snapshot." &&
          item.at?.file === "packages/app/src/review.ts",
      ),
    );
    assert.equal(
      envelope.data.additionalInputs[0]?.file,
      "fixture.inputs.json",
    );
    assert.deepEqual(envelope.data.additionalInputs[0]?.sources, [
      { kind: "adapter", id: "third-party-fixture" },
    ]);
    assert.deepEqual(await runInstalledSdk(hostDir), envelope.data);

    const missingAdapter = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.missing-adapter.config.ts",
        "--output",
        "json",
      ],
      pnpmStoreDir: storeDir,
      env,
    });
    assert.notEqual(missingAdapter.status, 0);
    const missingAdapterOutput = `${missingAdapter.stdout}\n${missingAdapter.stderr}`;
    assert.ok(
      missingAdapterOutput.includes("@verule/acceptance-missing-adapter"),
      missingAdapterOutput,
    );
    assert.ok(
      missingAdapterOutput.includes(
        "Failed to load configured adapter package",
      ),
      missingAdapterOutput,
    );
    assert.match(
      missingAdapterOutput,
      /Cannot find module|Cannot find package/,
    );
    t.diagnostic(
      `Installed ${adapterArtifact.name}@${adapterArtifact.version}; native library ${libraryPath}; engine SHA-256 ${audit.engineBinarySha256}`,
    );
  } finally {
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
