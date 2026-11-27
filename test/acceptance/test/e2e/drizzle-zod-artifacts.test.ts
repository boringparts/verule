import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { test } from "node:test";

import type { CheckReport } from "@boringparts/verule";
import {
  drizzleZodValidator,
  extractDrizzleZodSchemas,
  type DrizzleZodSchemaResult,
} from "@tssae/drizzle";
import type {
  ValidatorInputFieldsResult,
  ValidatorOutputFieldsResult,
} from "@tssae/zod";
import {
  copyAcceptanceHostMaterial,
  EXPECTED_ACCEPTANCE_NODE_VERSION,
  withAcceptanceHost,
} from "@verule/acceptance";
import { runTscTypecheck } from "@verule/test-hosts";

const packageNames = [
  "@tssae/drizzle",
  "@tssae/zod",
  "@verule/rules-reference",
] as const;
const directPackageNames = ["@boringparts/verule", ...packageNames] as const;
const mainConfigPath = "packages/app/verule.drizzle-zod.config.ts";
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

void test("loads @tssae/drizzle and @tssae/zod from the neutral static host and keeps reports stable across CLI, watch, and shared sessions", async (t) => {
  await withAcceptanceHost(
    {
      overlay: "drizzle-zod",
      additionalPackages: [...packageNames],
      directPackages: directPackageNames,
    },
    async (host) => {
      for (const pkgName of ["@tssae/drizzle", "@tssae/zod"] as const) {
        const pkgArtifact = host.artifact(pkgName);
        const pkgExports = pkgArtifact.manifest.exports as
          | Record<string, Record<string, string>>
          | undefined;
        assert.equal(pkgExports?.["."]?.default, "./dist/index.js");
        assert.equal(pkgExports?.["."]?.types, "./dist/index.d.ts");
        assert.equal(pkgExports?.["."]?.source, undefined);
      }
      const rulesArtifact = host.artifact("@verule/rules-reference");
      const rulesExports = rulesArtifact.manifest.exports as
        | Record<string, Record<string, string>>
        | undefined;
      assert.equal(rulesExports?.["."]?.default, "./dist/index.js");
      assert.equal(rulesExports?.["."]?.types, "./dist/index.d.ts");
      assert.equal(rulesExports?.["."]?.source, undefined);

      const tssaeArtifact = host.artifact("tssae");
      assert.ok(tssaeArtifact.binarySha256);
      assert.equal(host.audit.hasSourceConditionInExports, false);
      assert.equal(host.audit.engineBinarySha256, tssaeArtifact.binarySha256);

      const sdk = await host.loadSdk();
      const mainConfig = await host.loadConfig(mainConfigPath);

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
      assert.ok(coldInitial.report.observation);
      assert.ok(coldInitial.report.observation.lowering);
      assert.ok(coldInitial.report.observation.irCache);
      assert.ok(coldInitial.report.observation.summaryLookup);
      assert.ok(
        coldInitial.report.observation.queryCount > 0,
        JSON.stringify(coldInitial.report.observation),
      );
      const sdkInitial = await sdk.runCheck({
        cwd: host.hostDir,
        config: mainConfig,
      });
      assert.deepEqual(
        semanticReport(sdkInitial),
        semanticReport(coldInitial.report),
      );

      host.writeText(
        "node24-drizzle-zod-probe.ts",
        `import assert from "node:assert/strict";
import { runCheck } from "@boringparts/verule";
import { extractDrizzleZodSchemas } from "@tssae/drizzle";
import { zodValidator } from "@tssae/zod";
import config from "./packages/app/verule.drizzle-zod.config.ts";

assert.equal(process.versions.node, ${JSON.stringify(EXPECTED_ACCEPTANCE_NODE_VERSION)});
assert.equal(typeof extractDrizzleZodSchemas, "function");
assert.equal(typeof zodValidator.extractInputFields, "function");
const report = await runCheck({ cwd: process.cwd(), config });
process.stdout.write(
  JSON.stringify({ nodeVersion: process.versions.node, report }),
);
`,
      );
      const node24Probe = await host.runNode(["node24-drizzle-zod-probe.ts"]);
      assert.equal(node24Probe.status, 0, node24Probe.stderr);
      assert.equal(node24Probe.isolation?.controlProbeBlocked, true);
      const node24Payload = JSON.parse(node24Probe.stdout) as {
        readonly nodeVersion: string;
        readonly report: CheckReport;
      };
      assert.equal(node24Payload.nodeVersion, EXPECTED_ACCEPTANCE_NODE_VERSION);
      assert.deepEqual(
        semanticReport(node24Payload.report),
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
        `Engine binary SHA-256 ${host.audit.engineBinarySha256}; drizzle=${host.artifact("@tssae/drizzle").version}; zod=${host.artifact("@tssae/zod").version}`,
      );

      // drizzle-zod provenance, non-null column default override,
      // explicit refine (replace + callback), and local same-named function counterexample.
      const originalSchema = host.readText(schemaRelPath);
      const fakeSelectRelPath = "packages/app/src/fake-select.ts";
      try {
        copyAcceptanceHostMaterial(
          "drizzle-zod-data",
          "variants/refined/drizzle-schema.ts",
          host.resolvePath(schemaRelPath),
        );
        copyAcceptanceHostMaterial(
          "drizzle-zod-app",
          "variants/fake-select.ts",
          host.resolvePath(fakeSelectRelPath),
        );
        await runTscTypecheck(host.hostDir, "packages/app/tsconfig.json");
        await runTscTypecheck(host.hostDir, "packages/data/tsconfig.json");

        let schemaResults: readonly DrizzleZodSchemaResult[] = [];
        let zodInputResults: readonly ValidatorInputFieldsResult[] = [];
        let zodOutputResults: readonly ValidatorOutputFieldsResult[] = [];

        const inspectRule = sdk.defineRule({
          id: "inspect-dual-drizzle-zod",
          run: async (ctx) => {
            if (ctx.project.configFile === "packages/data/tsconfig.json") {
              schemaResults = await extractDrizzleZodSchemas(ctx, {
                refineFields: true,
              });
              zodInputResults = await drizzleZodValidator.extractInputFields(
                ctx,
                { scope: "schemas" },
              );
              zodOutputResults = await drizzleZodValidator.extractOutputFields(
                ctx,
                { scope: "schemas" },
              );
            } else {
              const appSchemas = await drizzleZodValidator.extractInputFields(
                ctx,
                { scope: "schemas" },
              );
              zodInputResults = [...zodInputResults, ...appSchemas];
            }
          },
        });

        const dualReport = await sdk.runCheck({
          cwd: host.hostDir,
          config: sdk.defineConfig({
            projects: [
              "packages/data/tsconfig.json",
              "packages/app/tsconfig.json",
            ],
            rules: [inspectRule],
          }),
        });
        assert.equal(dualReport.status, "clean");

        // Local same-named createSelectSchema MUST NOT emit DrizzleZodSchemaResult or acquire Drizzle columns.
        assert.equal(
          schemaResults.length,
          4,
          `Expected 4 real drizzle-zod calls (users, workspace, page, refinedWorkspaceSchema), got ${schemaResults.length}`,
        );

        const fakeLocalIn = zodInputResults.find(
          (f) => f.schemaName === "fakeLocalSelectSchema",
        );
        assert.ok(fakeLocalIn);
        assert.deepEqual(fakeLocalIn.requiredFields, []);
        assert.equal(fakeLocalIn.hasDynamicFields, true);
        assert.ok(fakeLocalIn.gaps.some((g) => g.kind === "unresolved-schema"));

        const refinedIn = zodInputResults.find(
          (f) => f.schemaName === "refinedWorkspaceSchema",
        );
        const refinedOut = zodOutputResults.find(
          (f) => f.schemaName === "refinedWorkspaceSchema",
        );
        assert.ok(refinedIn && refinedOut);
        assert.deepEqual(refinedIn.requiredFields, ["id"]);
        assert.deepEqual(refinedIn.defaultedFields, ["name", "plan"]);
        assert.deepEqual(refinedIn.optionalFields, ["name", "plan", "slug"]);
        assert.equal(refinedIn.fields.name?.nullable, true);
        assert.equal(refinedIn.fields.slug?.nullable, false);
        assert.deepEqual(refinedOut.presentFields, ["id", "name", "plan"]);
        assert.deepEqual(refinedOut.optionalFields, ["slug"]);

        // Non-null column `users.age` overridden by `.extend({ age: z.number().default(18) })`
        const userIn = zodInputResults.find(
          (f) => f.schemaName === "userSchema",
        );
        const userOut = zodOutputResults.find(
          (f) => f.schemaName === "userSchema",
        );
        assert.ok(userIn && userOut);
        assert.deepEqual(userIn.requiredFields, ["fullName", "id", "status"]);
        assert.deepEqual(userIn.defaultedFields, ["age"]);
        assert.deepEqual(userIn.optionalFields, ["age"]);
        assert.deepEqual(userOut.presentFields, [
          "age",
          "fullName",
          "id",
          "status",
        ]);
        assert.deepEqual(userOut.defaultedFields, ["age"]);
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
          userIn.fields.age?.evidence?.some(
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
