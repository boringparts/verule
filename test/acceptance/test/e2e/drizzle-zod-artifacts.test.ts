import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import { withAcceptanceHost } from "@verule/acceptance";
import {
  ValidatorSchemaFieldsFact,
  type ValidatorSchemaFieldsFactValue,
  type ValidatorSchemaSubjectKind,
} from "@verule/adapter-drizzle";
import {
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
  type ValidatorInputFieldsFactValue,
  type ValidatorOutputFieldsFactValue,
  type ValidatorSubjectKind,
} from "@verule/adapter-zod";
import type { CheckReport, FactResult } from "@verule/sdk";

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
const projectionsRelPath = "packages/data/src/drizzle-projections.ts";
const schemaRelPath = "packages/data/src/drizzle-schema.ts";

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

void test("loads both installed native adapters from the neutral static host and keeps reports stable across CLI, watch, and shared sessions", async (t) => {
  await withAcceptanceHost(
    {
      overlay: "drizzle-zod",
      additionalPackages: [...adapterPackageNames, "@verule/rules-reference"],
      directPackages: directPackageNames,
      verifyNativeAdapters: [...adapterPackageNames],
    },
    async (host) => {
      for (const packageName of [
        ...adapterPackageNames,
        "@verule/rules-reference",
      ]) {
        const artifact = host.artifact(packageName);
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

      const engineArtifact = host.artifact("@verule/engine");
      assert.ok(engineArtifact.binarySha256);
      assert.equal(host.audit.engineBinarySha256, engineArtifact.binarySha256);
      const adapterLibraries = adapterPackageNames.map((packageName) => {
        const lib = host.nativeLibraries[packageName];
        assert.ok(lib);
        return lib;
      });

      const sdk = await host.loadSdk();
      const mainConfig = await host.loadConfig(mainConfigPath);
      assert.deepEqual(mainConfig.adapterPackages, adapterPackageNames);

      const coldInitial = await host.check({
        config: mainConfigPath,
        observe: "summary",
      });
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
      assert.ok(!appProject.sourceFiles.includes(projectionsRelPath));
      for (const providerId of ["drizzle", "zod"] as const) {
        assert.ok(
          (coldInitial.report.observation?.engineExtractions[providerId]
            ?.extractions ?? 0) > 0,
          `Expected an observed extraction from the ${providerId} provider.`,
        );
      }
      const sdkInitial = await sdk.runCheck({
        cwd: host.hostDir,
        adapterResolutionRoot: host.appDir,
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
            gap.at?.file === projectionsRelPath,
        ),
      );

      const watch = await host.startWatch({ config: mainConfigPath });
      const watchInitial = await watch.nextReport();
      assert.deepEqual(
        semanticReport(watchInitial),
        semanticReport(coldInitial.report),
      );

      const sharedSession = await host.startSession({ config: mainConfigPath });
      const sharedInitial = (await sharedSession.check()).report;
      assert.deepEqual(
        semanticReport(sharedInitial),
        semanticReport(coldInitial.report),
      );

      const explicitSession = await sdk.openSession({
        cwd: host.hostDir,
        adapterResolutionRoot: host.appDir,
        config: mainConfig,
      });
      try {
        assert.deepEqual(
          semanticReport(await explicitSession.check()),
          semanticReport(coldInitial.report),
        );

        const originalProjections = host.readText(projectionsRelPath);
        host.replaceText(
          projectionsRelPath,
          "      status: users.status,\n",
          "",
        );

        const sharedImmediate = (await sharedSession.check()).report;
        const explicitMissingUpdate = await explicitSession.update({
          changed: [projectionsRelPath],
        });
        assert.ok(
          explicitMissingUpdate.recomputation.invalidatedBy.includes(
            `changed:${projectionsRelPath}`,
          ),
        );
        const explicitMissing = await explicitSession.check();

        const coldMissing = await host.check({ config: mainConfigPath });
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
          cwd: host.hostDir,
          adapterResolutionRoot: host.appDir,
          config: mainConfig,
        });
        const watchMissing = await watch.nextReport();
        assert.ok(
          watchMissing.recomputation.invalidatedBy.includes(
            `changed:${projectionsRelPath}`,
          ),
          JSON.stringify(watchMissing.recomputation),
        );
        const sharedMissing = (await sharedSession.check()).report;
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
            (item) => item.at?.file === projectionsRelPath,
          ),
        );
        assert.ok(
          missingDiagnostic.evidence.some(
            (item) => item.at?.file === schemaRelPath,
          ),
        );
        assert.ok(
          missingDiagnostic.evidence.some(
            (item) => item.at?.file === "packages/app/src/row-projection.ts",
          ),
        );

        host.writeText(projectionsRelPath, originalProjections);
        await explicitSession.update({ changed: [projectionsRelPath] });
        const explicitRestored = await explicitSession.check();
        const coldRestored = await host.check({ config: mainConfigPath });
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
          cwd: host.hostDir,
          adapterResolutionRoot: host.appDir,
          config: mainConfig,
        });
        const watchRestored = await watch.nextReport();
        const sharedRestored = (await sharedSession.check()).report;
        for (const report of [sdkRestored, watchRestored, sharedRestored]) {
          assert.deepEqual(
            semanticReport(report),
            semanticReport(coldRestored.report),
          );
        }
        assert.equal(coldRestored.report.diagnostics.length, 0);

        host.replaceText(
          schemaRelPath,
          '  status: text("status").notNull(),\n',
          '  status: text("status").notNull(),\n  tenantId: integer("tenant_id").notNull(),\n',
        );

        const coldSchemaChanged = await host.check({ config: mainConfigPath });
        assert.equal(coldSchemaChanged.status, 1);
        assert.equal(coldSchemaChanged.report.diagnostics.length, 3);
        for (const diagnostic of coldSchemaChanged.report.diagnostics) {
          assert.ok(diagnostic.message.includes("tenantId"));
          assert.ok(
            diagnostic.evidence.some(
              (item) =>
                item.at?.file === schemaRelPath &&
                item.message.includes("tenantId"),
            ),
          );
        }
        const sdkSchemaChanged = await sdk.runCheck({
          cwd: host.hostDir,
          adapterResolutionRoot: host.appDir,
          config: mainConfig,
        });
        const watchSchemaChanged = await watch.nextReport();
        const sharedSchemaChanged = (await sharedSession.check()).report;
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
      } finally {
        await explicitSession.close();
        await sharedSession.close();
        await watch.close();
      }

      // Restore schemaRelPath before verifying argument-switching, nested relation, and rest-destructuring checks.
      host.replaceText(
        schemaRelPath,
        '  status: text("status").notNull(),\n  tenantId: integer("tenant_id").notNull(),\n',
        '  status: text("status").notNull(),\n',
      );
      const rowProjectionRelPath = "packages/app/src/row-projection.ts";
      const originalRowProjection = host.readText(rowProjectionRelPath);

      // 1. Passing missing-column `brief` to `strictUserSchema.parse` alerts at the validator call.
      host.replaceText(
        rowProjectionRelPath,
        "    defaulted: brief === undefined ? undefined : userSchema.parse(brief),\n",
        "    defaulted: brief === undefined ? undefined : strictUserSchema.parse(brief),\n",
      );
      const missingBriefCheck = await host.check({ config: mainConfigPath });
      assert.equal(missingBriefCheck.status, 1);
      assert.equal(missingBriefCheck.report.diagnostics.length, 1);
      const briefDiag = missingBriefCheck.report.diagnostics[0]!;
      assert.equal(briefDiag.at.file, rowProjectionRelPath);
      assert.match(briefDiag.message, /\bage\b/u);
      assert.ok(
        briefDiag.evidence.some((e) => e.at?.file === projectionsRelPath),
      );
      assert.ok(
        briefDiag.evidence.some((e) => e.at?.file === rowProjectionRelPath),
      );
      assert.ok(briefDiag.evidence.some((e) => e.at?.file === schemaRelPath));

      // 2. Switching the passed argument from `brief` to complete-fields `complete` retracts the alert.
      host.replaceText(
        rowProjectionRelPath,
        "    defaulted: brief === undefined ? undefined : strictUserSchema.parse(brief),\n",
        "    defaulted: complete === undefined ? undefined : strictUserSchema.parse(complete),\n",
      );
      const switchedCompleteCheck = await host.check({
        config: mainConfigPath,
      });
      assert.equal(switchedCompleteCheck.status, 0);
      assert.equal(switchedCompleteCheck.report.diagnostics.length, 0);
      host.writeText(rowProjectionRelPath, originalRowProjection);

      // 3. Omitting `slug: true` from relational query alerts only on `gateFieldsSchema.parse(restPage)`.
      host.replaceText(projectionsRelPath, "      slug: true,\n", "");
      const missingRestSlug = await host.check({ config: mainConfigPath });
      assert.equal(missingRestSlug.status, 1);
      assert.equal(missingRestSlug.report.diagnostics.length, 1);
      const restDiag = missingRestSlug.report.diagnostics[0]!;
      assert.equal(restDiag.at.file, rowProjectionRelPath);
      assert.match(restDiag.message, /\bslug\b/u);
      assert.ok(
        restDiag.evidence.some((e) => e.at?.file === projectionsRelPath),
      );
      assert.ok(
        restDiag.evidence.some((e) => e.at?.file === rowProjectionRelPath),
      );
      assert.ok(restDiag.evidence.some((e) => e.at?.file === schemaRelPath));
      host.replaceText(
        projectionsRelPath,
        "    columns: {\n      customDomain: true,\n",
        "    columns: {\n      slug: true,\n      customDomain: true,\n",
      );

      // 4. Restricting nested `workspace` columns alerts on `selectWorkspaceSchema.safeParse(pageRow.workspace)`.
      host.replaceText(
        projectionsRelPath,
        "      workspace: true,\n",
        "      workspace: { columns: { id: true } },\n",
      );
      const missingNestedWs = await host.check({ config: mainConfigPath });
      assert.equal(missingNestedWs.status, 1);
      assert.equal(missingNestedWs.report.diagnostics.length, 1);
      const nestedDiag = missingNestedWs.report.diagnostics[0]!;
      assert.equal(nestedDiag.at.file, rowProjectionRelPath);
      assert.match(nestedDiag.message, /\bslug\b/u);
      assert.ok(
        nestedDiag.evidence.some((e) => e.at?.file === projectionsRelPath),
      );
      assert.ok(
        nestedDiag.evidence.some((e) => e.at?.file === rowProjectionRelPath),
      );
      assert.ok(nestedDiag.evidence.some((e) => e.at?.file === schemaRelPath));
      host.replaceText(
        projectionsRelPath,
        "      workspace: { columns: { id: true } },\n",
        "      workspace: true,\n",
      );

      const multiConfig = await host.loadConfig(multiSourceConfigPath);
      const coldMultiple = await host.check({ config: multiSourceConfigPath });
      assert.equal(coldMultiple.status, 1);
      const multiDiagnostics = coldMultiple.report.diagnostics;
      assert.equal(
        multiDiagnostics.length,
        2,
        JSON.stringify(multiDiagnostics),
      );
      assert.equal(multiDiagnostics[0]!.at.file, multiDiagnostics[1]!.at.file);
      assert.equal(
        multiDiagnostics[0]!.at.start,
        multiDiagnostics[1]!.at.start,
      );
      assert.equal(multiDiagnostics[0]!.message, multiDiagnostics[1]!.message);
      assert.notEqual(multiDiagnostics[0]!.id, multiDiagnostics[1]!.id);
      const multiSourceStarts = multiDiagnostics.map((diagnostic) => {
        const source = diagnostic.evidence.find(
          (item) =>
            item.at?.file === projectionsRelPath &&
            item.message === "Drizzle .select() query",
        );
        assert.ok(source?.at);
        return source.at.start;
      });
      assert.notEqual(multiSourceStarts[0], multiSourceStarts[1]);

      const sdkMultiple = await sdk.runCheck({
        cwd: host.hostDir,
        adapterResolutionRoot: host.appDir,
        config: multiConfig,
      });
      assert.deepEqual(
        semanticReport(sdkMultiple),
        semanticReport(coldMultiple.report),
      );

      const multiWatch = await host.startWatch({
        config: multiSourceConfigPath,
      });
      try {
        const multiWatchReport = await multiWatch.nextReport();
        assert.deepEqual(
          semanticReport(multiWatchReport),
          semanticReport(coldMultiple.report),
        );
      } finally {
        await multiWatch.close();
      }

      const multiShared = await host.startSession({
        config: multiSourceConfigPath,
      });
      try {
        const multiSharedReport = (await multiShared.check()).report;
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
          ...adapterLibraries.map(
            (adapter) =>
              `${adapter.packageName} ${adapter.path} SHA-256 ${adapter.sha256}`,
          ),
          `Engine binary SHA-256 ${host.audit.engineBinarySha256}`,
        ].join("\n"),
      );

      // Dual-adapter drizzle-zod provenance, non-null column default override,
      // explicit refine (replace + callback), and local same-named function counterexample.
      const originalSchema = host.readText(schemaRelPath);
      const fakeSelectRelPath = "packages/app/src/fake-select.ts";
      try {
        host.writeText(
          schemaRelPath,
          [
            originalSchema,
            "",
            "export const refinedWorkspaceSchema = createSelectSchema(workspace, {",
            "  slug: (s) => s.optional(),",
            '  name: (s) => s.default("Workspace"),',
            "}).extend({",
            '  plan: z.string().default("enterprise"),',
            "});",
            "",
          ].join("\n"),
        );
        host.writeText(
          fakeSelectRelPath,
          [
            'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
            'import { z } from "zod";',
            "",
            'const localUsers = sqliteTable("local_users", {',
            '  id: integer("id").primaryKey(),',
            '  secret: text("secret").notNull(),',
            "});",
            "",
            "function createSelectSchema(_table: unknown) {",
            "  return z.object({ localOnly: z.string() });",
            "}",
            "export const fakeLocalSelectSchema = createSelectSchema(localUsers);",
            "",
          ].join("\n"),
        );

        let schemaFieldsFacts: readonly FactResult<
          ValidatorSchemaSubjectKind,
          ValidatorSchemaFieldsFactValue
        >[] = [];
        let zodInputFacts: readonly FactResult<
          ValidatorSubjectKind,
          ValidatorInputFieldsFactValue
        >[] = [];
        let zodOutputFacts: readonly FactResult<
          ValidatorSubjectKind,
          ValidatorOutputFieldsFactValue
        >[] = [];

        const inspectRule = sdk.defineRule({
          id: "inspect-dual-drizzle-zod",
          run: async (ctx) => {
            schemaFieldsFacts = await ctx.facts(ValidatorSchemaFieldsFact);
            zodInputFacts = await ctx.facts(ValidatorInputFieldsFact, {
              condition: { scope: "schemas" },
            });
            zodOutputFacts = await ctx.facts(ValidatorOutputFieldsFact, {
              condition: { scope: "schemas" },
            });
          },
        });

        const dualReport = await sdk.runCheck({
          cwd: host.hostDir,
          adapterResolutionRoot: host.appDir,
          config: {
            ...mainConfig,
            rules: [inspectRule],
          },
        });
        assert.equal(dualReport.status, "clean");

        // Local same-named createSelectSchema MUST NOT emit ValidatorSchemaFieldsFact or acquire Drizzle columns.
        assert.equal(
          schemaFieldsFacts.length,
          4,
          `Expected 4 real drizzle-zod calls (users, workspace, page, refinedWorkspaceSchema), got ${schemaFieldsFacts.length}`,
        );

        const fakeLocalIn = zodInputFacts.find(
          (f) => f.value.schemaName === "fakeLocalSelectSchema",
        );
        assert.ok(fakeLocalIn);
        assert.deepEqual(fakeLocalIn.value.requiredFields, []);
        assert.equal(fakeLocalIn.value.hasDynamicFields, true);
        assert.ok(fakeLocalIn.gaps.some((g) => g.kind === "unresolved-schema"));

        const refinedIn = zodInputFacts.find(
          (f) => f.value.schemaName === "refinedWorkspaceSchema",
        );
        const refinedOut = zodOutputFacts.find(
          (f) => f.value.schemaName === "refinedWorkspaceSchema",
        );
        assert.ok(refinedIn && refinedOut);
        assert.deepEqual(refinedIn.value.requiredFields, ["id"]);
        assert.deepEqual(refinedIn.value.defaultedFields, ["name", "plan"]);
        assert.deepEqual(refinedIn.value.optionalFields, [
          "name",
          "plan",
          "slug",
        ]);
        assert.equal(refinedIn.value.fields.name?.nullable, true);
        assert.equal(refinedIn.value.fields.slug?.nullable, false);
        assert.deepEqual(refinedOut.value.presentFields, [
          "id",
          "name",
          "plan",
        ]);
        assert.deepEqual(refinedOut.value.optionalFields, ["slug"]);

        // Non-null column `users.age` overridden by `.extend({ age: z.number().default(18) })`
        const userIn = zodInputFacts.find(
          (f) => f.value.schemaName === "userSchema",
        );
        const userOut = zodOutputFacts.find(
          (f) => f.value.schemaName === "userSchema",
        );
        assert.ok(userIn && userOut);
        assert.deepEqual(userIn.value.requiredFields, [
          "fullName",
          "id",
          "status",
        ]);
        assert.deepEqual(userIn.value.defaultedFields, ["age"]);
        assert.deepEqual(userIn.value.optionalFields, ["age"]);
        assert.deepEqual(userOut.value.presentFields, [
          "age",
          "fullName",
          "id",
          "status",
        ]);
        assert.deepEqual(userOut.value.defaultedFields, ["age"]);
        // Evidence traces back to BOTH table column declaration (line 9) and .extend override (line 34)!
        assert.ok(
          userIn.evidence.some(
            (ev) => ev.at?.file === schemaRelPath && ev.at.line === 9,
          ),
        );
        assert.ok(
          userIn.evidence.some(
            (ev) => ev.at?.file === schemaRelPath && ev.at.line === 34,
          ),
        );
        assert.ok(
          userIn.value.fields.age?.evidence?.some(
            (ev) => ev.at?.file === schemaRelPath && ev.at.line === 34,
          ),
        );
      } finally {
        rmSync(host.resolvePath(fakeSelectRelPath), { force: true });
        host.writeText(schemaRelPath, originalSchema);
      }
    },
  );
});
