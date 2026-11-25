import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import {
  TEST_CLI_IDENTITY,
  captureCli,
  createNdjsonStreamHarness,
} from "./cli-test-helpers.ts";

type NdjsonLine =
  | {
      readonly schemaVersion: string;
      readonly command: string;
      readonly outputMode: string;
      readonly kind: "stream";
    }
  | {
      readonly kind: "record";
      readonly variant: "report";
      readonly data: {
        readonly reportVersion: string;
        readonly status: "clean" | "findings";
        readonly projects: readonly unknown[];
        readonly fileOrigins: readonly unknown[];
        readonly additionalInputs: readonly unknown[];
        readonly diagnostics: readonly {
          readonly id: string;
          readonly ruleId: string;
          readonly at: { readonly file: string; readonly line: number };
          readonly message: string;
          readonly evidence: readonly unknown[];
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
        readonly sequence: number;
        readonly trigger: "initial" | "change";
        readonly snapshotId: number;
        readonly recomputation: {
          readonly recomputedProjects: readonly string[];
          readonly reusedProjects: readonly string[];
          readonly recomputedFiles: readonly string[];
          readonly reusedFiles: readonly string[];
          readonly removedFiles: readonly string[];
          readonly invalidatedBy: readonly string[];
        };
        readonly memory: {
          readonly hostRssBytes: number;
          readonly engineRssBytes?: number;
        };
      };
    }
  | {
      readonly kind: "record";
      readonly variant: "failed";
      readonly data: {
        readonly reportVersion: string;
        readonly sequence: number;
        readonly trigger: "initial" | "change";
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly kind: "streamSuccess";
    };

async function runColdJsonCheck(cwd: string, configArg?: string) {
  const { status, stdout, stderr } = await captureCli(
    [
      "check",
      ...(configArg ? ["--config", configArg] : []),
      "--output",
      "json",
    ],
    cwd,
  );
  assert.ok(
    status === 0 || status === 1,
    `unexpected check failure: ${stderr}`,
  );
  const envelope = JSON.parse(stdout) as {
    readonly kind: "data";
    readonly variant: "clean" | "findings";
    readonly data: {
      readonly reportVersion: string;
      readonly status: "clean" | "findings";
      readonly projects: readonly unknown[];
      readonly fileOrigins: readonly unknown[];
      readonly additionalInputs: readonly unknown[];
      readonly diagnostics: readonly unknown[];
      readonly gaps: readonly unknown[];
      readonly identity: unknown;
    };
  };
  return { status, data: envelope.data };
}

void test("verule watch --output ndjson aligns every round with independent verule check, reloads rules/models/config, and recovers from errors", async () => {
  await withCliTempHost({ host: "integration/watch-ndjson" }, async (host) => {
    await host.typecheck();
    await host.typecheck("tsconfig.alt.json");

    const harness = createNdjsonStreamHarness<NdjsonLine>();
    const abortController = new AbortController();
    host.addCleanup(() => {
      abortController.abort();
    });

    const watchPromise = runCli({
      identity: TEST_CLI_IDENTITY,
      cwd: host.rootDir,
      argv: ["node", "verule", "watch", "--output", "ndjson"],
      signal: abortController.signal,
      write: harness.write,
    });

    const header = await harness.waitFor((item) => item.kind === "stream");
    assert.equal(header.kind, "stream");

    async function assertMatchesColdCheck(
      seq: number,
      expectedStatus: "clean" | "findings",
    ) {
      const rec = await harness.waitFor(
        (item) =>
          item.kind === "record" &&
          item.variant === "report" &&
          item.data.sequence === seq,
      );
      assert.equal(rec.kind, "record");
      assert.equal(rec.variant, "report");
      assert.equal(rec.data.status, expectedStatus);
      assert.ok(rec.data.memory.hostRssBytes > 0);
      const cold = await runColdJsonCheck(host.rootDir);
      assert.deepEqual(
        {
          reportVersion: rec.data.reportVersion,
          status: rec.data.status,
          projects: rec.data.projects,
          fileOrigins: rec.data.fileOrigins,
          additionalInputs: rec.data.additionalInputs,
          diagnostics: rec.data.diagnostics,
          gaps: rec.data.gaps,
          identity: rec.data.identity,
        },
        cold.data,
      );
      return rec.data;
    }

    // 1. Initial clean state
    const r1 = await assertMatchesColdCheck(1, "clean");
    assert.equal(r1.trigger, "initial");

    // 2. Introduce violation
    const savedConsumer = host.readText("src/consumer.ts");
    host.replaceText(
      "src/consumer.ts",
      "return sink(getMode());",
      'void getMode();\n  return sink("fast");',
    );
    const r2 = await assertMatchesColdCheck(2, "findings");
    assert.equal(r2.diagnostics.length, 1);

    // 3. Fix violation (diagnostic retraction)
    host.writeText("src/consumer.ts", savedConsumer);
    const r3 = await assertMatchesColdCheck(3, "clean");
    assert.equal(r3.diagnostics.length, 0);

    // 4. Modify imported shared definition
    host.writeText(
      "src/shared.ts",
      'export function getMode(): "fast" {\n  return "fast";\n}\n',
    );
    const r4 = await assertMatchesColdCheck(4, "findings");
    assert.equal(r4.diagnostics.length, 1);

    // 5. Modify unrelated file -> reusedFiles preserves unaffected files
    host.writeText("src/unrelated.ts", "export const note = 2;\n");
    const r5 = await assertMatchesColdCheck(5, "findings");
    assert.ok(r5.recomputation.recomputedFiles.includes("src/unrelated.ts"));
    assert.ok(r5.recomputation.reusedFiles.includes("src/consumer.ts"));

    // 6. Single-round failure (invalid config) -> emits failed record without exiting, then recovers
    const savedConfig = host.readText("verule.config.ts");
    host.writeText("verule.config.ts", "export default { broken(");
    const f6 = await harness.waitFor(
      (item) =>
        item.kind === "record" &&
        item.variant === "failed" &&
        item.data.sequence === 6,
    );
    assert.equal(f6.kind, "record");
    assert.equal(f6.variant, "failed");
    assert.equal(f6.data.code, "INVALID_CONFIG");

    // Restore valid config -> recovers cleanly on round 7
    host.writeText("verule.config.ts", savedConfig);
    await assertMatchesColdCheck(7, "findings");

    // 7a. Modify imported model file -> reloads model and updates identity & findings
    host.replaceText(
      "verule.model.ts",
      'version: "1",\n  facts: { disallowedMode: "fast" },',
      'version: "2",\n  facts: { disallowedMode: "safe" },',
    );
    const r8 = await assertMatchesColdCheck(8, "clean");
    assert.equal(r8.identity.models[0]?.version, "2");

    // 7b. Modify imported rules file -> reloads rule
    host.writeText(
      "verule.rules.ts",
      host.readText("variants/verule.rules.v2.ts"),
    );
    const r9 = await assertMatchesColdCheck(9, "findings");
    assert.equal(r9.identity.rules[0]?.id, "disallow-mode-v2");

    // 7c. Modify config entry (switch tsconfig -> tsconfig.alt.json)
    host.writeText(
      "verule.config.ts",
      savedConfig.replace(
        'tsconfig: "tsconfig.json"',
        'projects: ["tsconfig.alt.json"]',
      ),
    );
    const r10 = await assertMatchesColdCheck(10, "findings");
    assert.equal(r10.diagnostics[0]?.at.file, "src/alt-only.ts");

    abortController.abort();
    const exitCode = await watchPromise;
    assert.equal(exitCode, 0, harness.getStderr());
    assert.equal(harness.getStderr(), "");
    assert.equal(harness.records.at(-1)?.kind, "streamSuccess");
  });
});

void test("verule watch text mode prints reports, handles failures, and stops cleanly on abort", async () => {
  await withCliTempHost({ host: "integration/watch-text" }, async (host) => {
    await host.typecheck();

    let stdout = "";
    let stderr = "";
    const abortController = new AbortController();
    host.addCleanup(() => {
      abortController.abort();
    });

    const watchPromise = runCli({
      identity: TEST_CLI_IDENTITY,
      cwd: host.rootDir,
      argv: ["node", "verule", "watch"],
      signal: abortController.signal,
      write: ({ destination, chunk }) => {
        if (destination === "stdout") stdout += chunk;
        else stderr += chunk;
      },
    });

    const deadline = Date.now() + 5_000;
    while (!stdout.includes("[watch #1]") && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    assert.match(stdout, /\[watch #1\].*No violations found/u);

    abortController.abort();
    const exitCode = await watchPromise;
    assert.equal(exitCode, 0, stderr);
    assert.match(stdout, /Watch stopped\./u);
  });
});
