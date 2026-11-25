import assert from "node:assert/strict";
import { test } from "node:test";

import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { captureCli } from "./cli-test-helpers.ts";

void test("verule check distinguishes clean, gaps-only, findings-with-gaps, and escalated-gap on mixed TS/JS with observe off", async () => {
  await withCliTempHost(
    { host: "integration/calls-and-values" },
    async (host) => {
      await host.typecheck();

      // (a) Clean with zero gaps
      const cleanJson = await captureCli(
        ["check", "--config", "verule.clean.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(cleanJson.status, 0, cleanJson.stderr);
      const cleanEnv = JSON.parse(cleanJson.stdout) as {
        variant: string;
        data: {
          status: string;
          diagnostics: unknown[];
          gaps: unknown[];
          observation?: unknown;
        };
      };
      assert.equal(cleanEnv.variant, "clean");
      assert.equal(cleanEnv.data.status, "clean");
      assert.deepEqual(cleanEnv.data.diagnostics, []);
      assert.deepEqual(cleanEnv.data.gaps, []);
      assert.equal("observation" in cleanEnv.data, false);

      // (b) Clean with gaps present -> exit 0 and gaps listed
      const gapsText = await captureCli(
        ["check", "--config", "verule.gaps-only.config.ts"],
        host.rootDir,
      );
      assert.equal(gapsText.status, 0, gapsText.stderr);
      assert.match(gapsText.stdout, /gap \[dynamic-callee\]/u);
      assert.match(gapsText.stdout, /No violations found.*1 gap\(s\)/u);

      const gapsJson = await captureCli(
        ["check", "--config", "verule.gaps-only.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(gapsJson.status, 0, gapsJson.stderr);
      const gapsEnv = JSON.parse(gapsJson.stdout) as {
        variant: string;
        data: {
          status: string;
          diagnostics: unknown[];
          gaps: { kind: string }[];
          observation?: unknown;
        };
      };
      assert.equal(gapsEnv.variant, "clean");
      assert.deepEqual(gapsEnv.data.diagnostics, []);
      assert.equal(gapsEnv.data.gaps.length, 1);
      assert.equal(gapsEnv.data.gaps[0]?.kind, "dynamic-callee");
      assert.equal("observation" in gapsEnv.data, false);

      // (c) Findings + gaps coexisting -> exit 1 and both diagnostics & gaps preserved
      const mixedText = await captureCli(
        ["check", "--config", "verule.findings-and-gaps.config.ts"],
        host.rootDir,
      );
      assert.equal(mixedText.status, 1, mixedText.stderr);
      assert.match(mixedText.stdout, /mixed-flow-and-gap/u);
      assert.match(mixedText.stdout, /gap \[dynamic-callee\]/u);
      assert.match(mixedText.stdout, /Found 1 violation\(s\) \(1 gap\(s\)\)/u);

      const mixedJson = await captureCli(
        [
          "check",
          "--config",
          "verule.findings-and-gaps.config.ts",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(mixedJson.status, 1, mixedJson.stderr);
      const mixedEnv = JSON.parse(mixedJson.stdout) as {
        variant: string;
        data: {
          status: string;
          diagnostics: { evidence: { at?: { file: string } }[] }[];
          gaps: { kind: string }[];
          observation?: unknown;
        };
      };
      assert.equal(mixedEnv.variant, "findings");
      assert.equal(mixedEnv.data.diagnostics.length, 1);
      assert.ok(
        mixedEnv.data.diagnostics[0]!.evidence.some(
          (e) => e.at?.file === "src/bridge.js",
        ),
      );
      assert.ok(
        mixedEnv.data.diagnostics[0]!.evidence.some(
          (e) => e.at?.file === "src/sink.ts",
        ),
      );
      assert.equal(mixedEnv.data.gaps.length, 1);
      assert.equal(mixedEnv.data.gaps[0]?.kind, "dynamic-callee");
      assert.equal("observation" in mixedEnv.data, false);

      // (d) Rule actively escalates gap to violation -> exit 1
      const escalateJson = await captureCli(
        [
          "check",
          "--config",
          "verule.escalate-gap.config.ts",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(escalateJson.status, 1, escalateJson.stderr);
      const escalateEnv = JSON.parse(escalateJson.stdout) as {
        variant: string;
        data: {
          status: string;
          diagnostics: { message: string }[];
          gaps: { kind: string }[];
        };
      };
      assert.equal(escalateEnv.variant, "findings");
      assert.equal(escalateEnv.data.diagnostics.length, 1);
      assert.match(
        escalateEnv.data.diagnostics[0]!.message,
        /Escalated dynamic gap/u,
      );
      assert.equal(escalateEnv.data.gaps.length, 1);
    },
  );
});
