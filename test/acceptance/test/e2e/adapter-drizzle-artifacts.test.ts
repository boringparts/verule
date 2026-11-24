import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, sep } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  type PreparedAcceptanceHost,
  withAcceptanceHost,
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

async function runInstalledSdk(host: PreparedAcceptanceHost): Promise<{
  readonly report: CheckReport;
  readonly facts: readonly DrizzleProjectionResult[];
}> {
  const sdk = await host.loadSdk();
  const configPath = host.resolvePath(configRelativePath);
  const config =
    await host.loadConfig<NormalizedVeruleConfig>(configRelativePath);
  const ruleModule = (await import(
    pathToFileURL(
      host.resolvePath("packages/app/src/drizzle-projection-rule.ts"),
    ).href
  )) as {
    readonly queriedDrizzleFacts: readonly DrizzleProjectionResult[];
  };
  assert.deepEqual(config.adapterPackages, [adapterPackageName]);
  const report = await sdk.runCheck({
    cwd: host.hostDir,
    adapterResolutionRoot: dirname(configPath),
    config,
  });
  return { report, facts: ruleModule.queriedDrizzleFacts };
}

void test("extracts Drizzle projections from the installed native package through SDK and CLI", async (t) => {
  await withAcceptanceHost(
    {
      overlay: "drizzle",
      additionalPackages: [adapterPackageName],
      verifyNativeAdapters: [adapterPackageName],
    },
    async (host) => {
      const adapterArtifact = host.artifact(adapterPackageName);
      const engineArtifact = host.artifact("@verule/engine");
      assert.ok(engineArtifact.binarySha256);
      assert.equal(host.audit.engineBinarySha256, engineArtifact.binarySha256);

      const hostRequire = createRequire(join(host.hostDir, "package.json"));
      const hostReal = realpathSync(host.hostDir) + sep;
      const adapterEntry = realpathSync(
        hostRequire.resolve(`${adapterPackageName}/verule-adapter`),
      );
      assert.ok(adapterEntry.startsWith(hostReal));

      const nativeLibrary = host.nativeLibraries[adapterPackageName];
      assert.ok(nativeLibrary);
      assert.equal(nativeLibrary.providerId, "drizzle");
      assert.ok(nativeLibrary.path.endsWith("libverule_adapter_drizzle.so"));

      const sdkResult = await runInstalledSdk(host);
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

      const cliResult = await host.check({ config: configRelativePath });
      assert.equal(cliResult.status, 1, cliResult.stderr + cliResult.stdout);
      assert.equal(cliResult.isolation?.controlProbeBlocked, true);
      assert.equal(cliResult.variant, "findings");
      assert.deepEqual(cliResult.report, sdkResult.report);
      assert.equal(cliResult.report.diagnostics.length, 3);
      assert.equal(
        cliResult.report.diagnostics.filter(
          (diagnostic) => diagnostic.ruleId === "drizzle-projection",
        ).length,
        3,
      );
      assert.ok(
        cliResult.report.diagnostics.some(
          (diagnostic) =>
            diagnostic.message.includes("dynamic=true") &&
            diagnostic.message.includes("gaps=dynamic-query-projection") &&
            diagnostic.evidence.some((item) =>
              item.at?.file.endsWith("drizzle-projections.ts"),
            ),
        ),
      );

      t.diagnostic(
        `Installed ${adapterArtifact.name}@${adapterArtifact.version}; native library ${nativeLibrary.path}; engine SHA-256 ${host.audit.engineBinarySha256}`,
      );
    },
  );
});
