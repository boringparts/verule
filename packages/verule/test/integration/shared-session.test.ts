import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { runCliScenario } from "@boringparts/cli-contract/testing";

import { runCli } from "../../src/main.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import {
  TEST_CLI_IDENTITY,
  createNdjsonStreamHarness,
  testCliContract,
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

async function runCheckScenarioData(
  argv: readonly string[],
  cwd: string,
  expectedStatus: 0 | 1,
) {
  const obs = await runCliScenario(testCliContract, {
    argv,
    dependencies: { cwd },
  });
  assert.ok(obs.termination.kind === "applicationResult", obs.stderr);
  assert.equal(obs.termination.exitCode, expectedStatus, obs.stderr);
  assert.ok(obs.termination.result.kind === "data", obs.stderr);
  assert.ok(obs.termination.result.command === "check");
  return obs.termination.result.data;
}

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
        const sharedData = await runCheckScenarioData(
          ["check", "--session", socketPath, ...extraArgs, "--output", "json"],
          tmpdir(),
          expectedStatus,
        );
        const elapsedMs = performance.now() - start;
        t.diagnostic(`CLI shared query (${label}): ${elapsedMs.toFixed(2)}ms`);

        const coldData = await runCheckScenarioData(
          ["check", "--config", configPath, ...extraArgs, "--output", "json"],
          host.rootDir,
          expectedStatus,
        );

        assert.deepEqual(sharedData, coldData);
        return sharedData;
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

      // Cannot combine --session and --config (rejected by declarative usageConstraints)
      const invalidCombo = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--session",
          socketPath,
          "--config",
          configPath,
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(invalidCombo.termination.kind, "usageFailure");
      assert.equal(invalidCombo.termination.exitCode, 2);
      assert.equal(invalidCombo.termination.command, "check");
      assert.deepEqual(invalidCombo.termination.issues, [
        {
          code: "forbiddenCombinationViolation",
          facts: [
            { kind: "present", field: "session" },
            { kind: "present", field: "config" },
          ],
        },
      ]);
      assert.equal(invalidCombo.stdout, "");

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
      const textFindings = await runCliScenario(testCliContract, {
        argv: ["check", "--session", socketPath],
        dependencies: { cwd: tmpdir() },
      });
      assert.equal(textFindings.termination.exitCode, 1, textFindings.stderr);
      assert.match(textFindings.stdout, /disallow-mode/u);

      // Targeted explain & rule filter via --session
      const explainedData = await runCheckScenarioData(
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
        1,
      );
      assert.equal(explainedData.explanation?.status, "reported");

      // Observation mode via --session
      const observedData = await runCheckScenarioData(
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
        1,
      );
      assert.ok(observedData.observation);

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

      // 5. Config/policy reload & single-round failure recovery
      const savedConfig = host.readText("verule.config.ts");
      host.writeText("verule.config.ts", "export default { broken(");

      const brokenRes = await runCliScenario(testCliContract, {
        argv: ["check", "--session", socketPath, "--output", "json"],
        dependencies: { cwd: tmpdir() },
      });
      assert.ok(brokenRes.termination.kind === "applicationResult");
      assert.equal(brokenRes.termination.exitCode, 2);
      assert.ok(brokenRes.termination.result.kind === "failure");
      assert.ok(brokenRes.termination.result.command === "check");
      assert.equal(brokenRes.termination.result.data.code, "INVALID_CONFIG");

      // Restore config and update policy module -> recovers immediately
      host.writeText("verule.config.ts", savedConfig);
      host.replaceText(
        "verule.policy.ts",
        'version: "1",\n  disallowedMode: "fast",',
        'version: "2",\n  disallowedMode: "safe",',
      );
      const recovered = await queryAndCompare("recover-and-policy-reload", 0);
      assert.notEqual(
        recovered.identity.configDigest,
        findingsData.identity.configDigest,
      );

      // 6. Shut down shared session -> socket cleaned up, standalone check still works
      abortController.abort();
      const exitCode = await sessionPromise;
      assert.equal(exitCode, 0, harness.getStderr());
      assert.equal(harness.getStderr(), "");
      assert.equal(harness.records.at(-1)?.kind, "streamSuccess");
      assert.equal(existsSync(socketPath), false);

      const afterCloseShared = await runCliScenario(testCliContract, {
        argv: ["check", "--session", socketPath, "--output", "json"],
        dependencies: { cwd: tmpdir() },
      });
      assert.ok(afterCloseShared.termination.kind === "applicationResult");
      assert.equal(afterCloseShared.termination.exitCode, 2);
      assert.equal(afterCloseShared.termination.result.kind, "failure");

      const standaloneAfterClose = await runCheckScenarioData(
        ["check", "--config", configPath, "--output", "json"],
        host.rootDir,
        0,
      );
      assert.deepEqual(standaloneAfterClose, recovered);
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

    const missingRes = await runCliScenario(testCliContract, {
      argv: [
        "session",
        "--config",
        "missing.config.ts",
        "--socket",
        socketPath,
      ],
      dependencies: { cwd: host.rootDir },
    });
    assert.equal(missingRes.termination.exitCode, 2);
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
