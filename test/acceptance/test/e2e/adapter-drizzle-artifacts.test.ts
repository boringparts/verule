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
import type {
  DrizzleTableColumnsFactValue,
  DrizzleTableSubjectKind,
  QueryRowProjectionFactValue,
} from "@verule/adapter-drizzle";
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
type DrizzleTableResult = FactResult<
  DrizzleTableSubjectKind,
  DrizzleTableColumnsFactValue
>;

async function runInstalledSdk(host: PreparedAcceptanceHost): Promise<{
  readonly report: CheckReport;
  readonly facts: readonly DrizzleProjectionResult[];
  readonly tableFacts: readonly DrizzleTableResult[];
  readonly targetedTableFacts: readonly DrizzleTableResult[];
  readonly targetedTableHandleId: string;
}> {
  const sdk = await host.loadSdk();
  const configPath = host.resolvePath(configRelativePath);
  const config =
    await host.loadConfig<NormalizedVeruleConfig>(configRelativePath);
  const projectionRuleModule = (await import(
    pathToFileURL(
      host.resolvePath("packages/app/src/drizzle-projection-rule.ts"),
    ).href
  )) as {
    readonly queriedDrizzleFacts: readonly DrizzleProjectionResult[];
  };
  const tableRuleModule = (await import(
    pathToFileURL(
      host.resolvePath("packages/app/src/drizzle-table-columns-rule.ts"),
    ).href
  )) as {
    readonly queriedDrizzleTableFacts: readonly DrizzleTableResult[];
    readonly queriedTargetedTableFacts: readonly DrizzleTableResult[];
    readonly queriedTargetedTableHandleId: string;
  };
  assert.deepEqual(config.adapterPackages, [adapterPackageName]);
  const report = await sdk.runCheck({
    cwd: host.hostDir,
    adapterResolutionRoot: dirname(configPath),
    config,
  });
  return {
    report,
    facts: projectionRuleModule.queriedDrizzleFacts,
    tableFacts: tableRuleModule.queriedDrizzleTableFacts,
    targetedTableFacts: tableRuleModule.queriedTargetedTableFacts,
    targetedTableHandleId: tableRuleModule.queriedTargetedTableHandleId,
  };
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
      assert.equal(host.nativeLibraries["@verule/adapter-zod"], undefined);

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

      assert.equal(sdkResult.tableFacts.length, 4);
      const accountsFact = sdkResult.tableFacts.find(
        (fact) => fact.value.tableName === "accounts",
      );
      assert.ok(accountsFact);
      assert.equal(accountsFact.value.sqlTableName, "accounts");
      assert.deepEqual(accountsFact.value.columnNames, [
        "createdAt",
        "displayName",
        "email",
        "id",
        "role",
      ]);
      assert.equal(accountsFact.value.columns.id?.primaryKey, true);
      assert.equal(accountsFact.value.columns.id?.nullable, false);
      assert.equal(accountsFact.value.columns.email?.nullable, false);
      assert.equal(accountsFact.value.columns.displayName?.nullable, true);
      assert.equal(accountsFact.value.columns.role?.nullable, false);
      assert.equal(accountsFact.value.columns.role?.hasDefault, true);
      assert.equal(accountsFact.value.columns.createdAt?.nullable, false);
      assert.equal(accountsFact.value.columns.createdAt?.hasDefault, true);
      assert.ok(
        accountsFact.evidence.some((item) =>
          item.at?.file.endsWith("drizzle-tables.ts"),
        ),
      );

      const dynamicTableFact = sdkResult.tableFacts.find(
        (fact) => fact.value.tableName === "dynamicAuditEvents",
      );
      assert.ok(dynamicTableFact);
      assert.equal(dynamicTableFact.value.hasDynamicColumns, true);
      assert.deepEqual(dynamicTableFact.value.columnNames, ["id"]);
      assert.equal(dynamicTableFact.gaps.length, 2);
      assert.ok(
        dynamicTableFact.gaps.every(
          (gap) =>
            gap.kind === "dynamic-table-columns" &&
            gap.at?.file.endsWith("drizzle-tables.ts"),
        ),
      );

      assert.equal(sdkResult.targetedTableFacts.length, 1);
      assert.ok(sdkResult.targetedTableHandleId.length > 0);
      assert.equal(
        sdkResult.targetedTableFacts[0]?.subject.handleId,
        sdkResult.targetedTableHandleId,
      );
      assert.equal(
        sdkResult.targetedTableFacts[0]?.value.tableName,
        "accounts",
      );
      assert.ok(
        sdkResult.targetedTableFacts[0]?.evidence.some((item) =>
          item.at?.file.endsWith("drizzle-tables.ts"),
        ),
      );

      const cliResult = await host.check({ config: configRelativePath });
      assert.equal(cliResult.status, 1, cliResult.stderr + cliResult.stdout);
      assert.equal(cliResult.isolation?.controlProbeBlocked, true);
      assert.equal(cliResult.variant, "findings");
      assert.deepEqual(cliResult.report, sdkResult.report);
      assert.equal(cliResult.report.diagnostics.length, 7);
      assert.equal(
        cliResult.report.diagnostics.filter(
          (diagnostic) => diagnostic.ruleId === "drizzle-projection",
        ).length,
        3,
      );
      assert.equal(
        cliResult.report.diagnostics.filter(
          (diagnostic) => diagnostic.ruleId === "drizzle-table-columns",
        ).length,
        4,
      );
      assert.ok(
        cliResult.report.diagnostics.some(
          (diagnostic) =>
            diagnostic.ruleId === "drizzle-table-columns" &&
            diagnostic.message.includes("table=accounts") &&
            diagnostic.message.includes("notNull=createdAt,email,id,role") &&
            diagnostic.message.includes("defaults=createdAt,role") &&
            diagnostic.evidence.some((item) =>
              item.at?.file.endsWith("drizzle-tables.ts"),
            ),
        ),
      );
      assert.ok(
        cliResult.report.diagnostics.some(
          (diagnostic) =>
            diagnostic.ruleId === "drizzle-table-columns" &&
            diagnostic.message.includes("table=dynamicAuditEvents") &&
            diagnostic.message.includes("dynamic=true") &&
            diagnostic.message.includes("gaps=dynamic-table-columns"),
        ),
      );
      assert.ok(
        cliResult.report.diagnostics.some(
          (diagnostic) =>
            diagnostic.ruleId === "drizzle-projection" &&
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
