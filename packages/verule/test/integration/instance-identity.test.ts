import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { runCliScenario } from "@boringparts/cli-contract/testing";

import { resolveCliHostDir, withCliTempHost } from "../helpers/cli-hosts.ts";
import { testCliContract } from "./cli-test-helpers.ts";

void test("verule check distinguishes resource instances across factories/summaries, emits summary evidence, and surfaces missing-behavior-summary gaps", async () => {
  await withCliTempHost(
    {
      host: "integration/instance-identity",
      packageLinks: {
        "@acme/lifecycle": join(
          resolveCliHostDir("integration/instance-identity"),
          "vendor/@acme/lifecycle",
        ),
      },
    },
    async (host) => {
      await host.typecheck();

      const jsonRun = await runCliScenario(testCliContract, {
        argv: ["check", "--config", "verule.config.ts", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(jsonRun.termination.kind === "applicationResult");
      assert.equal(jsonRun.termination.exitCode, 1, jsonRun.stderr);
      assert.ok(jsonRun.termination.result.kind === "data");
      assert.ok(jsonRun.termination.result.command === "check");
      assert.equal(jsonRun.termination.result.variant, "findings");
      const parsedReport = jsonRun.termination.result.data;
      assert.equal(parsedReport.status, "findings");
      assert.equal(parsedReport.diagnostics.length, 1);

      const diag = parsedReport.diagnostics[0]!;
      assert.equal(diag.ruleId, "check-instance-cleanup-match");
      assert.equal(diag.at.file, "src/app.ts");
      assert.match(diag.message, /different instance/u);
      assert.ok(
        diag.evidence.some((e) => e.kind === "source"),
        "Expected source evidence in CLI report",
      );
      assert.ok(
        diag.evidence.some(
          (e) =>
            e.kind === "summary" &&
            e.summaryId === "acme-lifecycle" &&
            e.declaration?.includes("_register"),
        ),
        `Expected summary evidence for Disposable._register, got ${JSON.stringify(diag.evidence)}`,
      );
      assert.ok(
        diag.evidence.some(
          (e) =>
            e.kind === "summary" &&
            e.summaryId === "acme-lifecycle" &&
            e.declaration?.includes("createMenu"),
        ),
        `Expected summary evidence for IMenuService.createMenu, got ${JSON.stringify(diag.evidence)}`,
      );
      assert.ok(
        parsedReport.gaps.some((g) => g.kind === "missing-behavior-summary"),
        `Expected missing-behavior-summary gap, got ${JSON.stringify(parsedReport.gaps)}`,
      );

      const textRun = await runCliScenario(testCliContract, {
        argv: ["check", "--config", "verule.config.ts"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(textRun.termination.exitCode, 1, textRun.stderr);
      assert.match(textRun.stdout, /evidence \(source\):/u);
      assert.match(
        textRun.stdout,
        /evidence \(summary\): .*\[summary=acme-lifecycle@local:/u,
      );
      assert.match(textRun.stdout, /gap \[missing-behavior-summary\]:/u);
    },
  );
});
