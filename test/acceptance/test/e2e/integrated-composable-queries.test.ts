import assert from "node:assert/strict";
import { dirname } from "node:path";
import { after, before, test } from "node:test";

import type { CheckReport } from "@boringparts/verule";
import {
  buildFixtureAdapterArtifacts,
  type BuiltFixtureAdapters,
  copyAcceptanceHostMaterial,
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "@verule/acceptance";
import { runTscTypecheck } from "@verule/test-hosts";

const drizzleZodConfigPath = "packages/app/verule.drizzle-zod.native.config.ts";
const integratedExplainConfigPath =
  "packages/app/verule.integrated-explain.config.ts";
const schemaRelPath = "packages/data/src/drizzle-schema.ts";
const projectionsRelPath = "packages/data/src/drizzle-projections.ts";
const dataIndexRelPath = "packages/data/src/index.ts";
const rowProjectionRelPath = "packages/app/src/row-projection.ts";

const providerSessionPackages = ["@tssae/adapters"] as const;
let builtFixtures: BuiltFixtureAdapters;

before(async () => {
  builtFixtures = await buildFixtureAdapterArtifacts();
});

after(() => {
  builtFixtures?.dispose();
});
const compositionConfigPath =
  "packages/app/provider-session-overlay/app/verule.provider-session.composition.config.ts";
const compositionSourceRelPath =
  "packages/app/provider-session-overlay/app/src/provider-session-source.ts";

function lineColOf(
  host: PreparedAcceptanceHost,
  relPath: string,
  needle: string,
): string {
  const text = host.readText(relPath);
  const offset = text.indexOf(needle);
  assert.notEqual(offset, -1, `Expected ${relPath} to contain "${needle}"`);
  const prefix = text.slice(0, offset);
  const line = prefix.split("\n").length;
  const column = offset - prefix.lastIndexOf("\n");
  return `${relPath}:${line}:${column}`;
}

function comparableReport(report: CheckReport) {
  return {
    status: report.status,
    snapshotDigest: report.identity.snapshotDigest,
    diagnostics: report.diagnostics.map((diagnostic) => ({
      ruleId: diagnostic.ruleId,
      at: diagnostic.at,
      message: diagnostic.message,
      evidence: diagnostic.evidence,
    })),
    gaps: report.gaps,
  };
}

function assertReportParity(
  watchReport: CheckReport,
  sharedReport: CheckReport,
  coldReport: CheckReport,
  label: string,
): void {
  const expected = comparableReport(coldReport);
  assert.deepEqual(
    comparableReport(watchReport),
    expected,
    `Watch report diverged from cold CLI check at "${label}"`,
  );
  assert.deepEqual(
    comparableReport(sharedReport),
    expected,
    `Shared session report diverged from cold CLI check at "${label}"`,
  );
}

void test("verifies drizzle-zod runtime field validator, independent column reporting, default override, skipped adapter, and targeted explain via installed CLI and SDK", async () => {
  await withAcceptanceHost(
    {
      overlay: "drizzle-zod",
      additionalPackages: ["@tssae/adapters", "@verule/rules-reference"],
      extraArtifacts: [builtFixtures.fixtureArtifact],
      directPackages: [
        "@boringparts/verule",
        "@tssae/adapters",
        "@acme/adapter-fixture",
        "@verule/rules-reference",
      ],
      verifyNativeAdapters: [
        "@tssae/adapters/drizzle",
        "@tssae/adapters/zod",
        "@acme/adapter-fixture",
      ],
    },
    async (host) => {
      copyAcceptanceHostMaterial(
        "drizzle-zod-app",
        "variants/integrated/verule.integrated-explain.config.ts",
        host.resolvePath(integratedExplainConfigPath),
      );

      // Case A: runtime-only field validator on static column `age` without subsequent override.
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-a/drizzle-projections.ts",
        host.resolvePath(projectionsRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-a/index.ts",
        host.resolvePath(dataIndexRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-a/drizzle-schema.ts",
        host.resolvePath(schemaRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-app",
        "variants/case-a/row-projection.ts",
        host.resolvePath(rowProjectionRelPath),
      );
      await runTscTypecheck(host.hostDir, "packages/app/tsconfig.json");
      await runTscTypecheck(host.hostDir, "packages/data/tsconfig.json");

      const runtimeValidatorLocation = lineColOf(
        host,
        schemaRelPath,
        "age: runtimeFieldValidator()",
      );
      const runtimeValidatorLine = Number(
        runtimeValidatorLocation.split(":")[1],
      );
      const onlyUnknownCallAt = lineColOf(
        host,
        rowProjectionRelPath,
        "runtimeAgeSchema.parse(missingOnlyAge)",
      );
      const missingStaticCallAt = lineColOf(
        host,
        rowProjectionRelPath,
        "runtimeAgeSchema.parse(missingStatusAndAge)",
      );

      // Case A normal CLI check: independent static column `status` reports normally,
      // `age` produces a positioned `unresolved-schema-field` gap, and no false violation is reported for `age`.
      const caseACheck = await host.check({
        config: integratedExplainConfigPath,
      });
      assert.equal(caseACheck.status, 1, caseACheck.stderr + caseACheck.stdout);
      assert.equal(
        caseACheck.report.diagnostics.length,
        1,
        JSON.stringify(caseACheck.report.diagnostics),
      );
      const statusDiag = caseACheck.report.diagnostics[0]!;
      assert.equal(statusDiag.ruleId, "row-projection-satisfies-validator");
      assert.equal(statusDiag.at.file, rowProjectionRelPath);
      assert.match(statusDiag.message, /\bstatus\b/u);
      assert.doesNotMatch(statusDiag.message, /\bage\b/u);
      assert.ok(
        statusDiag.evidence.some((ev) => ev.at?.file === projectionsRelPath),
      );
      assert.ok(
        statusDiag.evidence.some((ev) => ev.at?.file === schemaRelPath),
      );
      assert.ok(
        statusDiag.evidence.some((ev) => ev.at?.file === rowProjectionRelPath),
      );

      const runtimeGap = caseACheck.report.gaps.find(
        (gap) =>
          gap.kind === "unresolved-schema-field" &&
          gap.at?.file === schemaRelPath &&
          gap.at.line === runtimeValidatorLine,
      );
      assert.ok(runtimeGap, JSON.stringify(caseACheck.report.gaps));

      // Case A targeted CLI explain on call missing ONLY unknown `age`: blocked_by_gap + unresolved + skipped fixture adapter.
      const caseAOnlyUnknownJson = await host.check({
        config: integratedExplainConfigPath,
        rule: "row-projection-satisfies-validator",
        at: onlyUnknownCallAt,
      });
      assert.equal(caseAOnlyUnknownJson.status, 1);
      const onlyUnknownExp = caseAOnlyUnknownJson.report.explanation;
      assert.ok(onlyUnknownExp);
      assert.equal(onlyUnknownExp.status, "blocked_by_gap");
      assert.ok(
        onlyUnknownExp.gaps.some(
          (gap) =>
            gap.kind === "unresolved-schema-field" &&
            gap.at?.file === schemaRelPath &&
            gap.at.line === runtimeValidatorLine,
        ),
        JSON.stringify(onlyUnknownExp.gaps),
      );
      assert.ok(
        onlyUnknownExp.localGaps.some(
          (local) =>
            local.status === "unresolved" &&
            local.field === "age" &&
            local.gap.kind === "unresolved-schema-field" &&
            local.gap.at?.file === schemaRelPath &&
            local.gap.at.line === runtimeValidatorLine,
        ),
        JSON.stringify(onlyUnknownExp.localGaps),
      );
      assert.ok(
        onlyUnknownExp.providerEvaluations.some(
          (ev) =>
            ev.providerId === "third-party-fixture" && ev.status === "skipped",
        ),
        JSON.stringify(onlyUnknownExp.providerEvaluations),
      );

      // Case A targeted CLI explain (JSON + text) on call missing static `status` + unknown `age`.
      const caseAMissingStaticJson = await host.check({
        config: integratedExplainConfigPath,
        rule: "row-projection-satisfies-validator",
        at: missingStaticCallAt,
      });
      assert.equal(caseAMissingStaticJson.status, 1);
      assert.equal(
        caseAMissingStaticJson.report.explanation?.status,
        "reported",
      );
      assert.ok(
        caseAMissingStaticJson.report.explanation?.localGaps.some(
          (local) => local.status === "unresolved" && local.field === "age",
        ),
      );

      const caseAText = await host.runCli([
        "check",
        "--config",
        integratedExplainConfigPath,
        "--rule",
        "row-projection-satisfies-validator",
        "--at",
        onlyUnknownCallAt,
      ]);
      assert.equal(caseAText.status, 1, caseAText.stderr + caseAText.stdout);
      assert.match(caseAText.stdout, /blocked_by_gap/u);
      assert.match(caseAText.stdout, /gap \[unresolved-schema-field\]/u);
      assert.match(caseAText.stdout, /localGap \[unresolved\].*field=age/u);
      assert.match(
        caseAText.stdout,
        /provider \[skipped\] third-party-fixture/u,
      );

      // Case B: subsequent `.extend({ age: z.number().default(21) })` resolves the local unknown.
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-b/drizzle-schema.ts",
        host.resolvePath(schemaRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-app",
        "variants/case-b/row-projection.ts",
        host.resolvePath(rowProjectionRelPath),
      );

      const extendOverrideLine = Number(
        lineColOf(host, schemaRelPath, "age: z.number().default(21)").split(
          ":",
        )[1],
      );
      const overriddenCallAt = lineColOf(
        host,
        rowProjectionRelPath,
        "runtimeAgeSchema.parse(missingOnlyAge)",
      );

      // Normal CLI check: definite defaulted conclusion used, NO diagnostics, NO gap for `age`.
      const caseBCheck = await host.check({
        config: integratedExplainConfigPath,
      });
      assert.equal(caseBCheck.status, 0, caseBCheck.stderr + caseBCheck.stdout);
      assert.deepEqual(caseBCheck.report.diagnostics, []);
      assert.equal(
        caseBCheck.report.gaps.some(
          (gap) => gap.kind === "unresolved-schema-field",
        ),
        false,
        JSON.stringify(caseBCheck.report.gaps),
      );

      // Targeted CLI explain (JSON + text): resolved_by_override pinpoints BOTH runtimeValidator() and .extend/.default.
      const caseBExplainJson = await host.check({
        config: integratedExplainConfigPath,
        rule: "row-projection-satisfies-validator",
        at: overriddenCallAt,
      });
      assert.equal(caseBExplainJson.status, 0);
      assert.deepEqual(
        caseBExplainJson.report.diagnostics,
        caseBCheck.report.diagnostics,
      );
      assert.deepEqual(caseBExplainJson.report.gaps, caseBCheck.report.gaps);
      const overriddenExp = caseBExplainJson.report.explanation;
      assert.ok(overriddenExp);
      assert.equal(
        overriddenExp.gaps.some(
          (gap) =>
            gap.kind === "unresolved-schema-field" ||
            gap.at?.file === schemaRelPath,
        ),
        false,
        JSON.stringify(overriddenExp.gaps),
      );
      assert.equal(overriddenExp.localGaps.length, 1);
      const resolvedLocal = overriddenExp.localGaps[0]!;
      assert.equal(resolvedLocal.status, "resolved_by_override");
      assert.equal(resolvedLocal.factTypeId, "tssae.validator.schema-fields");
      assert.equal(resolvedLocal.providerId, "drizzle");
      assert.equal(resolvedLocal.field, "age");
      assert.equal(resolvedLocal.gap.kind, "unresolved-schema-field");
      assert.equal(resolvedLocal.gap.at?.file, schemaRelPath);
      assert.equal(resolvedLocal.gap.at?.line, runtimeValidatorLine);
      assert.equal(resolvedLocal.resolvedBy?.providerId, "zod");
      assert.equal(resolvedLocal.resolvedBy?.operation, ".extend()");
      assert.equal(resolvedLocal.resolvedBy?.at?.file, schemaRelPath);
      assert.equal(resolvedLocal.resolvedBy?.at?.line, extendOverrideLine);
      assert.ok(
        overriddenExp.providerEvaluations.some(
          (ev) =>
            ev.providerId === "third-party-fixture" && ev.status === "skipped",
        ),
      );

      const caseBExplainText = await host.runCli([
        "check",
        "--config",
        integratedExplainConfigPath,
        "--rule",
        "row-projection-satisfies-validator",
        "--at",
        overriddenCallAt,
      ]);
      assert.equal(
        caseBExplainText.status,
        0,
        caseBExplainText.stderr + caseBExplainText.stdout,
      );
      assert.match(
        caseBExplainText.stdout,
        /localGap \[resolved_by_override\] tssae\.validator\.schema-fields \(drizzle\) field=age/u,
      );
      assert.match(caseBExplainText.stdout, /resolved_by zod \(\.extend\(\):/u);
      assert.match(
        caseBExplainText.stdout,
        /provider \[skipped\] third-party-fixture/u,
      );

      // Same-snapshot SDK session.check() -> session.explain() parity check.
      const sdk = await host.loadSdk();
      const resolvedConfigPath = host.resolvePath(integratedExplainConfigPath);
      const config = await host.loadConfig(integratedExplainConfigPath);
      const session = await sdk.openSession({
        cwd: host.hostDir,
        adapterResolutionRoot: dirname(resolvedConfigPath),
        config,
      });
      try {
        const normalSessionCheck = await session.check();
        assert.deepEqual(
          comparableReport(normalSessionCheck),
          comparableReport(caseBCheck.report),
        );

        const sameSnapshotAtCheck = await session.check({
          at: overriddenCallAt,
        });
        assert.equal(
          sameSnapshotAtCheck.identity.snapshotDigest,
          normalSessionCheck.identity.snapshotDigest,
        );
        assert.deepEqual(
          comparableReport(sameSnapshotAtCheck),
          comparableReport(normalSessionCheck),
        );

        const sessionExplain = await session.explain({
          ruleId: "row-projection-satisfies-validator",
          at: overriddenCallAt,
        });
        assert.equal(
          sessionExplain.identity.snapshotDigest,
          normalSessionCheck.identity.snapshotDigest,
        );
        assert.equal(sessionExplain.explanation.ruleId, overriddenExp.ruleId);
        assert.deepEqual(
          sessionExplain.explanation.target,
          overriddenExp.target,
        );
        assert.equal(sessionExplain.explanation.status, overriddenExp.status);
        assert.equal(
          sessionExplain.explanation.inCandidates,
          overriddenExp.inCandidates,
        );
        assert.deepEqual(sessionExplain.explanation.gaps, overriddenExp.gaps);
        assert.deepEqual(
          sessionExplain.explanation.localGaps,
          overriddenExp.localGaps,
        );
        assert.deepEqual(
          sessionExplain.explanation.providers,
          overriddenExp.providers,
        );
        assert.deepEqual(
          sessionExplain.explanation.providerEvaluations.filter(
            (ev) => ev.status === "skipped",
          ),
          overriddenExp.providerEvaluations.filter(
            (ev) => ev.status === "skipped",
          ),
        );
      } finally {
        await session.close();
      }

      // Case C & D: sound input vs output semantics for field-modifier `.default(21)`, `.and(...)`, and `.pipe(...)` on `createSelectSchema`.
      const integratedOutputExplainConfigPath =
        "packages/app/verule.integrated-output-explain.config.ts";
      copyAcceptanceHostMaterial(
        "drizzle-zod-app",
        "variants/integrated/verule.integrated-output-explain.config.ts",
        host.resolvePath(integratedOutputExplainConfigPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-cd/index.ts",
        host.resolvePath(dataIndexRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-cd/drizzle-schema.ts",
        host.resolvePath(schemaRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-app",
        "variants/case-cd/row-projection.ts",
        host.resolvePath(rowProjectionRelPath),
      );
      await runTscTypecheck(host.hostDir, "packages/app/tsconfig.json");

      // Input rule check: andRequiredSchema reports missing `age`, while andDefaultedSchema and pipeOverriddenSchema keep unresolved gaps on `age`.
      const combinatorInputCheck = await host.check({
        config: integratedExplainConfigPath,
      });
      assert.equal(
        combinatorInputCheck.status,
        1,
        combinatorInputCheck.stderr + combinatorInputCheck.stdout,
      );
      assert.equal(combinatorInputCheck.report.diagnostics.length, 1);
      assert.match(
        combinatorInputCheck.report.diagnostics[0]!.message,
        /andRequiredSchema\.parse\(\).*required validator field "age"/u,
      );
      assert.ok(
        combinatorInputCheck.report.gaps.some(
          (gap) =>
            gap.kind === "unresolved-schema-field" &&
            gap.at?.file === schemaRelPath,
        ),
        JSON.stringify(combinatorInputCheck.report.gaps),
      );

      // Output rule check: ALL four schemas resolve `age` in presentFields with ZERO gaps!
      const combinatorOutputCheck = await host.check({
        config: integratedOutputExplainConfigPath,
      });
      assert.equal(
        combinatorOutputCheck.status,
        0,
        combinatorOutputCheck.stderr + combinatorOutputCheck.stdout,
      );
      assert.deepEqual(combinatorOutputCheck.report.diagnostics, []);
      assert.deepEqual(combinatorOutputCheck.report.gaps, []);

      // Verify targeted explain for input rule at each combinator call:
      for (const [
        needle,
        expectUnresolvedGap,
        expectedLocalStatus,
        expectedOp,
      ] of [
        [
          "modifierDefaultedSchema.parse(missingOnlyAge)",
          false,
          "resolved_by_override",
          ".default()",
        ],
        [
          "andDefaultedSchema.parse(missingOnlyAge)",
          true,
          "unresolved",
          undefined,
        ],
        [
          "andRequiredSchema.parse(missingOnlyAge)",
          false,
          "resolved_by_override",
          ".and()",
        ],
        [
          "pipeOverriddenSchema.parse(missingOnlyAge)",
          true,
          "unresolved",
          undefined,
        ],
      ] as const) {
        const callAt = lineColOf(host, rowProjectionRelPath, needle);
        const explained = await host.check({
          config: integratedExplainConfigPath,
          rule: "row-projection-satisfies-validator",
          at: callAt,
        });
        assert.equal(explained.status, 1);
        const exp = explained.report.explanation;
        assert.ok(exp);
        if (expectUnresolvedGap) {
          assert.equal(exp.status, "blocked_by_gap");
          assert.ok(
            exp.gaps.some(
              (g) =>
                g.kind === "unresolved-schema-field" &&
                g.at?.file === schemaRelPath,
            ),
            `Expected unresolved-schema-field gap for ${needle}: ${JSON.stringify(exp.gaps)}`,
          );
        } else {
          assert.equal(
            exp.gaps.some((g) => g.kind === "unresolved-schema-field"),
            false,
            `Unexpected unresolved-schema-field gap for ${needle}: ${JSON.stringify(exp.gaps)}`,
          );
          if (needle.startsWith("andRequiredSchema")) {
            assert.equal(exp.status, "reported");
          } else {
            assert.ok(
              exp.checkpoints.some(
                (cp) =>
                  cp.name === "row-projection-satisfied" &&
                  cp.outcome === "pass",
              ),
              `Expected row-projection-satisfied pass checkpoint for ${needle}: ${JSON.stringify(exp.checkpoints)}`,
            );
          }
        }
        assert.ok(
          exp.localGaps.some(
            (lg) =>
              lg.status === expectedLocalStatus &&
              lg.field === "age" &&
              (expectedOp === undefined ||
                (lg.resolvedBy?.providerId === "zod" &&
                  lg.resolvedBy.operation === expectedOp)),
          ),
          `Unexpected input localGaps for ${needle}: ${JSON.stringify(exp.localGaps)}`,
        );
      }

      // Verify targeted explain for output rule at each combinator call:
      for (const [needle, expectedOp] of [
        ["modifierDefaultedSchema.parse(missingOnlyAge)", ".default()"],
        ["andDefaultedSchema.parse(missingOnlyAge)", ".and()"],
        ["andRequiredSchema.parse(missingOnlyAge)", ".and()"],
        ["pipeOverriddenSchema.parse(missingOnlyAge)", ".pipe()"],
      ] as const) {
        const callAt = lineColOf(host, rowProjectionRelPath, needle);
        const explained = await host.check({
          config: integratedOutputExplainConfigPath,
          rule: "validator-output-fields-probe",
          at: callAt,
        });
        assert.equal(explained.status, 0);
        const exp = explained.report.explanation;
        assert.ok(exp);
        assert.deepEqual(exp.gaps, []);
        assert.ok(
          exp.localGaps.some(
            (lg) =>
              lg.status === "resolved_by_override" &&
              lg.field === "age" &&
              lg.resolvedBy?.providerId === "zod" &&
              lg.resolvedBy.operation === expectedOp,
          ),
          `Expected output resolved_by_override for ${needle}: ${JSON.stringify(exp.localGaps)}`,
        );
      }

      // Case E: `.extend({ age: runtimeFieldValidator() })` removes base `age` from `createSelectSchema(users)`
      // and chained `.extend({ age: z.number().default(21) })` resolves `age` via `resolved_by_override`.
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-e/index.ts",
        host.resolvePath(dataIndexRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-data",
        "variants/case-e/drizzle-schema.ts",
        host.resolvePath(schemaRelPath),
      );
      copyAcceptanceHostMaterial(
        "drizzle-zod-app",
        "variants/case-e/row-projection.ts",
        host.resolvePath(rowProjectionRelPath),
      );

      const extendRuntimeLine = Number(
        lineColOf(host, schemaRelPath, "age: runtimeFieldValidator()").split(
          ":",
        )[1],
      );
      const extendResolvedLine = Number(
        lineColOf(host, schemaRelPath, "age: z.number().default(21)").split(
          ":",
        )[1],
      );
      const extendUnknownCallAt = lineColOf(
        host,
        rowProjectionRelPath,
        "extendUnknownSchema.parse(missingOnlyAge)",
      );
      const extendResolvedCallAt = lineColOf(
        host,
        rowProjectionRelPath,
        "extendReResolvedSchema.parse(missingOnlyAge)",
      );

      const caseEInputCheck = await host.check({
        config: integratedExplainConfigPath,
      });
      assert.equal(
        caseEInputCheck.status,
        0,
        caseEInputCheck.stderr + caseEInputCheck.stdout,
      );
      assert.deepEqual(caseEInputCheck.report.diagnostics, []);
      assert.ok(
        caseEInputCheck.report.gaps.some(
          (g) =>
            g.kind === "unresolved-schema-field" &&
            g.at?.file === schemaRelPath &&
            g.at.line === extendRuntimeLine,
        ),
        JSON.stringify(caseEInputCheck.report.gaps),
      );

      const extendUnknownExplain = await host.check({
        config: integratedExplainConfigPath,
        rule: "row-projection-satisfies-validator",
        at: extendUnknownCallAt,
      });
      assert.equal(extendUnknownExplain.status, 0);
      assert.equal(
        extendUnknownExplain.report.explanation?.status,
        "blocked_by_gap",
      );
      assert.ok(
        extendUnknownExplain.report.explanation?.localGaps.some(
          (lg) =>
            lg.status === "unresolved" &&
            lg.field === "age" &&
            lg.gap.kind === "unresolved-schema-field" &&
            lg.gap.at?.line === extendRuntimeLine,
        ),
        JSON.stringify(extendUnknownExplain.report.explanation?.localGaps),
      );

      const extendResolvedExplain = await host.check({
        config: integratedExplainConfigPath,
        rule: "row-projection-satisfies-validator",
        at: extendResolvedCallAt,
      });
      assert.equal(extendResolvedExplain.status, 0);
      assert.equal(
        extendResolvedExplain.report.explanation?.gaps.some(
          (g) =>
            g.kind === "unresolved-schema-field" ||
            g.at?.file === schemaRelPath,
        ),
        false,
        JSON.stringify(extendResolvedExplain.report.explanation?.gaps),
      );
      assert.ok(
        extendResolvedExplain.report.explanation?.localGaps.some(
          (lg) =>
            lg.status === "resolved_by_override" &&
            lg.field === "age" &&
            lg.gap.at?.line === extendRuntimeLine &&
            lg.resolvedBy?.providerId === "zod" &&
            lg.resolvedBy.operation === ".extend()" &&
            lg.resolvedBy.at?.line === extendResolvedLine,
        ),
        JSON.stringify(extendResolvedExplain.report.explanation?.localGaps),
      );

      const extendUnknownOutExplain = await host.check({
        config: integratedOutputExplainConfigPath,
        rule: "validator-output-fields-probe",
        at: extendUnknownCallAt,
      });
      assert.equal(extendUnknownOutExplain.status, 1);
      assert.equal(
        extendUnknownOutExplain.report.explanation?.status,
        "reported",
      );
      assert.ok(
        extendUnknownOutExplain.report.explanation?.localGaps.some(
          (lg) =>
            lg.status === "unresolved" &&
            lg.field === "age" &&
            lg.gap.kind === "unresolved-schema-field" &&
            lg.gap.at?.line === extendRuntimeLine,
        ),
        JSON.stringify(extendUnknownOutExplain.report.explanation?.localGaps),
      );

      const extendResolvedOutExplain = await host.check({
        config: integratedOutputExplainConfigPath,
        rule: "validator-output-fields-probe",
        at: extendResolvedCallAt,
      });
      assert.equal(extendResolvedOutExplain.status, 1);
      assert.equal(extendResolvedOutExplain.report.diagnostics.length, 1);
      assert.match(
        extendResolvedOutExplain.report.diagnostics[0]!.message,
        /extendUnknownSchema/u,
      );
      assert.deepEqual(extendResolvedOutExplain.report.explanation?.gaps, []);
      assert.ok(
        extendResolvedOutExplain.report.explanation?.localGaps.some(
          (lg) =>
            lg.status === "resolved_by_override" &&
            lg.field === "age" &&
            lg.gap.at?.line === extendRuntimeLine &&
            lg.resolvedBy?.providerId === "zod" &&
            lg.resolvedBy.operation === ".extend()" &&
            lg.resolvedBy.at?.line === extendResolvedLine,
        ),
        JSON.stringify(extendResolvedOutExplain.report.explanation?.localGaps),
      );
    },
  );
});

void test("keeps watch, shared session, and cold CLI check identical across edit and restore cycles of Drizzle tables, Zod schemas, and composed query dependencies", async () => {
  await withAcceptanceHost(
    {
      overlay: "drizzle-zod",
      additionalPackages: ["@tssae/adapters", "@verule/rules-reference"],
      directPackages: [
        "@boringparts/verule",
        "@tssae/adapters",
        "@verule/rules-reference",
      ],
    },
    async (host) => {
      const originalSchema = host.readText(schemaRelPath);
      const originalProjections = host.readText(projectionsRelPath);

      const watch = await host.startWatch({ config: drizzleZodConfigPath });
      const shared = await host.startSession({ config: drizzleZodConfigPath });
      try {
        const watchInitial = await watch.nextReport();
        const sharedInitial = (await shared.check()).report;
        const coldInitial = await host.check({ config: drizzleZodConfigPath });
        assert.equal(coldInitial.status, 0);
        assertReportParity(
          watchInitial,
          sharedInitial,
          coldInitial.report,
          "drizzle-zod-initial",
        );

        // 1. Drizzle table definition edit -> verify -> restore -> verify.
        host.replaceText(
          schemaRelPath,
          '  status: text("status").notNull(),\n',
          '  status: text("status").notNull(),\n  tenantId: integer("tenant_id").notNull(),\n',
        );
        const watchTableEdited = await watch.nextReport();
        const sharedTableEdited = (await shared.check()).report;
        const coldTableEdited = await host.check({
          config: drizzleZodConfigPath,
        });
        assert.equal(coldTableEdited.status, 1);
        assert.equal(coldTableEdited.report.diagnostics.length, 3);
        assertReportParity(
          watchTableEdited,
          sharedTableEdited,
          coldTableEdited.report,
          "drizzle-table-edited",
        );

        host.writeText(schemaRelPath, originalSchema);
        const watchTableRestored = await watch.nextReport();
        const sharedTableRestored = (await shared.check()).report;
        const coldTableRestored = await host.check({
          config: drizzleZodConfigPath,
        });
        assert.equal(coldTableRestored.status, 0);
        assert.deepEqual(coldTableRestored.report.diagnostics, []);
        assertReportParity(
          watchTableRestored,
          sharedTableRestored,
          coldTableRestored.report,
          "drizzle-table-restored",
        );

        // 2. Zod / drizzle-zod schema `.default(...)` override edit -> verify -> restore -> verify.
        host.replaceText(
          schemaRelPath,
          "  age: z.number().default(18),\n",
          "  age: z.number(),\n",
        );
        const watchZodEdited = await watch.nextReport();
        const sharedZodEdited = (await shared.check()).report;
        const coldZodEdited = await host.check({
          config: drizzleZodConfigPath,
        });
        assert.equal(coldZodEdited.status, 1);
        assert.equal(coldZodEdited.report.diagnostics.length, 1);
        assert.match(coldZodEdited.report.diagnostics[0]!.message, /\bage\b/u);
        assertReportParity(
          watchZodEdited,
          sharedZodEdited,
          coldZodEdited.report,
          "zod-schema-edited",
        );

        host.writeText(schemaRelPath, originalSchema);
        const watchZodRestored = await watch.nextReport();
        const sharedZodRestored = (await shared.check()).report;
        const coldZodRestored = await host.check({
          config: drizzleZodConfigPath,
        });
        assert.equal(coldZodRestored.status, 0);
        assert.deepEqual(coldZodRestored.report.diagnostics, []);
        assertReportParity(
          watchZodRestored,
          sharedZodRestored,
          coldZodRestored.report,
          "zod-schema-restored",
        );

        // 3a. Composed query projection dependency edit -> verify -> restore -> verify.
        host.replaceText(
          projectionsRelPath,
          "      status: users.status,\n",
          "",
        );
        const watchProjEdited = await watch.nextReport();
        const sharedProjEdited = (await shared.check()).report;
        const coldProjEdited = await host.check({
          config: drizzleZodConfigPath,
        });
        assert.equal(coldProjEdited.status, 1);
        assert.equal(coldProjEdited.report.diagnostics.length, 1);
        assert.match(
          coldProjEdited.report.diagnostics[0]!.message,
          /\bstatus\b/u,
        );
        assertReportParity(
          watchProjEdited,
          sharedProjEdited,
          coldProjEdited.report,
          "drizzle-projection-edited",
        );

        host.writeText(projectionsRelPath, originalProjections);
        const watchProjRestored = await watch.nextReport();
        const sharedProjRestored = (await shared.check()).report;
        const coldProjRestored = await host.check({
          config: drizzleZodConfigPath,
        });
        assert.equal(coldProjRestored.status, 0);
        assert.deepEqual(coldProjRestored.report.diagnostics, []);
        assertReportParity(
          watchProjRestored,
          sharedProjRestored,
          coldProjRestored.report,
          "drizzle-projection-restored",
        );
      } finally {
        host.writeText(schemaRelPath, originalSchema);
        host.writeText(projectionsRelPath, originalProjections);
        await shared.close();
        await watch.close();
      }
    },
  );

  // 3b. Cross-adapter FixtureSourceSpecFact Object A edit -> verify -> restore -> verify
  // with watch, shared session, and cold CLI check running concurrently.
  await withAcceptanceHost(
    {
      overlay: "provider-session",
      additionalPackages: [...providerSessionPackages],
      extraArtifacts: builtFixtures.artifacts,
    },
    async (host) => {
      const originalSource = host.readText(compositionSourceRelPath);

      const watch = await host.startWatch({ config: compositionConfigPath });
      const shared = await host.startSession({
        config: compositionConfigPath,
      });
      try {
        const watchInitial = await watch.nextReport();
        const sharedInitial = (await shared.check()).report;
        const coldInitial = await host.check({ config: compositionConfigPath });
        assert.equal(coldInitial.status, 1);
        assertReportParity(
          watchInitial,
          sharedInitial,
          coldInitial.report,
          "provider-composition-initial",
        );

        copyAcceptanceHostMaterial(
          "app",
          "provider-session-overlay/variants/composition-dynamic/provider-session-source.ts",
          host.resolvePath(compositionSourceRelPath),
        );

        const watchEdited = await watch.nextReport();
        const sharedEdited = (await shared.check()).report;
        const coldEdited = await host.check({ config: compositionConfigPath });
        assert.equal(coldEdited.status, 1);
        assert.ok(
          coldEdited.report.gaps.some(
            (gap) =>
              gap.kind === "unresolved-fixture-field" &&
              gap.at?.file === compositionSourceRelPath,
          ),
          JSON.stringify(coldEdited.report.gaps),
        );
        const editedDiag = coldEdited.report.diagnostics.find(
          (d) => d.ruleId === "provider-session-composition",
        );
        assert.ok(editedDiag);
        assert.deepEqual(JSON.parse(editedDiag.message), {
          consumerName: "sessionOrderConsumer",
          sourceName: "order",
          fields: {
            orderId: "optional",
            notes: "required",
            couponCode: "defaulted",
          },
          requiredFields: ["notes"],
          optionalFields: ["orderId"],
          defaultedFields: ["couponCode"],
          unknownFields: ["promoCode"],
          hasDynamicFields: true,
          sourceProviders: ["third-party-fixture"],
        });
        assertReportParity(
          watchEdited,
          sharedEdited,
          coldEdited.report,
          "provider-composition-edited",
        );

        host.writeText(compositionSourceRelPath, originalSource);
        const watchRestored = await watch.nextReport();
        const sharedRestored = (await shared.check()).report;
        const coldRestored = await host.check({
          config: compositionConfigPath,
        });
        assert.equal(
          coldRestored.report.gaps.some(
            (gap) => gap.kind === "unresolved-fixture-field",
          ),
          false,
          JSON.stringify(coldRestored.report.gaps),
        );
        assertReportParity(
          watchRestored,
          sharedRestored,
          coldRestored.report,
          "provider-composition-restored",
        );
        assert.deepEqual(
          comparableReport(coldRestored.report),
          comparableReport(coldInitial.report),
        );
      } finally {
        host.writeText(compositionSourceRelPath, originalSource);
        await shared.close();
        await watch.close();
      }
    },
  );
});
