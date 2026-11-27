import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { runCliScenario } from "@boringparts/cli-contract/testing";

import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { testCliContract } from "./cli-test-helpers.ts";

void test("verule check --rule and --at explain why a source location did not report", async () => {
  await withCliTempHost(
    { host: "integration/explain-checkpoints" },
    async (host) => {
      await host.typecheck();

      // Line 8 is `return sink(input);` where `input` is narrowed to `number`, so rule-no-string-sink excludes it
      const jsonRes = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--rule",
          "rule-no-string-sink",
          "--at",
          "src/app.ts:8:10",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(jsonRes.termination.kind === "applicationResult");
      assert.equal(jsonRes.termination.exitCode, 1, jsonRes.stderr);
      assert.ok(jsonRes.termination.result.kind === "data");
      assert.ok(jsonRes.termination.result.command === "check");

      const explanation = jsonRes.termination.result.data.explanation;
      assert.ok(explanation);
      assert.equal(explanation.ruleId, "rule-no-string-sink");
      assert.equal(explanation.inCandidates, true);
      assert.equal(explanation.status, "excluded_by_checkpoint");
      assert.equal(explanation.excludedByCheckpoint?.name, "require-string");
      assert.partialDeepStrictEqual(explanation.excludedByCheckpoint?.detail, {
        actualType: "number",
      });

      // Text output also prints the explanation
      const textRes = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--rule",
          "rule-no-string-sink",
          "--at",
          "src/app.ts:1:1",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(textRes.termination.exitCode, 1, textRes.stderr);
      assert.match(textRes.stdout, /Explanation \[rule-no-string-sink\]/u);
      assert.match(textRes.stdout, /not_in_candidates/u);
    },
  );
});

void test("verule check --observe and --observe-limit report overhead, truncation, and preserve identical business reports", async () => {
  await withCliTempHost(
    { host: "integration/explain-checkpoints" },
    async (host) => {
      const evalLogPath = host.resolvePath("lazy-eval-count.txt");

      const offStart = performance.now();
      const offRes = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      const offWallMs = performance.now() - offStart;
      assert.ok(offRes.termination.kind === "applicationResult");
      assert.equal(offRes.termination.exitCode, 1, offRes.stderr);
      assert.ok(offRes.termination.result.kind === "data");
      assert.ok(offRes.termination.result.command === "check");
      const offData = offRes.termination.result.data;
      assert.equal("observation" in offData, false);
      assert.equal(existsSync(evalLogPath), false);

      const detailStart = performance.now();
      const detailRes = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--observe",
          "detail",
          "--observe-limit",
          "2",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      const detailWallMs = performance.now() - detailStart;
      assert.ok(detailRes.termination.kind === "applicationResult");
      assert.equal(detailRes.termination.exitCode, 1, detailRes.stderr);
      assert.ok(detailRes.termination.result.kind === "data");
      assert.ok(detailRes.termination.result.command === "check");
      assert.ok(offWallMs >= 0 && detailWallMs >= 0);

      const detailData = detailRes.termination.result.data;
      assert.equal(detailData.status, offData.status);
      assert.deepEqual(detailData.diagnostics, offData.diagnostics);
      assert.deepEqual(detailData.gaps, offData.gaps);
      assert.ok(detailData.observation);
      assert.equal(detailData.observation.mode, "detail");
      assert.equal(detailData.observation.truncated, true);
      assert.ok(detailData.observation.droppedCount >= 1);
      assert.equal(detailData.observation.details?.length, 2);
      assert.ok(detailData.observation.rpc.batches >= 2);
      assert.ok(detailData.observation.rpc.bytesSent > 0);
      assert.ok(detailData.observation.rpc.bytesReceived > 0);
      assert.ok(detailData.observation.overhead.checkpointMs >= 0);
      assert.ok(detailData.observation.overhead.encodeMs >= 0);
      assert.ok(detailData.observation.overhead.writeMs >= 0);

      // Without limit, lazy detail callbacks are evaluated
      const unlimitedDetail = await runCliScenario(testCliContract, {
        argv: ["check", "--observe", "detail", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(unlimitedDetail.termination.exitCode, 1);
      assert.equal(existsSync(evalLogPath), true);
      assert.ok(
        host.readText("lazy-eval-count.txt").trim().split("\n").length >= 2,
      );
    },
  );
});

void test("verule check rejects unknown --rule, invalid --at, and invalid --observe-limit with exit 2", async () => {
  await withCliTempHost(
    { host: "integration/explain-checkpoints" },
    async (host) => {
      const badRule = await runCliScenario(testCliContract, {
        argv: ["check", "--rule", "does-not-exist", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(badRule.termination.kind === "applicationResult");
      assert.equal(badRule.termination.exitCode, 2);
      assert.ok(badRule.termination.result.kind === "failure");
      assert.ok(badRule.termination.result.command === "check");
      assert.equal(badRule.termination.result.data.code, "INVALID_CONFIG");

      const badAt = await runCliScenario(testCliContract, {
        argv: ["check", "--at", "src/app.ts:0", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(badAt.termination.kind === "applicationResult");
      assert.equal(badAt.termination.exitCode, 2);
      assert.ok(badAt.termination.result.kind === "failure");
      assert.ok(badAt.termination.result.command === "check");
      assert.equal(badAt.termination.result.data.code, "INVALID_CONFIG");

      const badLimit = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--observe",
          "detail",
          "--observe-limit",
          "abc",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(badLimit.termination.kind === "applicationResult");
      assert.equal(badLimit.termination.exitCode, 2);
      assert.ok(badLimit.termination.result.kind === "failure");
      assert.ok(badLimit.termination.result.command === "check");
      assert.equal(badLimit.termination.result.data.code, "INVALID_CONFIG");
    },
  );
});

void test("verule check --observe and --at surface engine metrics, ruleId, candidates, and reuse", async () => {
  await withCliTempHost(
    { host: "integration/explain-checkpoints" },
    async (host) => {
      await host.typecheck();

      const textRes = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--config",
          "verule.observe-reuse.config.ts",
          "--observe",
          "detail",
          "--at",
          "src/app.ts:2:1",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(textRes.termination.exitCode, 0, textRes.stderr);
      assert.match(textRes.stdout, /lowering:/u);
      assert.match(textRes.stdout, /irCache:/u);
      assert.match(textRes.stdout, /summaryLookup:/u);
      assert.match(textRes.stdout, /rule=rule-first/u);
      assert.match(textRes.stdout, /rule=rule-second/u);
      assert.match(textRes.stdout, /cache=computed/u);
      assert.match(textRes.stdout, /cache=reused/u);
    },
  );
});

void test("verule check --at --output json strips undefined properties from checkpoint details", async () => {
  await withCliTempHost({ host: "integration/explain-undef" }, async (host) => {
    await host.typecheck();

    const res = await runCliScenario(testCliContract, {
      argv: ["check", "--at", "src/app.ts:1", "--output", "json"],
      dependencies: { cwd: host.rootDir },
    });
    assert.ok(res.termination.kind === "applicationResult");
    assert.equal(res.termination.exitCode, 0, res.stderr);
    assert.ok(res.termination.result.kind === "data");
    assert.ok(res.termination.result.command === "check");

    const cp = res.termination.result.data.explanation?.checkpoints.find(
      (item) => item.name === "checked-decl",
    );
    assert.ok(cp);
    assert.deepEqual(cp.detail, { present: true });
  });
});
