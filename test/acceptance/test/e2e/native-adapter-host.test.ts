import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import type { CheckReport } from "@boringparts/verule";
import {
  buildFixtureAdapterArtifacts,
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "@verule/acceptance";

const adapterPackageName = "@acme/adapter-fixture";
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

void test("loads an out-of-repo Rust adapter from tssae-adapter-api crate in both standalone tssae and Verule CLI/SDK", async (t) => {
  const builtFixtures = await buildFixtureAdapterArtifacts();
  try {
    await withAcceptanceHost(
      {
        additionalPackages: ["@tssae/adapters"],
        extraArtifacts: [builtFixtures.fixtureArtifact],
        directPackages: [
          "@boringparts/verule",
          "tssae",
          "@tssae/adapters",
          adapterPackageName,
        ],
      },
      async (host) => {
        const adapterArtifact = host.artifact(adapterPackageName);
        const tssaeArtifact = host.artifact("tssae");
        host.artifact("@tssae/adapters");
        assert.ok(tssaeArtifact.binarySha256);
        assert.equal(host.audit.engineBinarySha256, tssaeArtifact.binarySha256);

        const adapterExports = adapterArtifact.manifest.exports as
          | Record<string, unknown>
          | undefined;
        assert.equal(
          adapterExports?.["./tssae-native"],
          "./dist/tssae-native.json",
        );
        assert.equal(
          adapterExports?.["./native/linux-x64"],
          "./dist/native/libtssae_test_adapter.so",
        );

        const nativeLibrary = host.verifyNativeAdapter(adapterPackageName, {
          expectedProviderId: "third-party-fixture",
          resolutionBaseDir: join(host.hostDir, "packages/app"),
        });
        assert.ok(nativeLibrary.path.endsWith("libtssae_test_adapter.so"));

        // Verify standalone Node caller directly importing host-installed `tssae`
        // loads the exact same external .so artifact and queries its custom facts.
        const tssaeMod = (await import(
          pathToFileURL(host.audit.tssaeResolvedPath).href
        )) as typeof import("tssae");
        const fixtureCallSourceFact = tssaeMod.defineFactType<
          "call",
          undefined,
          {
            readonly text: string;
            readonly input: string;
            readonly invocation: number;
          }
        >({
          id: "fixture.call-source",
          subjectKind: "call",
        });
        const tssaeSession = await tssaeMod.openProject({
          cwd: host.hostDir,
          tsconfig: "packages/app/tsconfig.json",
          adapters: [adapterPackageName],
          adapterResolutionRoot: dirname(host.resolvePath(nativeConfigPath)),
          additionalInputs: ["fixture.inputs.json"],
        });
        try {
          assert.deepEqual(tssaeSession.nativeAdapters, [
            {
              packageName: adapterPackageName,
              providerId: "third-party-fixture",
              status: "loaded",
            },
          ]);
          const facts = await tssaeSession
            .project(tssaeSession.projects[0])
            .facts(fixtureCallSourceFact);
          const matching = facts.find(
            (fact) => fact.value.text === "getProduct(id)",
          );
          assert.ok(matching, JSON.stringify(facts));
          assert.ok(matching.value.input.includes("host-installed-input"));
        } finally {
          await tssaeSession.close();
        }

        // Verify Verule CLI & SDK load the exact same external .so artifact and report findings.
        const result = await host.check({
          config: nativeConfigPath,
          observe: "detail",
        });
        assert.equal(result.status, 1, result.stderr + result.stdout);
        assert.equal(result.isolation?.controlProbeBlocked, true);
        assert.equal(result.variant, "findings");
        assert.deepEqual(result.report.observation?.nativeAdapters, [
          {
            packageName: adapterPackageName,
            providerId: "third-party-fixture",
            status: "loaded",
          },
        ]);
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
        const sdkReport = await runInstalledSdk(host);
        assert.equal(sdkReport.status, result.report.status);
        assert.deepEqual(sdkReport.diagnostics, result.report.diagnostics);
        assert.deepEqual(
          sdkReport.additionalInputs,
          result.report.additionalInputs,
        );

        const appRequire = createRequire(
          join(host.hostDir, "packages/app/package.json"),
        );
        const zodLibrary = readFileSync(
          appRequire.resolve("@tssae/adapters/zod/native/linux-x64"),
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
          assert.match(mismatchEnvelope.data.message, /@acme\/adapter-fixture/);
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
  } finally {
    builtFixtures.dispose();
  }
});
