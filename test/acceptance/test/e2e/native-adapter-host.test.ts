import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import type { CheckReport } from "@boringparts/verule";
import {
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "@verule/acceptance";

const adapterPackageName = "@verule/adapter-fixture";
const nativeConfigPath = "packages/app/verule.native.config.ts";
const missingAdapterConfigPath =
  "packages/app/verule.missing-adapter.config.ts";

async function runInstalledSdk(
  host: PreparedAcceptanceHost,
): Promise<CheckReport> {
  const sdk = await host.loadSdk();
  const configFile = host.resolvePath(nativeConfigPath);
  const config = await host.loadConfig(nativeConfigPath);
  assert.deepEqual(config.adapterPackages, [adapterPackageName]);
  return sdk.runCheck({
    cwd: host.hostDir,
    adapterResolutionRoot: dirname(configFile),
    config,
  });
}

void test("loads an installed native adapter from a nested app config", async (t) => {
  await withAcceptanceHost(
    {
      additionalPackages: [adapterPackageName, "@verule/adapter-zod"],
    },
    async (host) => {
      const adapterArtifact = host.artifact(adapterPackageName);
      const engineArtifact = host.artifact("@verule/engine");
      host.artifact("@verule/adapter-zod");
      assert.ok(engineArtifact.binarySha256);
      assert.equal(host.audit.engineBinarySha256, engineArtifact.binarySha256);

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

      const nativeLibrary = host.verifyNativeAdapter(adapterPackageName, {
        expectedProviderId: "third-party-fixture",
        resolutionBaseDir: join(host.hostDir, "packages/app"),
      });
      assert.ok(nativeLibrary.path.endsWith("libverule_test_adapter.so"));

      const result = await host.check({ config: nativeConfigPath });
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.equal(result.isolation?.controlProbeBlocked, true);
      assert.equal(result.variant, "findings");
      const nativeDiagnostic = result.report.diagnostics.find(
        (diagnostic) => diagnostic.ruleId === "native-fact",
      );
      assert.ok(nativeDiagnostic, JSON.stringify(result.report.diagnostics));
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
        result.report.additionalInputs[0]?.file,
        "fixture.inputs.json",
      );
      assert.deepEqual(result.report.additionalInputs[0]?.sources, [
        { kind: "adapter", id: "third-party-fixture" },
      ]);
      assert.deepEqual(await runInstalledSdk(host), result.report);

      const appRequire = createRequire(
        join(host.hostDir, "packages/app/package.json"),
      );
      const zodLibrary = readFileSync(
        appRequire.resolve("@verule/adapter-zod/native/linux-x64"),
      );
      const originalLibrary = readFileSync(nativeLibrary.path);
      writeFileSync(nativeLibrary.path, zodLibrary);
      try {
        const mismatchedNativeAdapter = await host.runCli(
          ["check", "--config", nativeConfigPath, "--output", "json"],
          { isolated: false },
        );
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
        writeFileSync(nativeLibrary.path, originalLibrary);
      }

      const missingAdapter = await host.runCli(
        ["check", "--config", missingAdapterConfigPath, "--output", "json"],
        { isolated: false },
      );
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
        `Installed ${adapterArtifact.name}@${adapterArtifact.version}; native library ${nativeLibrary.path}; engine SHA-256 ${host.audit.engineBinarySha256}`,
      );
    },
  );
});
