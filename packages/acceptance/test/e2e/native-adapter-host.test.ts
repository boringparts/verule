import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  installArtifactPackages,
  packWorkspaceArtifacts,
  runBareVeruleInHost,
  verifyHostArtifactResolution,
} from "@verule/acceptance";
import type { CheckReport, NormalizedVeruleConfig } from "@verule/sdk";

import { copyAcceptanceHost } from "./support/host-fixtures.ts";

const adapterPackageName = "@verule/adapter-fixture";

type CliEnvelope = {
  readonly kind: string;
  readonly variant: string;
  readonly data: CheckReport;
};

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
  copyAcceptanceHost(hostDir);

  const env = process.env;
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: [adapterPackageName, "@verule/adapter-zod"],
  });
  try {
    const adapterArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === adapterPackageName,
    );
    const engineArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/engine",
    );
    const zodArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/adapter-zod",
    );
    assert.ok(adapterArtifact);
    assert.ok(engineArtifact?.binarySha256);
    assert.ok(zodArtifact);

    const adapterExports = adapterArtifact.manifest.exports as
      | Record<string, unknown>
      | undefined;
    assert.equal(
      adapterExports?.["./verule-native"],
      "./dist/verule-native.json",
    );
    assert.equal(
      adapterExports?.["./native/linux-x64"],
      "./dist/native/libverule_test_adapter.so",
    );

    const directPackages = [
      "@verule/sdk",
      "@verule/cli",
      adapterPackageName,
      "@verule/adapter-zod",
    ];
    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      directPackages,
      storeDir,
      env,
    });
    assert.equal(installation.status, "ready", JSON.stringify(installation));
    assert.deepEqual(installation.directPackages, [
      "@verule/sdk",
      "@verule/cli",
      adapterPackageName,
      "@verule/adapter-zod",
    ]);

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      directPackages,
      allowedStorePaths: [storeDir],
    });
    assert.equal(audit.engineBinarySha256, engineArtifact.binarySha256);

    const appRequire = createRequire(
      join(hostDir, "packages/app/package.json"),
    );
    const nativeDescriptorPath = appRequire.resolve(
      `${adapterPackageName}/verule-native`,
    );
    const nativeDescriptor = JSON.parse(
      readFileSync(nativeDescriptorPath, "utf8"),
    ) as { readonly id: string; readonly "linux-x64": string };
    assert.equal(nativeDescriptor.id, "third-party-fixture");
    assert.equal(nativeDescriptor["linux-x64"], "./native/linux-x64");
    const libraryPath = realpathSync(
      appRequire.resolve(`${adapterPackageName}/native/linux-x64`),
    );
    assert.ok(libraryPath.startsWith(realpathSync(hostDir)));
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

    const zodLibrary = execFileSync(
      "tar",
      [
        "-xOf",
        zodArtifact.filename,
        "package/dist/native/libverule_adapter_zod.so",
      ],
      { encoding: "buffer" },
    );
    const originalLibrary = readFileSync(libraryPath);
    writeFileSync(libraryPath, zodLibrary);
    try {
      const mismatchedNativeAdapter = await runBareVeruleInHost({
        checkoutDir: hostDir,
        args: [
          "check",
          "--config",
          "packages/app/verule.native.config.ts",
          "--output",
          "json",
        ],
        pnpmStoreDir: storeDir,
        env,
      });
      assert.notEqual(mismatchedNativeAdapter.status, 0);
      const mismatchEnvelope = JSON.parse(
        mismatchedNativeAdapter.stdout + mismatchedNativeAdapter.stderr,
      ) as {
        readonly data: { readonly message: string };
      };
      assert.match(mismatchEnvelope.data.message, /@verule\/adapter-fixture/);
      assert.match(mismatchEnvelope.data.message, /third-party-fixture/);
      assert.match(
        mismatchEnvelope.data.message,
        /manifest declares adapter id "zod"/,
      );
    } finally {
      writeFileSync(libraryPath, originalLibrary);
    }

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
