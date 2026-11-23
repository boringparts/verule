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
import type {
  ValidatorInputFieldsFactValue,
  ValidatorOutputFieldsFactValue,
} from "@verule/adapter-zod";
import type { CheckReport, NormalizedVeruleConfig } from "@verule/sdk";

const adapterPackageName = "@verule/adapter-zod";

type CliEnvelope = {
  readonly kind: string;
  readonly variant: string;
  readonly data: CheckReport;
};

type ZodFactMessage = {
  readonly input: ValidatorInputFieldsFactValue;
  readonly output: ValidatorOutputFieldsFactValue;
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
    try {
      const manifestPath = join(current, "package.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        readonly name?: unknown;
      };
      if (manifest.name === adapterPackageName) return current;
    } catch {
      // Keep walking until the adapter package manifest is found.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(`Could not find installed package above ${entryPath}`);
    }
    current = parent;
  }
}

void test("installs the native Zod adapter and queries real schemas from a static host", async () => {
  const environmentDir = mkdtempSync(join(tmpdir(), "verule-zod-native-host-"));
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
    ["zod-overlay"],
  );

  const appDir = join(hostDir, "packages/app");
  const overlayDir = join(
    resolveExportedPackageRoot("@verule/acceptance-host-app"),
    "zod-overlay",
  );
  const appOverlayDir = join(overlayDir, "app");
  const dataOverlayDir = join(overlayDir, "data");
  cpSync(join(appOverlayDir, "package.json"), join(appDir, "package.json"));
  cpSync(join(appOverlayDir, "tsconfig.json"), join(appDir, "tsconfig.json"));
  cpSync(
    join(appOverlayDir, "src/zod-fields.ts"),
    join(appDir, "src/zod-fields.ts"),
  );
  cpSync(
    join(appOverlayDir, "verule.zod.native.config.ts"),
    join(appDir, "verule.zod.native.config.ts"),
  );
  cpSync(
    join(dataOverlayDir, "package.json"),
    join(hostDir, "packages/data/package.json"),
  );
  cpSync(
    join(dataOverlayDir, "tsconfig.json"),
    join(hostDir, "packages/data/tsconfig.json"),
  );
  cpSync(
    join(dataOverlayDir, "src/user-table.ts"),
    join(hostDir, "packages/data/src/user-table.ts"),
  );
  cpSync(
    join(dataOverlayDir, "src/index.ts"),
    join(hostDir, "packages/data/src/index.ts"),
  );
  cpSync(
    join(overlayDir, "host-root/tsconfig.json"),
    join(hostDir, "tsconfig.json"),
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

    const exports = adapterArtifact.manifest.exports as
      | Record<string, Record<string, string>>
      | undefined;
    assert.equal(exports?.["."]?.default, "./dist/index.js");
    assert.equal(exports?.["."]?.types, "./dist/index.d.ts");
    assert.equal(exports?.["."]?.source, undefined);
    assert.equal(
      exports?.["./verule-adapter"]?.default,
      "./dist/verule-adapter.js",
    );

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
      readonly verule: {
        readonly native: { readonly "linux-x64": string };
      };
    };
    assert.equal(packageManifest.name, adapterPackageName);
    const libraryPath = realpathSync(
      resolve(packageRoot, packageManifest.verule.native["linux-x64"]),
    );
    assert.ok(packageRoot.startsWith(hostDir));
    assert.ok(libraryPath.startsWith(hostDir));
    assert.ok(libraryPath.endsWith("libverule_adapter_zod.so"));

    const result = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.zod.native.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.isolation?.controlProbeBlocked, true);
    assert.notEqual(result.stdout.trim(), "", result.stderr);

    const envelope = JSON.parse(result.stdout) as CliEnvelope;
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    const zodDiagnostics = envelope.data.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "zod-native-facts",
    );
    assert.equal(zodDiagnostics.length, 2, JSON.stringify(zodDiagnostics));

    const parseFacts = zodDiagnostics.map((diagnostic) => ({
      diagnostic,
      facts: JSON.parse(diagnostic.message) as ZodFactMessage,
    }));
    const account = parseFacts.find(
      ({ facts }) => facts.input.schemaName === "accountSchema",
    );
    const user = parseFacts.find(
      ({ facts }) => facts.input.schemaName === "userSchema",
    );
    assert.ok(account, JSON.stringify(parseFacts));
    assert.ok(user, JSON.stringify(parseFacts));

    assert.equal(account.facts.input.validatorMethod, "safeParse");
    assert.deepEqual(account.facts.input.requiredFields, [
      "id",
      "nullableName",
    ]);
    assert.deepEqual(account.facts.input.optionalFields, [
      "fallback",
      "nickname",
      "state",
    ]);
    assert.deepEqual(account.facts.input.defaultedFields, [
      "fallback",
      "state",
    ]);
    assert.equal(account.facts.input.fields.nullableName?.nullable, true);
    assert.equal(account.facts.input.hasDynamicFields, true);
    assert.deepEqual(account.facts.output.presentFields, [
      "fallback",
      "id",
      "nullableName",
      "state",
    ]);
    assert.deepEqual(account.facts.output.optionalFields, ["nickname"]);
    assert.deepEqual(account.facts.output.defaultedFields, [
      "fallback",
      "state",
    ]);

    assert.equal(user.facts.input.validatorMethod, "parse");
    assert.deepEqual(user.facts.input.requiredFields, [
      "id",
      "name",
      "nickname",
    ]);
    assert.deepEqual(user.facts.input.defaultedFields, ["age"]);
    assert.deepEqual(user.facts.output.presentFields, [
      "age",
      "id",
      "name",
      "nickname",
    ]);
    assert.deepEqual(user.facts.output.defaultedFields, ["age"]);
    assert.ok(
      user.diagnostic.evidence.some(
        (item) => item.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );
    assert.ok(
      user.facts.input.fields.id?.evidence?.some(
        (item) => item.at?.file === "packages/data/src/user-table.ts",
      ),
    );
    assert.ok(
      user.facts.input.fields.id?.evidence?.some(
        (item) => item.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );

    assert.ok(
      envelope.data.gaps.some(
        (gap) =>
          gap.kind === "dynamic-schema-spread" &&
          gap.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );
    assert.ok(
      envelope.data.gaps.some(
        (gap) =>
          gap.kind === "dynamic-schema-field" &&
          gap.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );

    const hostRequire = createRequire(join(hostDir, "package.json"));
    const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
    const sdk: typeof import("@verule/sdk") = await import(
      pathToFileURL(sdkPath).href
    );
    const configPath = join(
      hostDir,
      "packages/app/verule.zod.native.config.ts",
    );
    const configModule = (await import(pathToFileURL(configPath).href)) as {
      readonly default: NormalizedVeruleConfig;
    };
    assert.deepEqual(configModule.default.adapterPackages, [
      adapterPackageName,
    ]);
    assert.deepEqual(
      await sdk.runCheck({
        cwd: hostDir,
        adapterResolutionRoot: dirname(configPath),
        config: configModule.default,
      }),
      envelope.data,
    );
  } finally {
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
