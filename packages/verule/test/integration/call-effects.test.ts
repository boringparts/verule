import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { runCliScenario } from "@boringparts/cli-contract/testing";

import { resolveCliHostDir, withCliTempHost } from "../helpers/cli-hosts.ts";
import { testCliContract } from "./cli-test-helpers.ts";

void test("verule check and --at explain verify close-A-clean-B, cross-file helpers, dynamic Gaps, validation vs raw, and reentrant scheduler callback field effects", async () => {
  await withCliTempHost(
    {
      host: "integration/call-effects",
      packageLinks: {
        "@acme/lifecycle": join(
          resolveCliHostDir("integration/call-effects"),
          "vendor/@acme/lifecycle",
        ),
      },
    },
    async (host) => {
      await host.typecheck();

      // 1. Run full `verule check --output json`
      const jsonRes = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(jsonRes.termination.kind === "applicationResult");
      assert.equal(
        jsonRes.termination.exitCode,
        1,
        `stdout=${jsonRes.stdout}\nstderr=${jsonRes.stderr}`,
      );
      assert.ok(jsonRes.termination.result.kind === "data");
      assert.ok(jsonRes.termination.result.command === "check");
      const report = jsonRes.termination.result.data;
      assert.equal(report.status, "findings");
      assert.equal(report.diagnostics.length, 3);
      assert.ok(
        report.diagnostics.some(
          (d) =>
            d.ruleId === "resource-cleanup" &&
            d.message.includes("Closed A") &&
            d.message.includes("disposed B"),
        ),
      );
      assert.ok(
        report.diagnostics.some(
          (d) => d.ruleId === "validated-arg" && d.at.line === 13,
        ),
      );
      assert.ok(
        report.diagnostics.some(
          (d) => d.ruleId === "scheduler-flag-guard" && d.at.line === 19,
        ),
      );
      assert.ok(report.gaps.some((g) => g.kind === "dynamic-callee"));

      // 2. Run `verule check --rule resource-cleanup --at src/resources.ts:14 --output json` for explain cleanupPaths
      // Exit status is 1 because `closeAWronglyCleansB` in the same file has a finding, while `--at` explains line 14 (`covered_by_cleanup`).
      const explainJsonRes = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--rule",
          "resource-cleanup",
          "--at",
          "src/resources.ts:14",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(explainJsonRes.termination.kind === "applicationResult");
      assert.equal(explainJsonRes.termination.exitCode, 1);
      assert.ok(explainJsonRes.termination.result.kind === "data");
      assert.ok(explainJsonRes.termination.result.command === "check");
      const explainReport = explainJsonRes.termination.result.data;
      assert.equal(explainReport.explanation?.status, "covered_by_cleanup");
      assert.equal(explainReport.explanation?.cleanupPaths.length, 1);
      assert.ok(
        explainReport.explanation?.cleanupPaths[0]?.cleanupLocations.some(
          (l) => l.file === "src/resources.ts" && l.line === 17,
        ),
      );

      // 3. Also verify human text output renders `covered_by_cleanup` and `cleanupPath`
      const explainTextRes = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--rule",
          "resource-cleanup",
          "--at",
          "src/resources.ts:14",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(explainTextRes.termination.exitCode, 1);
      assert.match(explainTextRes.stdout, /covered_by_cleanup/);
      assert.match(explainTextRes.stdout, /cleanupPath/);
    },
  );
});
