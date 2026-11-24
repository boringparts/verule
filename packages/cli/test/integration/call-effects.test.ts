import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { resolveCliHostDir, withCliTempHost } from "@verule/cli-hosts";

import { checkReportSchema } from "../../src/report-wire.ts";
import { captureCli } from "./cli-test-helpers.ts";

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
      const jsonRes = await captureCli(
        ["check", "--output", "json"],
        host.rootDir,
      );
      assert.equal(
        jsonRes.status,
        1,
        `stdout=${jsonRes.stdout}\nstderr=${jsonRes.stderr}`,
      );
      const envelope = JSON.parse(jsonRes.stdout) as {
        readonly data: unknown;
      };
      const report = checkReportSchema.parse(envelope.data);
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
      const explainJsonRes = await captureCli(
        [
          "check",
          "--rule",
          "resource-cleanup",
          "--at",
          "src/resources.ts:14",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(explainJsonRes.status, 1);
      const explainEnvelope = JSON.parse(explainJsonRes.stdout) as {
        readonly data: unknown;
      };
      const explainReport = checkReportSchema.parse(explainEnvelope.data);
      assert.equal(explainReport.explanation?.status, "covered_by_cleanup");
      assert.equal(explainReport.explanation?.cleanupPaths.length, 1);
      assert.ok(
        explainReport.explanation?.cleanupPaths[0]?.cleanupLocations.some(
          (l) => l.file === "src/resources.ts" && l.line === 17,
        ),
      );

      // 3. Also verify human text output renders `covered_by_cleanup` and `cleanupPath`
      const explainTextRes = await captureCli(
        ["check", "--rule", "resource-cleanup", "--at", "src/resources.ts:14"],
        host.rootDir,
      );
      assert.equal(explainTextRes.status, 1);
      assert.match(explainTextRes.stdout, /covered_by_cleanup/);
      assert.match(explainTextRes.stdout, /cleanupPath/);
    },
  );
});
