import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { withCliTempHost } from "@verule/cli-hosts";

import { runCli } from "../../src/main.ts";
import {
  TEST_CLI_IDENTITY,
  captureCli,
  captureCliJson,
  createNdjsonStreamHarness,
} from "./cli-test-helpers.ts";

type SessionNdjsonLine =
  | {
      readonly kind: "stream";
      readonly command: string;
      readonly outputMode: string;
    }
  | {
      readonly kind: "record";
      readonly variant: "ready";
      readonly data: {
        readonly reportVersion: string;
        readonly endpoint: string;
        readonly snapshotId: number;
        readonly projects: readonly unknown[];
      };
    }
  | {
      readonly kind: "streamSuccess";
    };

type CheckEnvelope =
  | {
      readonly kind: "data";
      readonly variant: "clean" | "findings";
      readonly data: {
        readonly reportVersion: string;
        readonly status: "clean" | "findings";
        readonly projects: readonly unknown[];
        readonly fileOrigins: readonly unknown[];
        readonly diagnostics: readonly {
          readonly id: string;
          readonly ruleId: string;
          readonly at: { readonly file: string; readonly line: number };
          readonly message: string;
          readonly evidence: readonly unknown[];
          readonly projects: readonly string[];
        }[];
        readonly gaps: readonly unknown[];
        readonly identity: {
          readonly snapshotDigest: string;
          readonly configDigest: string;
          readonly rules: readonly {
            readonly id: string;
            readonly digest: string;
          }[];
          readonly models: readonly {
            readonly id: string;
            readonly version?: string;
            readonly digest: string;
          }[];
        };
        readonly observation?: unknown;
        readonly explanation?: {
          readonly status: string;
          readonly ruleId: string;
        };
      };
    }
  | {
      readonly kind: "failure";
      readonly variant: "failed";
      readonly data: {
        readonly reportVersion: string;
        readonly code: string;
        readonly message: string;
      };
    };

void test("verule session and verule check --session align every round with standalone verule check", async (t) => {
  await withCliTempHost(
    { host: "integration/shared-session" },
    async (host) => {
      await host.typecheck();

      const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-sock-"));
      const socketPath = join(socketDir, "shared.sock");
      const configPath = host.resolvePath("verule.config.ts");
      const abortController = new AbortController();

      host.addCleanup(() => {
        abortController.abort();
        rmSync(socketDir, { recursive: true, force: true });
      });

      const harness = createNdjsonStreamHarness<SessionNdjsonLine>();

      async function queryAndCompare(
        label: string,
        expectedStatus: 0 | 1,
        extraArgs: readonly string[] = [],
      ) {
        const start = performance.now();
        const sharedRes = await captureCliJson<CheckEnvelope>(
          ["check", "--session", socketPath, ...extraArgs, "--output", "json"],
          tmpdir(),
        );
        const elapsedMs = performance.now() - start;
        t.diagnostic(`CLI shared query (${label}): ${elapsedMs.toFixed(2)}ms`);

        assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);
        assert.equal(sharedRes.envelope.kind, "data");

        const coldRes = await captureCliJson<CheckEnvelope>(
          ["check", "--config", configPath, ...extraArgs, "--output", "json"],
          host.rootDir,
        );
        assert.equal(coldRes.status, expectedStatus, coldRes.stderr);
        assert.equal(coldRes.envelope.kind, "data");

        assert.deepEqual(sharedRes.envelope.data, coldRes.envelope.data);
        return sharedRes.envelope.data;
      }

      const sessionPromise = runCli({
        identity: TEST_CLI_IDENTITY,
        cwd: host.rootDir,
        argv: [
          "node",
          "verule",
          "session",
          "--config",
          configPath,
          "--socket",
          socketPath,
          "--output",
          "ndjson",
        ],
        signal: abortController.signal,
        write: harness.write,
      });

      const ready = await harness.waitFor(
        (line) => line.kind === "record" && line.variant === "ready",
      );
      assert.equal(ready.kind, "record");
      assert.equal(ready.data.endpoint, socketPath);
      assert.equal(existsSync(socketPath), true);

      // 1. Initial clean state from another working directory
      await queryAndCompare("initial-clean", 0);

      // Cannot combine --session and --config
      const invalidCombo = await captureCliJson<CheckEnvelope>(
        [
          "check",
          "--session",
          socketPath,
          "--config",
          configPath,
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(invalidCombo.status, 2);
      assert.equal(invalidCombo.envelope.kind, "failure");
      assert.equal(invalidCombo.envelope.data.code, "INVALID_CONFIG");

      // 2. Introduce violation -> query immediately (0ms)
      const savedConsumer = host.readText("src/consumer.ts");
      host.replaceText(
        "src/consumer.ts",
        "return sink(getMode());",
        'void getMode();\n  return sink("fast");',
      );
      const findingsData = await queryAndCompare("introduce-violation", 1);
      assert.equal(findingsData.diagnostics.length, 1);

      // Text mode check via --session
      const textFindings = await captureCli(
        ["check", "--session", socketPath],
        tmpdir(),
      );
      assert.equal(textFindings.status, 1, textFindings.stderr);
      assert.match(textFindings.stdout, /disallow-mode/u);

      // Targeted explain & rule filter via --session
      const explained = await captureCliJson<CheckEnvelope>(
        [
          "check",
          "--session",
          socketPath,
          "--rule",
          "disallow-mode",
          "--at",
          "src/consumer.ts:9:10",
          "--output",
          "json",
        ],
        tmpdir(),
      );
      assert.equal(explained.status, 1, explained.stderr);
      assert.equal(explained.envelope.kind, "data");
      assert.equal(explained.envelope.data.explanation?.status, "reported");

      // Observation mode via --session
      const observed = await captureCliJson<CheckEnvelope>(
        [
          "check",
          "--session",
          socketPath,
          "--observe",
          "detail",
          "--output",
          "json",
        ],
        tmpdir(),
      );
      assert.equal(observed.status, 1, observed.stderr);
      assert.equal(observed.envelope.kind, "data");
      assert.ok(observed.envelope.data.observation);

      // 3. Fix violation -> query immediately -> retracted
      host.writeText("src/consumer.ts", savedConsumer);
      await queryAndCompare("fix-violation", 0);

      // 4. Modify shared definition & unrelated file
      host.writeText(
        "src/shared.ts",
        'export function getMode(): "fast" {\n  return "fast";\n}\n',
      );
      await queryAndCompare("shared-definition-change", 1);

      host.writeText("src/unrelated.ts", "export const note = 2;\n");
      await queryAndCompare("unrelated-file-change", 1);

      // 5. Config/model reload & single-round failure recovery
      const savedConfig = host.readText("verule.config.ts");
      host.writeText("verule.config.ts", "export default { broken(");

      const brokenRes = await captureCliJson<CheckEnvelope>(
        ["check", "--session", socketPath, "--output", "json"],
        tmpdir(),
      );
      assert.equal(brokenRes.status, 2);
      assert.equal(brokenRes.envelope.kind, "failure");
      assert.equal(brokenRes.envelope.data.code, "INVALID_CONFIG");

      // Restore config and update model -> recovers immediately
      host.writeText("verule.config.ts", savedConfig);
      host.replaceText(
        "verule.model.ts",
        'version: "1",\n  facts: { disallowedMode: "fast" },',
        'version: "2",\n  facts: { disallowedMode: "safe" },',
      );
      const recovered = await queryAndCompare("recover-and-model-reload", 0);
      assert.equal(recovered.identity.models[0]?.version, "2");

      // 6. Shut down shared session -> socket cleaned up, standalone check still works
      abortController.abort();
      const exitCode = await sessionPromise;
      assert.equal(exitCode, 0, harness.getStderr());
      assert.equal(harness.getStderr(), "");
      assert.equal(harness.records.at(-1)?.kind, "streamSuccess");
      assert.equal(existsSync(socketPath), false);

      const afterCloseShared = await captureCliJson<CheckEnvelope>(
        ["check", "--session", socketPath, "--output", "json"],
        tmpdir(),
      );
      assert.equal(afterCloseShared.status, 2);
      assert.equal(afterCloseShared.envelope.kind, "failure");

      const standaloneAfterClose = await captureCliJson<CheckEnvelope>(
        ["check", "--config", configPath, "--output", "json"],
        host.rootDir,
      );
      assert.equal(standaloneAfterClose.status, 0);
      assert.equal(standaloneAfterClose.envelope.kind, "data");
      assert.deepEqual(standaloneAfterClose.envelope.data, recovered);
    },
  );
});

void test("verule session text mode prints ready and shutdown lines and exits 2 on missing config", async () => {
  await withCliTempHost({ host: "integration/session-text" }, async (host) => {
    await host.typecheck();

    const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-sock-text-"));
    const socketPath = join(socketDir, "text.sock");
    const abortController = new AbortController();

    host.addCleanup(() => {
      abortController.abort();
      rmSync(socketDir, { recursive: true, force: true });
    });

    const missingRes = await captureCli(
      ["session", "--config", "missing.config.ts", "--socket", socketPath],
      host.rootDir,
    );
    assert.equal(missingRes.status, 2);
    assert.match(missingRes.stderr, /Session failed/u);
    assert.equal(existsSync(socketPath), false);

    let stdout = "";
    let stderr = "";
    const sessionPromise = runCli({
      identity: TEST_CLI_IDENTITY,
      cwd: host.rootDir,
      argv: ["node", "verule", "session", "--socket", socketPath],
      signal: abortController.signal,
      write: ({ destination, chunk }) => {
        if (destination === "stdout") stdout += chunk;
        else stderr += chunk;
      },
    });

    const deadline = Date.now() + 5_000;
    while (!stdout.includes("Shared session ready") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(stdout, /Shared session ready at/u);

    abortController.abort();
    const code = await sessionPromise;
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Shared session stopped\./u);
    assert.equal(existsSync(socketPath), false);
  });
});
