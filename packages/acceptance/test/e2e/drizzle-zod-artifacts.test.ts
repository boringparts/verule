import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
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
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  installArtifactPackages,
  packWorkspaceArtifacts,
  runBareVeruleInHost,
  verifyHostArtifactResolution,
} from "@verule/acceptance";
import type { PackedArtifact } from "@verule/acceptance";
import type {
  AnalysisSession,
  CheckReport,
  NormalizedVeruleConfig,
  WatchReportEvent,
} from "@verule/sdk";

import { copyAcceptanceHost } from "./support/host-fixtures.ts";

const adapterPackageNames = [
  "@verule/adapter-drizzle",
  "@verule/adapter-zod",
] as const;
const directPackageNames = [
  "@verule/sdk",
  "@verule/cli",
  ...adapterPackageNames,
  "@verule/rules-reference",
] as const;
const mainConfigPath = "packages/app/verule.drizzle-zod.native.config.ts";
const multiSourceConfigPath = "packages/app/verule.multiple-sources.config.ts";

type CliEnvelope = {
  readonly kind: string;
  readonly variant: string;
  readonly data: CheckReport;
};

type HostConfigModule = {
  readonly default: NormalizedVeruleConfig;
};

function createArtifactHost(environmentDir: string): {
  readonly hostDir: string;
  readonly appDir: string;
  readonly storeDir: string;
} {
  const hostDir = join(environmentDir, "host");
  const storeDir = join(environmentDir, "pnpm-store");

  mkdirSync(storeDir);
  const { appDir } = copyAcceptanceHost(hostDir, "drizzle-zod");

  return { hostDir, appDir, storeDir };
}

function findInstalledPackageRoot(
  entryPath: string,
  packageName: string,
): string {
  let current = dirname(entryPath);
  while (true) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(current, "package.json"), "utf8"),
      ) as { readonly name?: unknown };
      if (manifest.name === packageName) return current;
    } catch {
      // Keep walking until the installed package manifest is found.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw new Error(
        "Could not locate " + packageName + " above " + entryPath,
      );
    }
    current = parent;
  }
}

function semanticReport(report: CheckReport) {
  return {
    status: report.status,
    diagnostics: report.diagnostics.map((diagnostic) => ({
      id: diagnostic.id,
      ruleId: diagnostic.ruleId,
      at: diagnostic.at,
      message: diagnostic.message,
      evidence: diagnostic.evidence,
    })),
    gaps: report.gaps,
  };
}

async function runCliCheck(
  hostDir: string,
  storeDir: string,
  configPath: string,
  observe = false,
): Promise<{ readonly report: CheckReport; readonly status: number }> {
  const result = await runBareVeruleInHost({
    checkoutDir: hostDir,
    args: [
      "check",
      "--config",
      configPath,
      "--output",
      "json",
      ...(observe ? ["--observe", "summary"] : []),
    ],
    isolated: true,
    pnpmStoreDir: storeDir,
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  assert.equal(result.isolation?.controlProbeBlocked, true);
  const envelope = JSON.parse(result.stdout) as CliEnvelope;
  assert.equal(envelope.kind, "data");
  return { report: envelope.data, status: result.status };
}

async function readWatchEvent(
  iterator: AsyncIterator<unknown>,
): Promise<WatchReportEvent> {
  let timer: NodeJS.Timeout | undefined;
  const result = await Promise.race([
    iterator.next(),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for a watch report.")),
        90_000,
      );
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
  assert.equal(result.done, false);
  const event = result.value as {
    readonly kind: string;
    readonly report?: CheckReport;
  };
  assert.equal(event.kind, "report");
  assert.ok(event.report);
  return event as WatchReportEvent;
}

async function readWatchReport(
  iterator: AsyncIterator<unknown>,
): Promise<CheckReport> {
  return (await readWatchEvent(iterator)).report;
}

async function loadConfig(configPath: string): Promise<NormalizedVeruleConfig> {
  const module = (await import(
    pathToFileURL(configPath).href
  )) as HostConfigModule;
  return module.default;
}

async function loadInstalledSdk(
  hostDir: string,
): Promise<typeof import("@verule/sdk")> {
  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
  return (await import(
    pathToFileURL(sdkPath).href
  )) as typeof import("@verule/sdk");
}

function getInstalledNativeLibrary(
  hostDir: string,
  packageName: string,
  artifact: PackedArtifact,
): { readonly path: string; readonly sha256: string } {
  const hostRequire = createRequire(join(hostDir, "package.json"));
  const entryPath = realpathSync(
    hostRequire.resolve(packageName + "/verule-adapter"),
  );
  const packagePath = findInstalledPackageRoot(entryPath, packageName);
  const manifest = JSON.parse(
    readFileSync(join(packagePath, "package.json"), "utf8"),
  ) as {
    readonly verule?: {
      readonly native?: Readonly<Record<string, string>>;
    };
  };
  const relativeLibraryPath = manifest.verule?.native?.["linux-x64"];
  assert.ok(relativeLibraryPath);
  const libraryPath = realpathSync(join(packagePath, relativeLibraryPath));
  const archiveLibraryPath = relativeLibraryPath.replace(/^\.\//u, "");
  const packedBytes = execFileSync(
    "tar",
    ["-xOf", artifact.filename, "package/" + archiveLibraryPath],
    { encoding: "buffer" },
  );
  const installedSha256 = createHash("sha256")
    .update(readFileSync(libraryPath))
    .digest("hex");
  assert.equal(
    installedSha256,
    createHash("sha256").update(packedBytes).digest("hex"),
  );
  assert.ok(libraryPath.startsWith(realpathSync(hostDir) + sep));
  return { path: libraryPath, sha256: installedSha256 };
}

void test("loads both installed native adapters from the neutral static host and keeps reports stable across CLI, watch, and shared sessions", async (t) => {
  const environmentDir = mkdtempSync(
    join(tmpdir(), "verule-drizzle-zod-host-"),
  );
  const { hostDir, appDir, storeDir } = createArtifactHost(environmentDir);
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: [...adapterPackageNames, "@verule/rules-reference"],
  });
  let watchAbort: AbortController | undefined;
  let watchIterator: AsyncIterator<unknown> | undefined;
  let explicitSession: AnalysisSession | undefined;
  let sharedSession:
    | { readonly endpoint: string; close(): Promise<void> }
    | undefined;

  try {
    for (const packageName of [
      ...adapterPackageNames,
      "@verule/rules-reference",
    ]) {
      const artifact = bundle.artifacts.find(
        (candidate) => candidate.name === packageName,
      );
      assert.ok(artifact, "Expected packed artifact " + packageName);
      const exports = artifact.manifest.exports as
        | Record<string, Record<string, string>>
        | undefined;
      assert.equal(exports?.["."]?.default, "./dist/index.js");
      assert.equal(exports?.["."]?.types, "./dist/index.d.ts");
      assert.equal(exports?.["."]?.source, undefined);
      const dependencies = artifact.manifest.dependencies as
        | Record<string, string>
        | undefined;
      assert.equal(dependencies?.["@verule/engine"], undefined);
    }

    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      directPackages: directPackageNames,
      storeDir,
    });
    assert.equal(installation.status, "ready", JSON.stringify(installation));

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      directPackages: directPackageNames,
      allowedStorePaths: [storeDir],
    });
    const adapterArtifacts = adapterPackageNames.map((packageName) => {
      const artifact = bundle.artifacts.find(
        (candidate) => candidate.name === packageName,
      );
      assert.ok(artifact);
      return {
        packageName,
        ...getInstalledNativeLibrary(hostDir, packageName, artifact),
      };
    });
    const engineArtifact = bundle.artifacts.find(
      (candidate) => candidate.name === "@verule/engine",
    );
    assert.ok(engineArtifact?.binarySha256);
    assert.equal(audit.engineBinarySha256, engineArtifact.binarySha256);

    const sdk = await loadInstalledSdk(hostDir);
    const mainConfigAbsPath = join(hostDir, mainConfigPath);
    const mainConfig = await loadConfig(mainConfigAbsPath);
    assert.deepEqual(mainConfig.adapterPackages, adapterPackageNames);

    const coldInitial = await runCliCheck(
      hostDir,
      storeDir,
      mainConfigPath,
      true,
    );
    assert.equal(
      coldInitial.status,
      0,
      JSON.stringify(coldInitial.report, null, 2),
    );
    assert.equal(coldInitial.report.diagnostics.length, 0);
    const appProject = coldInitial.report.projects.find(
      (project) => project.configFile === "packages/app/tsconfig.json",
    );
    assert.ok(appProject);
    assert.ok(
      !appProject.sourceFiles.includes(
        "packages/data/src/drizzle-projections.ts",
      ),
    );
    for (const providerId of ["drizzle", "zod"] as const) {
      assert.ok(
        (coldInitial.report.observation?.engineExtractions[providerId]
          ?.extractions ?? 0) > 0,
        `Expected an observed extraction from the ${providerId} provider.`,
      );
    }
    const sdkInitial = await sdk.runCheck({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: mainConfig,
    });
    assert.deepEqual(
      semanticReport(sdkInitial),
      semanticReport(coldInitial.report),
    );
    assert.ok(
      coldInitial.report.gaps.some(
        (gap) =>
          gap.kind === "dynamic-query-projection" &&
          gap.at?.file === "packages/data/src/drizzle-projections.ts",
      ),
    );

    watchAbort = new AbortController();
    const watch = sdk.watchProject({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: mainConfig,
      debounceMs: 50,
      signal: watchAbort.signal,
    });
    watchIterator = watch[Symbol.asyncIterator]();
    const watchInitial = await readWatchReport(watchIterator);
    assert.deepEqual(
      semanticReport(watchInitial),
      semanticReport(coldInitial.report),
    );

    sharedSession = await sdk.startSharedSession({
      cwd: hostDir,
      endpoint: join(environmentDir, "shared.sock"),
      adapterResolutionRoot: appDir,
      config: mainConfig,
      debounceMs: 50,
    });
    const sharedInitial = await sdk.requestSharedReport({
      cwd: hostDir,
      endpoint: sharedSession.endpoint,
    });
    assert.deepEqual(
      semanticReport(sharedInitial),
      semanticReport(coldInitial.report),
    );
    explicitSession = await sdk.openSession({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: mainConfig,
    });
    assert.deepEqual(
      semanticReport(await explicitSession.check()),
      semanticReport(coldInitial.report),
    );

    const projectionsPath = join(
      hostDir,
      "packages/data/src/drizzle-projections.ts",
    );
    const originalProjections = readFileSync(projectionsPath, "utf8");
    const missingRequiredColumn = originalProjections.replace(
      "      status: users.status,\n",
      "",
    );
    assert.notEqual(missingRequiredColumn, originalProjections);
    writeFileSync(projectionsPath, missingRequiredColumn, "utf8");

    const sharedImmediate = await sdk.requestSharedReport({
      cwd: hostDir,
      endpoint: sharedSession.endpoint,
    });
    const explicitMissingUpdate = await explicitSession.update({
      changed: ["packages/data/src/drizzle-projections.ts"],
    });
    assert.ok(
      explicitMissingUpdate.recomputation.invalidatedBy.includes(
        "changed:packages/data/src/drizzle-projections.ts",
      ),
    );
    const explicitMissing = await explicitSession.check();

    const coldMissing = await runCliCheck(hostDir, storeDir, mainConfigPath);
    assert.equal(coldMissing.status, 1);
    assert.deepEqual(
      coldMissing.report.projects.find(
        (project) => project.configFile === "packages/app/tsconfig.json",
      )?.sourceFiles,
      appProject.sourceFiles,
    );
    assert.notEqual(
      coldMissing.report.identity.snapshotDigest,
      coldInitial.report.identity.snapshotDigest,
    );
    assert.equal(
      explicitMissing.identity.snapshotDigest,
      coldMissing.report.identity.snapshotDigest,
    );
    assert.deepEqual(
      semanticReport(sharedImmediate),
      semanticReport(coldMissing.report),
      "shared immediate",
    );
    assert.deepEqual(
      semanticReport(explicitMissing),
      semanticReport(coldMissing.report),
      "explicit update",
    );
    const sdkMissing = await sdk.runCheck({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: mainConfig,
    });
    const watchMissingEvent = await readWatchEvent(watchIterator);
    assert.ok(
      watchMissingEvent.recomputation.invalidatedBy.includes(
        "changed:packages/data/src/drizzle-projections.ts",
      ),
      JSON.stringify(watchMissingEvent.recomputation),
    );
    const watchMissing = watchMissingEvent.report;
    const sharedMissing = await sdk.requestSharedReport({
      cwd: hostDir,
      endpoint: sharedSession.endpoint,
    });
    assert.equal(
      watchMissing.identity.snapshotDigest,
      coldMissing.report.identity.snapshotDigest,
    );
    assert.equal(
      sharedMissing.identity.snapshotDigest,
      coldMissing.report.identity.snapshotDigest,
    );
    for (const [label, report] of [
      ["SDK", sdkMissing],
      ["watch", watchMissing],
      ["shared", sharedMissing],
    ] as const) {
      assert.deepEqual(
        semanticReport(report),
        semanticReport(coldMissing.report),
        label,
      );
    }

    assert.equal(coldMissing.report.diagnostics.length, 1);
    const missingDiagnostic = coldMissing.report.diagnostics[0]!;
    assert.equal(
      missingDiagnostic.ruleId,
      "row-projection-satisfies-validator",
    );
    assert.equal(
      missingDiagnostic.at.file,
      "packages/app/src/row-projection.ts",
    );
    assert.ok(missingDiagnostic.message.includes("status"));
    assert.ok(
      missingDiagnostic.evidence.some(
        (item) => item.at?.file === "packages/data/src/drizzle-projections.ts",
      ),
    );
    assert.ok(
      missingDiagnostic.evidence.some(
        (item) => item.at?.file === "packages/data/src/drizzle-schema.ts",
      ),
    );
    assert.ok(
      missingDiagnostic.evidence.some(
        (item) => item.at?.file === "packages/app/src/row-projection.ts",
      ),
    );

    writeFileSync(projectionsPath, originalProjections, "utf8");
    await explicitSession.update({
      changed: ["packages/data/src/drizzle-projections.ts"],
    });
    const explicitRestored = await explicitSession.check();
    const coldRestored = await runCliCheck(hostDir, storeDir, mainConfigPath);
    assert.equal(coldRestored.status, 0);
    assert.equal(
      coldRestored.report.identity.snapshotDigest,
      coldInitial.report.identity.snapshotDigest,
    );
    assert.equal(
      explicitRestored.identity.snapshotDigest,
      coldRestored.report.identity.snapshotDigest,
    );
    assert.deepEqual(
      semanticReport(explicitRestored),
      semanticReport(coldRestored.report),
      "explicit update after restore",
    );
    const sdkRestored = await sdk.runCheck({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: mainConfig,
    });
    const watchRestored = await readWatchReport(watchIterator);
    const sharedRestored = await sdk.requestSharedReport({
      cwd: hostDir,
      endpoint: sharedSession.endpoint,
    });
    for (const report of [sdkRestored, watchRestored, sharedRestored]) {
      assert.deepEqual(
        semanticReport(report),
        semanticReport(coldRestored.report),
      );
    }
    assert.equal(coldRestored.report.diagnostics.length, 0);

    const schemaPath = join(hostDir, "packages/data/src/drizzle-schema.ts");
    const originalSchema = readFileSync(schemaPath, "utf8");
    const schemaWithTenantId = originalSchema.replace(
      '  status: text("status").notNull(),\n',
      '  status: text("status").notNull(),\n  tenantId: integer("tenant_id").notNull(),\n',
    );
    assert.notEqual(schemaWithTenantId, originalSchema);
    writeFileSync(schemaPath, schemaWithTenantId, "utf8");

    const coldSchemaChanged = await runCliCheck(
      hostDir,
      storeDir,
      mainConfigPath,
    );
    assert.equal(coldSchemaChanged.status, 1);
    assert.equal(coldSchemaChanged.report.diagnostics.length, 3);
    for (const diagnostic of coldSchemaChanged.report.diagnostics) {
      assert.ok(diagnostic.message.includes("tenantId"));
      assert.ok(
        diagnostic.evidence.some(
          (item) =>
            item.at?.file === "packages/data/src/drizzle-schema.ts" &&
            item.message.includes("tenantId"),
        ),
      );
    }
    const sdkSchemaChanged = await sdk.runCheck({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: mainConfig,
    });
    const watchSchemaChanged = await readWatchReport(watchIterator);
    const sharedSchemaChanged = await sdk.requestSharedReport({
      cwd: hostDir,
      endpoint: sharedSession.endpoint,
    });
    for (const report of [
      sdkSchemaChanged,
      watchSchemaChanged,
      sharedSchemaChanged,
    ]) {
      assert.deepEqual(
        semanticReport(report),
        semanticReport(coldSchemaChanged.report),
      );
    }

    const multiConfig = await loadConfig(join(hostDir, multiSourceConfigPath));
    const coldMultiple = await runCliCheck(
      hostDir,
      storeDir,
      multiSourceConfigPath,
    );
    assert.equal(coldMultiple.status, 1);
    const multiDiagnostics = coldMultiple.report.diagnostics;
    assert.equal(multiDiagnostics.length, 2, JSON.stringify(multiDiagnostics));
    assert.equal(multiDiagnostics[0]!.at.file, multiDiagnostics[1]!.at.file);
    assert.equal(multiDiagnostics[0]!.at.start, multiDiagnostics[1]!.at.start);
    assert.equal(multiDiagnostics[0]!.message, multiDiagnostics[1]!.message);
    assert.notEqual(multiDiagnostics[0]!.id, multiDiagnostics[1]!.id);
    const multiSourceStarts = multiDiagnostics.map((diagnostic) => {
      const source = diagnostic.evidence.find(
        (item) =>
          item.at?.file === "packages/data/src/drizzle-projections.ts" &&
          item.message === "Drizzle .select() query",
      );
      assert.ok(source?.at);
      return source.at.start;
    });
    assert.notEqual(multiSourceStarts[0], multiSourceStarts[1]);

    const sdkMultiple = await sdk.runCheck({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: multiConfig,
    });
    assert.deepEqual(
      semanticReport(sdkMultiple),
      semanticReport(coldMultiple.report),
    );
    const multiWatchAbort = new AbortController();
    const multiWatch = sdk.watchProject({
      cwd: hostDir,
      adapterResolutionRoot: appDir,
      config: multiConfig,
      debounceMs: 50,
      signal: multiWatchAbort.signal,
    });
    const multiWatchIterator = multiWatch[Symbol.asyncIterator]();
    try {
      const multiWatchReport = await readWatchReport(multiWatchIterator);
      assert.deepEqual(
        semanticReport(multiWatchReport),
        semanticReport(coldMultiple.report),
      );
    } finally {
      multiWatchAbort.abort();
      await multiWatchIterator.return?.();
    }

    const multiShared = await sdk.startSharedSession({
      cwd: hostDir,
      endpoint: join(environmentDir, "multiple-sources.sock"),
      adapterResolutionRoot: appDir,
      config: multiConfig,
      debounceMs: 50,
    });
    try {
      const multiSharedReport = await sdk.requestSharedReport({
        cwd: hostDir,
        endpoint: multiShared.endpoint,
      });
      assert.deepEqual(
        semanticReport(multiSharedReport),
        semanticReport(coldMultiple.report),
      );
    } finally {
      await multiShared.close();
    }

    t.diagnostic(
      [
        "Installed native adapters:",
        ...adapterArtifacts.map(
          (adapter) =>
            adapter.packageName +
            " " +
            adapter.path +
            " SHA-256 " +
            adapter.sha256,
        ),
        "Engine binary SHA-256 " + audit.engineBinarySha256,
      ].join("\n"),
    );
  } finally {
    watchAbort?.abort();
    await watchIterator?.return?.();
    await explicitSession?.close();
    await sharedSession?.close();
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
