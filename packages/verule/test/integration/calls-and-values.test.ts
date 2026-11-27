import assert from "node:assert/strict";
import { test } from "node:test";

import { runCliScenario } from "@boringparts/cli-contract/testing";

import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { testCliContract } from "./cli-test-helpers.ts";

void test("verule check distinguishes clean, gaps-only, findings-with-gaps, and escalated-gap on mixed TS/JS with observe off", async () => {
  await withCliTempHost(
    { host: "integration/calls-and-values" },
    async (host) => {
      await host.typecheck();

      // (a) Clean with zero gaps
      const cleanJson = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--config",
          "verule.clean.config.ts",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(cleanJson.termination.kind === "applicationResult");
      assert.equal(cleanJson.termination.exitCode, 0, cleanJson.stderr);
      assert.ok(cleanJson.termination.result.kind === "data");
      assert.ok(cleanJson.termination.result.command === "check");
      assert.equal(cleanJson.termination.result.variant, "clean");
      assert.equal(cleanJson.termination.result.data.status, "clean");
      assert.deepEqual(cleanJson.termination.result.data.diagnostics, []);
      assert.deepEqual(cleanJson.termination.result.data.gaps, []);
      assert.equal("observation" in cleanJson.termination.result.data, false);

      // (b) Clean with gaps present -> exit 0 and gaps listed
      const gapsText = await runCliScenario(testCliContract, {
        argv: ["check", "--config", "verule.gaps-only.config.ts"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(gapsText.termination.exitCode, 0, gapsText.stderr);
      assert.match(gapsText.stdout, /gap \[dynamic-callee\]/u);
      assert.match(gapsText.stdout, /No violations found.*1 gap\(s\)/u);

      const gapsJson = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--config",
          "verule.gaps-only.config.ts",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(gapsJson.termination.kind === "applicationResult");
      assert.equal(gapsJson.termination.exitCode, 0, gapsJson.stderr);
      assert.ok(gapsJson.termination.result.kind === "data");
      assert.ok(gapsJson.termination.result.command === "check");
      assert.equal(gapsJson.termination.result.variant, "clean");
      assert.deepEqual(gapsJson.termination.result.data.diagnostics, []);
      assert.equal(gapsJson.termination.result.data.gaps.length, 1);
      assert.equal(
        gapsJson.termination.result.data.gaps[0]?.kind,
        "dynamic-callee",
      );
      assert.equal("observation" in gapsJson.termination.result.data, false);

      // (c) Findings + gaps coexisting -> exit 1 and both diagnostics & gaps preserved
      const mixedText = await runCliScenario(testCliContract, {
        argv: ["check", "--config", "verule.findings-and-gaps.config.ts"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(mixedText.termination.exitCode, 1, mixedText.stderr);
      assert.match(mixedText.stdout, /mixed-flow-and-gap/u);
      assert.match(mixedText.stdout, /gap \[dynamic-callee\]/u);
      assert.match(mixedText.stdout, /Found 1 violation\(s\) \(1 gap\(s\)\)/u);

      const mixedJson = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--config",
          "verule.findings-and-gaps.config.ts",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(mixedJson.termination.kind === "applicationResult");
      assert.equal(mixedJson.termination.exitCode, 1, mixedJson.stderr);
      assert.ok(mixedJson.termination.result.kind === "data");
      assert.ok(mixedJson.termination.result.command === "check");
      assert.equal(mixedJson.termination.result.variant, "findings");
      const mixedData = mixedJson.termination.result.data;
      assert.equal(mixedData.diagnostics.length, 1);
      assert.ok(
        mixedData.diagnostics[0]!.evidence.some(
          (e) => e.at?.file === "src/bridge.js",
        ),
      );
      assert.ok(
        mixedData.diagnostics[0]!.evidence.some(
          (e) => e.at?.file === "src/sink.ts",
        ),
      );
      assert.equal(mixedData.gaps.length, 1);
      assert.equal(mixedData.gaps[0]?.kind, "dynamic-callee");
      assert.equal("observation" in mixedData, false);

      // (d) Rule actively escalates gap to violation -> exit 1
      const escalateJson = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--config",
          "verule.escalate-gap.config.ts",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(escalateJson.termination.kind === "applicationResult");
      assert.equal(escalateJson.termination.exitCode, 1, escalateJson.stderr);
      assert.ok(escalateJson.termination.result.kind === "data");
      assert.ok(escalateJson.termination.result.command === "check");
      assert.equal(escalateJson.termination.result.variant, "findings");
      assert.equal(escalateJson.termination.result.data.diagnostics.length, 1);
      assert.match(
        escalateJson.termination.result.data.diagnostics[0]!.message,
        /Escalated dynamic gap/u,
      );
      assert.equal(escalateJson.termination.result.data.gaps.length, 1);
    },
  );
});
