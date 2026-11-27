import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import {
  TEST_CLI_IDENTITY,
  captureCli,
  captureCliJson,
  createNdjsonStreamHarness,
} from "./cli-test-helpers.ts";

type StreamRecord =
  | {
      readonly kind: "stream";
      readonly command: string;
      readonly outputMode: string;
    }
  | {
      readonly kind: "record";
      readonly variant: "ready";
      readonly data: {
        readonly endpoint: string;
        readonly snapshotId: number;
      };
    }
  | {
      readonly kind: "record";
      readonly variant: "report";
      readonly data: CheckData & {
        readonly sequence: number;
        readonly trigger: "initial" | "change";
        readonly recomputation: {
          readonly recomputedProjects: readonly string[];
          readonly reusedProjects: readonly string[];
          readonly invalidatedBy: readonly string[];
        };
      };
    }
  | {
      readonly kind: "record";
      readonly variant: "failed";
      readonly data: {
        readonly sequence: number;
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly kind: "streamSuccess";
    };

type CheckData = {
  readonly reportVersion: string;
  readonly status: "clean" | "findings";
  readonly projects: readonly {
    readonly projectId: string;
    readonly sourceFiles: readonly string[];
  }[];
  readonly fileOrigins: readonly {
    readonly file: string;
  }[];
  readonly additionalInputs: readonly {
    readonly file: string;
    readonly exists: boolean;
    readonly digest?: string;
    readonly sources: readonly (
      | { readonly kind: "config" }
      | { readonly kind: "rule"; readonly id: string }
    )[];
  }[];
  readonly diagnostics: readonly {
    readonly id: string;
    readonly ruleId: string;
    readonly at: { readonly file: string; readonly line: number };
    readonly message: string;
    readonly evidence: readonly unknown[];
    readonly projects: readonly string[];
  }[];
  readonly gaps: readonly unknown[];
  readonly identity: unknown;
};

type CheckEnvelope = {
  readonly kind: "data" | "failure";
  readonly variant: string;
  readonly data: CheckData;
};

void test("verule session, check --session, and watch update diagnostics immediately when only allowed-packages.json changes", async () => {
  await withCliTempHost(
    { host: "integration/additional-inputs" },
    async (host) => {
      await host.typecheck();

      const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-add-sock-"));
      const socketPath = join(socketDir, "shared.sock");
      const configPath = host.resolvePath("verule.config.ts");
      const sessionAbort = new AbortController();
      const watchAbort = new AbortController();

      host.addCleanup(() => {
        sessionAbort.abort();
        watchAbort.abort();
        rmSync(socketDir, { recursive: true, force: true });
      });

      async function queryAndCompare(expectedStatus: 0 | 1) {
        const sharedRes = await captureCliJson<CheckEnvelope>(
          ["check", "--session", socketPath, "--output", "json"],
          tmpdir(),
        );
        assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);
        assert.equal(sharedRes.envelope.kind, "data");

        const coldRes = await captureCliJson<CheckEnvelope>(
          ["check", "--config", configPath, "--output", "json"],
          host.rootDir,
        );
        assert.equal(coldRes.status, expectedStatus, coldRes.stderr);
        assert.equal(coldRes.envelope.kind, "data");

        assert.deepEqual(sharedRes.envelope.data, coldRes.envelope.data);
        assert.deepEqual(sharedRes.envelope.data.projects[0]?.sourceFiles, [
          "src/app.ts",
        ]);
        assert.deepEqual(
          sharedRes.envelope.data.fileOrigins.map((o) => o.file),
          ["src/app.ts"],
        );
        assert.equal(sharedRes.envelope.data.additionalInputs.length, 1);
        assert.equal(
          sharedRes.envelope.data.additionalInputs[0]?.file,
          "allowed-packages.json",
        );
        assert.deepEqual(sharedRes.envelope.data.additionalInputs[0]?.sources, [
          { kind: "config" },
          { kind: "rule", id: "allowed-package-auditor" },
          { kind: "rule", id: "allowed-package-check" },
        ]);
        return sharedRes.envelope.data;
      }

      // 1. Start explicit shared session
      const sessionHarness = createNdjsonStreamHarness<StreamRecord>();
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
        signal: sessionAbort.signal,
        write: sessionHarness.write,
      });

      await sessionHarness.waitFor(
        (r) => r.kind === "record" && r.variant === "ready",
      );
      assert.equal(existsSync(socketPath), true);

      // 2. Initial clean state
      await queryAndCompare(0);

      // Text output displays merged additional input and all sources
      const textCheck = await captureCli(
        ["check", "--session", socketPath],
        tmpdir(),
      );
      assert.equal(textCheck.status, 0, textCheck.stderr);
      assert.match(textCheck.stdout, /Additional inputs \(1\):/u);
      assert.match(
        textCheck.stdout,
        /allowed-packages\.json <- config, rule:allowed-package-auditor, rule:allowed-package-check/u,
      );

      // 3. Edit ONLY allowed-packages.json -> immediate query -> exit 1
      host.writeText(
        "allowed-packages.json",
        JSON.stringify({ allowed: ["lodash"] }, null, 2),
      );
      const findingsReport = await queryAndCompare(1);
      assert.equal(findingsReport.diagnostics.length, 1);
      assert.equal(findingsReport.diagnostics[0]?.at.file, "src/app.ts");
      assert.equal(findingsReport.diagnostics[0]?.at.line, 3);

      // 4. Restore ONLY allowed-packages.json -> immediate query -> exit 0 (retracted)
      host.writeText(
        "allowed-packages.json",
        JSON.stringify({ allowed: ["zod"] }, null, 2),
      );
      const cleanReport = await queryAndCompare(0);
      assert.equal(cleanReport.diagnostics.length, 0);

      sessionAbort.abort();
      const sessionCode = await sessionPromise;
      assert.equal(sessionCode, 0, sessionHarness.getStderr());
      assert.equal(existsSync(socketPath), false);

      // 5. Verify verule watch pushes updated complete reports on manifest edits
      const watchHarness = createNdjsonStreamHarness<StreamRecord>();
      const watchPromise = runCli({
        identity: TEST_CLI_IDENTITY,
        cwd: host.rootDir,
        argv: [
          "node",
          "verule",
          "watch",
          "--config",
          configPath,
          "--output",
          "ndjson",
        ],
        signal: watchAbort.signal,
        write: watchHarness.write,
      });

      const w1 = await watchHarness.waitFor(
        (r) =>
          r.kind === "record" &&
          r.variant === "report" &&
          r.data.sequence === 1,
      );
      assert.equal(w1.kind, "record");
      assert.equal(w1.variant, "report");
      assert.equal(w1.data.status, "clean");

      host.writeText(
        "allowed-packages.json",
        JSON.stringify({ allowed: ["lodash"] }, null, 2),
      );
      const w2 = await watchHarness.waitFor(
        (r) =>
          r.kind === "record" &&
          r.variant === "report" &&
          r.data.sequence === 2,
      );
      assert.equal(w2.kind, "record");
      assert.equal(w2.variant, "report");
      assert.equal(w2.data.status, "findings");
      assert.deepEqual(w2.data.diagnostics, findingsReport.diagnostics);
      assert.deepEqual(w2.data.projects[0]?.sourceFiles, ["src/app.ts"]);

      host.writeText(
        "allowed-packages.json",
        JSON.stringify({ allowed: ["zod"] }, null, 2),
      );
      const w3 = await watchHarness.waitFor(
        (r) =>
          r.kind === "record" &&
          r.variant === "report" &&
          r.data.sequence === 3,
      );
      assert.equal(w3.kind, "record");
      assert.equal(w3.variant, "report");
      assert.equal(w3.data.status, "clean");
      assert.deepEqual(w3.data.diagnostics, []);

      watchAbort.abort();
      const watchCode = await watchPromise;
      assert.equal(watchCode, 0, watchHarness.getStderr());
    },
  );
});
