import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  installArtifactsInHost,
  packWorkspaceArtifacts,
  prepareHostCheckout,
  restoreHostDependencies,
  runBareVeruleInHost,
  verifyHostArtifactResolution,
  type HostId,
} from "@verule/acceptance";
import { getEngineVersion } from "@verule/sdk";

type RealHostTarget = {
  readonly hostId: HostId;
  readonly sha: string;
  readonly scenario: string;
};

const REAL_HOST_TARGETS: readonly RealHostTarget[] = [
  {
    hostId: "vscode",
    sha: "fb6289d60e979ff544a2619b2f0d192c8cc30c0a",
    scenario: "vscode-accessible-view (after)",
  },
  {
    hostId: "vue",
    sha: "d18d6aa1b20dc57a8103c51ec4d61e8e53ed936d",
    scenario: "vue-reentrant-scheduler (after)",
  },
  {
    hostId: "openstatus",
    sha: "090709ad0a4c838215c321cf3d0cb76447cd4b5d",
    scenario: "openstatus-get-gate (fixed)",
  },
];

void test("installs packed Verule artifacts into VS Code, Vue, and OpenStatus out-of-repo checkouts and runs isolated bare verule", async () => {
  const expectedEngineVersion = await getEngineVersion();
  const bundle = await packWorkspaceArtifacts();

  try {
    const cliArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/cli",
    );
    assert.ok(cliArtifact, "Expected packed @verule/cli artifact");
    const engineArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/engine",
    );
    assert.ok(
      engineArtifact?.binarySha256,
      "Expected packed @verule/engine artifact with binary SHA-256",
    );

    const preparationFailures: unknown[] = [];
    const hostRecords: unknown[] = [];

    for (const target of REAL_HOST_TARGETS) {
      const checkout = await prepareHostCheckout({
        hostId: target.hostId,
        sha: target.sha,
      });
      if (checkout.status === "preparation-failed") {
        preparationFailures.push(checkout);
        continue;
      }

      try {
        const restored = await restoreHostDependencies(checkout);
        if (restored.status === "preparation-failed") {
          preparationFailures.push(restored);
          continue;
        }

        const installed = await installArtifactsInHost({
          hostId: target.hostId,
          sha: target.sha,
          checkoutDir: checkout.checkoutDir,
          artifacts: bundle.artifacts,
        });
        if (installed.status === "preparation-failed") {
          preparationFailures.push(installed);
          continue;
        }

        const hostManifest: unknown = JSON.parse(
          readFileSync(join(checkout.checkoutDir, "package.json"), "utf8"),
        );
        assert.ok(typeof hostManifest === "object" && hostManifest !== null);
        const devDeps =
          "devDependencies" in hostManifest &&
          typeof hostManifest.devDependencies === "object" &&
          hostManifest.devDependencies !== null
            ? hostManifest.devDependencies
            : {};
        assert.equal("@verule/cli" in devDeps, true);
        assert.equal("@verule/sdk" in devDeps, true);
        assert.equal("@verule/engine" in devDeps, false);

        const npmrcPath = join(checkout.checkoutDir, ".npmrc");
        if (existsSync(npmrcPath)) {
          assert.doesNotMatch(readFileSync(npmrcPath, "utf8"), /127\.0\.0\.1/u);
        }

        const audit = await verifyHostArtifactResolution({
          checkoutDir: checkout.checkoutDir,
          artifacts: bundle.artifacts,
        });

        const bareRun = await runBareVeruleInHost({
          checkoutDir: checkout.checkoutDir,
          args: [],
          isolated: true,
        });
        assert.equal(bareRun.status, 0, bareRun.stderr);
        assert.equal(bareRun.stderr, "");
        assert.equal(
          bareRun.stdout,
          `verule ${cliArtifact.version} (engine ${expectedEngineVersion})\n`,
        );
        assert.equal(bareRun.isolation?.controlProbeBlocked, true);

        const versionRun = await runBareVeruleInHost({
          checkoutDir: checkout.checkoutDir,
          args: ["--version"],
          isolated: true,
        });
        assert.equal(versionRun.status, 0, versionRun.stderr);
        assert.equal(versionRun.stderr, "");
        assert.equal(versionRun.stdout, `verule ${cliArtifact.version}\n`);
        assert.doesNotMatch(versionRun.stdout, /engine/iu);
        assert.equal(versionRun.isolation?.controlProbeBlocked, true);

        hostRecords.push({
          hostId: target.hostId,
          scenario: target.scenario,
          sha: target.sha,
          cliVersion: audit.cliVersion,
          engineVersion: expectedEngineVersion,
          cliPackagePath: audit.cliPackagePath,
          sdkResolvedPath: audit.sdkResolvedPath,
          engineModulePath: audit.engineModulePath,
          engineBinaryPath: audit.engineBinaryPath,
          engineBinarySha256: audit.engineBinarySha256,
          auditedSymlinkCount: audit.auditedSymlinkCount,
          workspaceSymlinkCount: audit.workspaceSymlinkCount,
          storeSymlinkCount: audit.storeSymlinkCount,
          isolationMode: bareRun.isolation?.mode,
          controlProbeBlocked: bareRun.isolation?.controlProbeBlocked,
        });
      } finally {
        checkout.cleanup();
        assert.equal(
          existsSync(checkout.checkoutDir),
          false,
          `Temporary host checkout was not removed: ${checkout.checkoutDir}`,
        );
      }
    }

    assert.deepEqual(
      preparationFailures,
      [],
      `Host preparation failures: ${JSON.stringify(preparationFailures, null, 2)}`,
    );
    assert.equal(hostRecords.length, REAL_HOST_TARGETS.length);

    console.info(
      JSON.stringify(
        {
          artifacts: bundle.artifacts.map((artifact) => ({
            name: artifact.name,
            version: artifact.version,
            size: artifact.size,
            sha256: artifact.sha256,
            binarySha256: artifact.binarySha256,
          })),
          hosts: hostRecords,
        },
        null,
        2,
      ),
    );
  } finally {
    bundle.dispose();
  }
});
