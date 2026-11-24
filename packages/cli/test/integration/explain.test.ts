import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { withCliTempHost } from "@verule/cli-hosts";

import { captureCli } from "./cli-test-helpers.ts";

void test("verule check --rule and --at explain why a source location did not report", async () => {
  await withCliTempHost(
    { host: "integration/explain-checkpoints" },
    async (host) => {
      await host.typecheck();

      // Line 8 is `return sink(input);` where `input` is narrowed to `number`, so rule-no-string-sink excludes it
      const jsonRes = await captureCli(
        [
          "check",
          "--rule",
          "rule-no-string-sink",
          "--at",
          "src/app.ts:8:10",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(jsonRes.status, 1, jsonRes.stderr);
      const envelope = JSON.parse(jsonRes.stdout) as {
        kind: string;
        variant: string;
        data: {
          status: string;
          diagnostics: unknown[];
          explanation: {
            ruleId: string;
            status: string;
            inCandidates: boolean;
            excludedByCheckpoint?: {
              name: string;
              detail?: { actualType: string };
            };
            queries: {
              op: string;
              candidateCount: number;
              cacheStatus: string;
            }[];
          };
        };
      };
      assert.equal(envelope.kind, "data");
      assert.equal(envelope.data.explanation.ruleId, "rule-no-string-sink");
      assert.equal(envelope.data.explanation.inCandidates, true);
      assert.equal(envelope.data.explanation.status, "excluded_by_checkpoint");
      assert.equal(
        envelope.data.explanation.excludedByCheckpoint?.name,
        "require-string",
      );
      assert.equal(
        envelope.data.explanation.excludedByCheckpoint?.detail?.actualType,
        "number",
      );

      // Text output also prints the explanation
      const textRes = await captureCli(
        ["check", "--rule", "rule-no-string-sink", "--at", "src/app.ts:1:1"],
        host.rootDir,
      );
      assert.equal(textRes.status, 1, textRes.stderr);
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
      const offRes = await captureCli(
        ["check", "--output", "json"],
        host.rootDir,
      );
      const offWallMs = performance.now() - offStart;
      assert.equal(offRes.status, 1, offRes.stderr);
      const offEnvelope = JSON.parse(offRes.stdout) as {
        data: {
          status: string;
          diagnostics: unknown[];
          gaps: unknown[];
          observation?: unknown;
        };
      };
      assert.equal("observation" in offEnvelope.data, false);
      assert.equal(existsSync(evalLogPath), false);

      const detailStart = performance.now();
      const detailRes = await captureCli(
        [
          "check",
          "--observe",
          "detail",
          "--observe-limit",
          "2",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      const detailWallMs = performance.now() - detailStart;
      assert.equal(detailRes.status, 1, detailRes.stderr);
      assert.ok(offWallMs >= 0 && detailWallMs >= 0);

      const detailEnvelope = JSON.parse(detailRes.stdout) as {
        data: {
          status: string;
          diagnostics: unknown[];
          gaps: unknown[];
          observation: {
            mode: string;
            truncated: boolean;
            droppedCount: number;
            details: unknown[];
            phases: {
              configAndOpenMs: number;
              engineQueryMs: number;
              ruleExecutionMs: number;
            };
            rpc: { batches: number; bytesSent: number; bytesReceived: number };
            overhead: {
              checkpointMs: number;
              encodeMs: number;
              writeMs: number;
            };
          };
        };
      };
      assert.equal(detailEnvelope.data.status, offEnvelope.data.status);
      assert.deepEqual(
        detailEnvelope.data.diagnostics,
        offEnvelope.data.diagnostics,
      );
      assert.deepEqual(detailEnvelope.data.gaps, offEnvelope.data.gaps);
      assert.equal(detailEnvelope.data.observation.mode, "detail");
      assert.equal(detailEnvelope.data.observation.truncated, true);
      assert.ok(detailEnvelope.data.observation.droppedCount >= 1);
      assert.equal(detailEnvelope.data.observation.details.length, 2);
      assert.ok(detailEnvelope.data.observation.rpc.batches >= 2);
      assert.ok(detailEnvelope.data.observation.rpc.bytesSent > 0);
      assert.ok(detailEnvelope.data.observation.rpc.bytesReceived > 0);
      assert.ok(detailEnvelope.data.observation.overhead.checkpointMs >= 0);
      assert.ok(detailEnvelope.data.observation.overhead.encodeMs >= 0);
      assert.ok(detailEnvelope.data.observation.overhead.writeMs >= 0);

      // Without limit, lazy detail callbacks are evaluated
      const unlimitedDetail = await captureCli(
        ["check", "--observe", "detail", "--output", "json"],
        host.rootDir,
      );
      assert.equal(unlimitedDetail.status, 1);
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
      const badRule = await captureCli(
        ["check", "--rule", "does-not-exist", "--output", "json"],
        host.rootDir,
      );
      assert.equal(badRule.status, 2);
      assert.equal(JSON.parse(badRule.stderr).data.code, "INVALID_CONFIG");

      const badAt = await captureCli(
        ["check", "--at", "src/app.ts:0", "--output", "json"],
        host.rootDir,
      );
      assert.equal(badAt.status, 2);
      assert.equal(JSON.parse(badAt.stderr).data.code, "INVALID_CONFIG");

      const badLimit = await captureCli(
        [
          "check",
          "--observe",
          "detail",
          "--observe-limit",
          "abc",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(badLimit.status, 2);
      assert.equal(JSON.parse(badLimit.stderr).data.code, "INVALID_CONFIG");
    },
  );
});

void test("verule check --observe and --at surface adapter providers, ruleId, candidates, and reuse", async () => {
  await withCliTempHost(
    { host: "integration/explain-facts-observe" },
    async (host) => {
      await host.typecheck();

      const textRes = await captureCli(
        ["check", "--observe", "detail", "--at", "src/app.ts:2:1"],
        host.rootDir,
      );
      assert.equal(textRes.status, 0, textRes.stderr);
      assert.match(textRes.stdout, /providers: .*sample-provider/u);
      assert.match(textRes.stdout, /provider=sample-provider/u);
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

    const res = await captureCli(
      ["check", "--at", "src/app.ts:1", "--output", "json"],
      host.rootDir,
    );
    assert.equal(res.status, 0, res.stderr);
    const parsed = JSON.parse(res.stdout) as {
      readonly kind: string;
      readonly data: {
        readonly explanation: {
          readonly checkpoints: readonly {
            readonly name: string;
            readonly detail?: Record<string, unknown>;
          }[];
        };
      };
    };
    assert.equal(parsed.kind, "data");
    const cp = parsed.data.explanation.checkpoints.find(
      (item) => item.name === "checked-decl",
    );
    assert.ok(cp);
    assert.deepEqual(cp.detail, { present: true });
  });
});
