import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempDisposableSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { after, before, describe, it } from "node:test";
import { pathToFileURL } from "node:url";

import type { CheckReport, VeruleConfig } from "@boringparts/verule";
import { copyDirectory } from "@verule/test-hosts";

import { spawnNdjsonProcess, withCliTempHost } from "../helpers/cli-hosts.ts";

async function importConfig(configPath: string): Promise<VeruleConfig> {
  const loaded = (await import(pathToFileURL(configPath).href)) as {
    default: VeruleConfig;
  };
  return loaded.default;
}

void describe("deployed CLI e2e", () => {
  let deployment: Disposable & { readonly path: string };
  let manifestVersion = "";
  let deployedSdkPackageDir = "";
  let entry = "";
  let sdk!: typeof import("@boringparts/verule");

  function invoke(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    return result;
  }

  before(() => {
    deployment = mkdtempDisposableSync(join(tmpdir(), "verule-cli-"));
    try {
      execFileSync(
        "pnpm",
        [
          "--filter",
          "@boringparts/verule",
          "deploy",
          "--prod",
          "--frozen-lockfile",
          deployment.path,
        ],
        { cwd: new URL("../../", import.meta.url), stdio: "pipe" },
      );
      const deployed = createRequire(join(deployment.path, "package.json"));
      const manifest = deployed("./package.json") as {
        bin: { verule: string };
        version: string;
      };
      const deployedSdkEntry = deployed.resolve("@boringparts/verule");
      assert.ok(
        deployedSdkEntry.startsWith(realpathSync(deployment.path) + sep),
      );
      manifestVersion = manifest.version;
      deployedSdkPackageDir = dirname(dirname(deployedSdkEntry));
      entry = join(deployment.path, manifest.bin.verule);
      sdk = deployed(
        "@boringparts/verule",
      ) as typeof import("@boringparts/verule");
    } catch (error) {
      deployment[Symbol.dispose]();
      throw error;
    }
  });

  after(() => {
    deployment?.[Symbol.dispose]();
  });

  void it("discovers version, help, schema, and rejects unknown flags", async () => {
    const result = invoke(tmpdir());
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(
      result.stdout,
      `verule ${manifestVersion} (engine ${await sdk.getEngineVersion()})\n`,
    );

    const version = invoke(tmpdir(), "--version");
    assert.equal(version.status, 0, version.stderr);
    assert.equal(version.stdout, `verule ${manifestVersion}\n`);

    const help = invoke(tmpdir(), "--help");
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /--schema/u);
    assert.match(help.stdout, /check/u);
    assert.match(help.stdout, /watch/u);
    assert.match(help.stdout, /session/u);

    const schema = invoke(tmpdir(), "--schema");
    assert.equal(schema.status, 0, schema.stderr);
    assert.partialDeepStrictEqual(JSON.parse(schema.stdout), {
      command: "verule",
    });

    const invalid = invoke(tmpdir(), "--unknown");
    assert.equal(invalid.status, 2);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /--unknown/u);
  });

  void it("runs check, rules, SDK parity, UTF-16/UTF-8 locations, explain, observation truncation, and failure modes", async (t) => {
    await withCliTempHost(
      { host: "e2e/basic", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        await host.typecheck();

        // 1. Default zero rules
        const cleanText = invoke(host.rootDir, "check");
        assert.equal(cleanText.status, 0, cleanText.stderr);
        assert.match(cleanText.stdout, /No violations found/u);

        const cleanJson = invoke(host.rootDir, "check", "--output", "json");
        assert.equal(cleanJson.status, 0, cleanJson.stderr);
        const cleanEnvelope = JSON.parse(cleanJson.stdout) as {
          kind: string;
          variant: string;
          data: {
            reportVersion: string;
            status: string;
            diagnostics: unknown[];
            observation?: unknown;
            metrics?: unknown;
          };
        };
        assert.equal(cleanEnvelope.kind, "data");
        assert.equal(cleanEnvelope.variant, "clean");
        assert.equal(cleanEnvelope.data.reportVersion, "1");
        assert.equal(cleanEnvelope.data.status, "clean");
        assert.deepEqual(cleanEnvelope.data.diagnostics, []);
        assert.equal("observation" in cleanEnvelope.data, false);
        assert.equal("metrics" in cleanEnvelope.data, false);

        // 2. Two rules sharing one session + cold check E2E timing + SDK/CLI parity + UTF-16/UTF-8 offsets
        const rulesConfigPath = host.resolvePath("verule.rules.config.ts");
        const coldStartMs = performance.now();
        const findingsJson = invoke(
          host.rootDir,
          "check",
          "--config",
          rulesConfigPath,
          "--output",
          "json",
        );
        const coldDurationMs = performance.now() - coldStartMs;
        t.diagnostic(
          `Cold check E2E (deployed CLI + fresh engine + 2 rules): ${coldDurationMs.toFixed(2)} ms`,
        );

        assert.equal(findingsJson.status, 1, findingsJson.stderr);
        const findingsEnvelope = JSON.parse(findingsJson.stdout) as {
          kind: string;
          variant: string;
          data: CheckReport;
        };
        assert.equal(findingsEnvelope.kind, "data");
        assert.equal(findingsEnvelope.variant, "findings");
        assert.equal(findingsEnvelope.data.diagnostics.length, 2);

        const handlersSource = host.readText("src/handlers.ts");
        const firstDiagAt = findingsEnvelope.data.diagnostics[0]!.at;
        assert.equal(firstDiagAt.line, 11);
        assert.equal(firstDiagAt.column, 12);
        assert.equal(
          Buffer.from(handlersSource, "utf8")
            .subarray(firstDiagAt.start, firstDiagAt.end)
            .toString("utf8"),
          "sink(mode, input)",
        );

        const findingsText = invoke(
          host.rootDir,
          "check",
          "--config",
          rulesConfigPath,
        );
        assert.equal(findingsText.status, 1);
        assert.match(findingsText.stdout, /host-narrowed-string/u);
        assert.match(findingsText.stdout, /host-fast-mode/u);

        const sdkReport = await sdk.runCheck({
          cwd: host.rootDir,
          config: await importConfig(rulesConfigPath),
        });
        assert.deepEqual(findingsEnvelope.data, sdkReport);

        // 3. Deployed CLI explain + observation overhead comparison & truncation
        const explainConfigPath = host.resolvePath("verule.explain.config.ts");
        const explainMarkerPath = host.resolvePath(
          "checkpoint-detail-marker.txt",
        );

        const offStartMs = performance.now();
        const offExplainRes = invoke(
          host.rootDir,
          "check",
          "--config",
          explainConfigPath,
          "--output",
          "json",
        );
        const offWallMs = performance.now() - offStartMs;
        assert.equal(offExplainRes.status, 1, offExplainRes.stderr);
        const offExplainEnv = JSON.parse(offExplainRes.stdout) as {
          data: CheckReport;
        };
        assert.equal("observation" in offExplainEnv.data, false);
        assert.equal(existsSync(explainMarkerPath), false);

        const detailStartMs = performance.now();
        const detailExplainRes = invoke(
          host.rootDir,
          "check",
          "--config",
          explainConfigPath,
          "--observe",
          "detail",
          "--output",
          "json",
        );
        const detailWallMs = performance.now() - detailStartMs;
        assert.equal(detailExplainRes.status, 1, detailExplainRes.stderr);
        const detailExplainEnv = JSON.parse(detailExplainRes.stdout) as {
          data: CheckReport;
        };
        assert.equal(existsSync(explainMarkerPath), true);
        assert.equal(detailExplainEnv.data.status, offExplainEnv.data.status);
        assert.deepEqual(
          detailExplainEnv.data.diagnostics,
          offExplainEnv.data.diagnostics,
        );
        assert.deepEqual(detailExplainEnv.data.gaps, offExplainEnv.data.gaps);
        assert.ok(detailExplainEnv.data.observation);
        assert.equal(detailExplainEnv.data.observation.mode, "detail");
        assert.ok(detailExplainEnv.data.observation.rpc.batches >= 2);
        assert.ok(detailExplainEnv.data.observation.rpc.bytesSent > 0);
        assert.ok(detailExplainEnv.data.observation.rpc.bytesReceived > 0);
        assert.ok(detailExplainEnv.data.observation.overhead.checkpointMs >= 0);
        assert.ok(detailExplainEnv.data.observation.overhead.encodeMs >= 0);
        assert.ok(detailExplainEnv.data.observation.overhead.writeMs >= 0);
        t.diagnostic(
          `Deployed CLI observe off=${offWallMs.toFixed(2)}ms vs detail=${detailWallMs.toFixed(2)}ms (checkpoint=${detailExplainEnv.data.observation.overhead.checkpointMs}ms, encode=${detailExplainEnv.data.observation.overhead.encodeMs}ms, write=${detailExplainEnv.data.observation.overhead.writeMs}ms)`,
        );

        const truncatedRes = invoke(
          host.rootDir,
          "check",
          "--config",
          explainConfigPath,
          "--observe",
          "detail",
          "--observe-limit",
          "1",
          "--output",
          "json",
        );
        assert.equal(truncatedRes.status, 1, truncatedRes.stderr);
        const truncatedEnv = JSON.parse(truncatedRes.stdout) as {
          data: CheckReport;
        };
        assert.equal(truncatedEnv.data.observation?.truncated, true);
        assert.ok((truncatedEnv.data.observation?.droppedCount ?? 0) >= 1);
        assert.equal(truncatedEnv.data.observation?.details?.length, 1);

        const explainedRes = invoke(
          host.rootDir,
          "check",
          "--config",
          explainConfigPath,
          "--rule",
          "host-explainable-string",
          "--at",
          "src/handlers.ts:14:12",
          "--output",
          "json",
        );
        assert.equal(explainedRes.status, 1, explainedRes.stderr);
        const explainedEnv = JSON.parse(explainedRes.stdout) as {
          data: CheckReport;
        };
        assert.equal(
          explainedEnv.data.explanation?.status,
          "excluded_by_checkpoint",
        );
        assert.equal(explainedEnv.data.explanation?.inCandidates, true);
        assert.equal(
          explainedEnv.data.explanation?.excludedByCheckpoint?.name,
          "require-string-arg",
        );

        // 4. Failure paths -> exit 2 in text and json modes
        const missingConfig = invoke(
          host.rootDir,
          "check",
          "--config",
          "does-not-exist.ts",
        );
        assert.equal(missingConfig.status, 2);
        assert.match(missingConfig.stderr, /Check failed/u);

        const failedJson = invoke(
          host.rootDir,
          "check",
          "--config",
          host.resolvePath("verule.throwing.config.ts"),
          "--output",
          "json",
        );
        assert.equal(failedJson.status, 2);
        const failedEnvelope = JSON.parse(failedJson.stderr) as {
          kind: string;
          variant: string;
          data: { code: string; message: string };
        };
        assert.equal(failedEnvelope.kind, "failure");
        assert.equal(failedEnvelope.variant, "failed");
        assert.equal(failedEnvelope.data.code, "RULE_EXECUTION_ERROR");

        host.writeText("tsconfig.json", "{ invalid json");
        const brokenTsconfigJson = invoke(
          host.rootDir,
          "check",
          "--output",
          "json",
        );
        assert.equal(brokenTsconfigJson.status, 2);
        const brokenEnvelope = JSON.parse(brokenTsconfigJson.stderr) as {
          kind: string;
          variant: string;
          data: { code: string };
        };
        assert.equal(brokenEnvelope.kind, "failure");
        assert.equal(brokenEnvelope.variant, "failed");
        assert.equal(brokenEnvelope.data.code, "PROJECT_LOAD_ERROR");
      },
    );
  });

  void it("evaluates branch coverage and reports clean-with-gaps after removing violations", async () => {
    await withCliTempHost(
      { host: "e2e/branch-coverage", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        await host.typecheck();

        const branchFindingsJson = invoke(
          host.rootDir,
          "check",
          "--output",
          "json",
        );
        assert.equal(branchFindingsJson.status, 1, branchFindingsJson.stderr);
        const branchEnvelope = JSON.parse(branchFindingsJson.stdout) as {
          kind: string;
          variant: string;
          data: CheckReport;
        };
        assert.equal(branchEnvelope.kind, "data");
        assert.equal(branchEnvelope.variant, "findings");
        assert.equal(branchEnvelope.data.diagnostics.length, 2);
        assert.deepEqual(
          branchEnvelope.data.diagnostics.map((d) => ({
            line: d.at.line,
            message: d.message,
          })),
          [
            {
              line: 13,
              message: "runAction() can bypass required authorization branch.",
            },
            {
              line: 33,
              message:
                "runAction() is unreachable from function entry and cannot be verified as covered.",
            },
          ],
        );
        assert.ok(
          branchEnvelope.data.diagnostics[0]!.evidence.some((e) =>
            e.message.includes("false branch"),
          ),
        );
        assert.equal(branchEnvelope.data.gaps.length, 1);
        assert.equal(branchEnvelope.data.gaps[0]!.kind, "unmodeled-try-catch");
        assert.equal(branchEnvelope.data.gaps[0]!.at?.line, 37);

        const branchFindingsText = invoke(host.rootDir, "check");
        assert.equal(branchFindingsText.status, 1);
        assert.match(branchFindingsText.stdout, /host-auth-branch-coverage/u);
        assert.match(branchFindingsText.stdout, /gap \[unmodeled-try-catch\]/u);
        assert.match(
          branchFindingsText.stdout,
          /Found 2 violation\(s\) \(1 gap\(s\)\)/u,
        );

        const branchSdkReport = await sdk.runCheck({
          cwd: host.rootDir,
          config: await importConfig(host.resolvePath("verule.config.ts")),
        });
        assert.deepEqual(branchEnvelope.data, branchSdkReport);

        // Clean-with-gaps check: only covered + unmodeled try/catch -> exit 0 while still reporting gaps
        host.writeText(
          "src/routes.ts",
          host.readText("variants/routes-clean.ts"),
        );

        const cleanWithGapJson = invoke(
          host.rootDir,
          "check",
          "--output",
          "json",
        );
        assert.equal(cleanWithGapJson.status, 0, cleanWithGapJson.stderr);
        const cleanWithGapEnvelope = JSON.parse(cleanWithGapJson.stdout) as {
          kind: string;
          variant: string;
          data: CheckReport;
        };
        assert.equal(cleanWithGapEnvelope.variant, "clean");
        assert.equal(cleanWithGapEnvelope.data.diagnostics.length, 0);
        assert.equal(cleanWithGapEnvelope.data.gaps.length, 1);
        assert.equal(
          cleanWithGapEnvelope.data.gaps[0]!.kind,
          "unmodeled-try-catch",
        );

        const cleanWithGapText = invoke(host.rootDir, "check");
        assert.equal(cleanWithGapText.status, 0, cleanWithGapText.stderr);
        assert.match(
          cleanWithGapText.stdout,
          /No violations found.*1 gap\(s\)/u,
        );
        assert.match(cleanWithGapText.stdout, /gap \[unmodeled-try-catch\]/u);
      },
    );
  });

  void it("analyzes multi-project aggregate configs with divergent @runtime paths", async () => {
    await withCliTempHost(
      { host: "e2e/multi-project", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        await host.typecheck("packages/web/tsconfig.json");
        await host.typecheck("packages/node/tsconfig.json");

        const multiJson = invoke(host.rootDir, "check", "--output", "json");
        assert.equal(multiJson.status, 1, multiJson.stderr);
        const multiEnvelope = JSON.parse(multiJson.stdout) as {
          kind: string;
          variant: string;
          data: CheckReport;
        };
        assert.equal(multiEnvelope.kind, "data");
        assert.equal(multiEnvelope.variant, "findings");
        assert.equal(multiEnvelope.data.projects.length, 3);
        assert.equal(multiEnvelope.data.diagnostics.length, 3);
        assert.deepEqual(
          multiEnvelope.data.diagnostics.find(
            (d) => d.message === "Shared sink call",
          )?.projects,
          ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
        );

        const multiText = invoke(host.rootDir, "check");
        assert.equal(multiText.status, 1);
        assert.match(
          multiText.stdout,
          /tsconfig\.json -> packages\/web\/tsconfig\.json/u,
        );
        assert.match(
          multiText.stdout,
          /\[projects: packages\/node\/tsconfig\.json, packages\/web\/tsconfig\.json\]/u,
        );

        const multiSdkReport = await sdk.runCheck({
          cwd: host.rootDir,
          config: await importConfig(host.resolvePath("verule.config.ts")),
        });
        assert.deepEqual(multiEnvelope.data, multiSdkReport);
      },
    );
  });

  void it("propagates values across mixed TS/JS modules and reports dynamic callee gaps", async () => {
    await withCliTempHost(
      { host: "e2e/mixed-ts-js", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        await host.typecheck();

        const mixedHostJson = invoke(host.rootDir, "check", "--output", "json");
        assert.equal(mixedHostJson.status, 1, mixedHostJson.stderr);
        const mixedHostEnv = JSON.parse(mixedHostJson.stdout) as {
          variant: string;
          data: CheckReport;
        };
        assert.equal(mixedHostEnv.variant, "findings");
        assert.equal(mixedHostEnv.data.diagnostics.length, 1);
        assert.ok(
          mixedHostEnv.data.diagnostics[0]!.evidence.some(
            (e) => e.at?.file === "src/bridge.js",
          ),
        );
        assert.ok(
          mixedHostEnv.data.diagnostics[0]!.evidence.some(
            (e) => e.at?.file === "src/sink.ts",
          ),
        );
        assert.equal(mixedHostEnv.data.gaps.length, 1);
        assert.equal(mixedHostEnv.data.gaps[0]!.kind, "dynamic-callee");
        assert.equal("observation" in mixedHostEnv.data, false);
      },
    );
  });

  void it("streams watch NDJSON updates across source edits, broken config recovery, and SIGINT", async () => {
    await withCliTempHost(
      { host: "e2e/basic", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        const rulesConfigPath = host.resolvePath("verule.rules.config.ts");
        const watchSession = spawnNdjsonProcess(
          entry,
          ["watch", "--config", rulesConfigPath, "--output", "ndjson"],
          host.rootDir,
        );

        try {
          await watchSession.waitForRecord((r) => r.kind === "stream");
          const rec1 = await watchSession.waitForRecord(
            (r) =>
              r.kind === "record" &&
              r.variant === "report" &&
              (r.data as { sequence?: number }).sequence === 1,
          );
          assert.equal(
            (rec1.data as Record<string, unknown>).status,
            "findings",
          );

          // Edit src/handlers.ts to clean state -> watch emits clean report matching cold check
          host.writeText(
            "src/handlers.ts",
            host.readText("variants/handlers-clean.ts"),
          );
          const rec2 = await watchSession.waitForRecord(
            (r) =>
              r.kind === "record" &&
              r.variant === "report" &&
              (r.data as { sequence?: number }).sequence === 2,
          );
          const rec2Data = rec2.data as Record<string, unknown>;
          assert.equal(rec2Data.status, "clean");
          const coldClean = invoke(
            host.rootDir,
            "check",
            "--config",
            rulesConfigPath,
            "--output",
            "json",
          );
          assert.equal(coldClean.status, 0, coldClean.stderr);
          const coldCleanData = (
            JSON.parse(coldClean.stdout) as { data: Record<string, unknown> }
          ).data;
          assert.deepEqual(rec2Data.diagnostics, coldCleanData.diagnostics);
          assert.deepEqual(rec2Data.identity, coldCleanData.identity);

          // Break config temporarily -> failed record without exit, then restore -> recovers
          const validRulesConfig = host.readText("verule.rules.config.ts");
          host.writeText("verule.rules.config.ts", "export default { broken(");
          const rec3 = await watchSession.waitForRecord(
            (r) =>
              r.kind === "record" &&
              r.variant === "failed" &&
              (r.data as { sequence?: number }).sequence === 3,
          );
          assert.equal((rec3.data as { code?: string }).code, "INVALID_CONFIG");

          host.writeText("verule.rules.config.ts", validRulesConfig);
          const rec4 = await watchSession.waitForRecord(
            (r) =>
              r.kind === "record" &&
              r.variant === "report" &&
              (r.data as { sequence?: number }).sequence === 4,
          );
          assert.equal((rec4.data as { status?: string }).status, "clean");

          // SIGINT triggers clean shutdown with streamSuccess and exit code 0
          const exitResult = await watchSession.stopWithSigint();
          assert.equal(exitResult.code, 0, exitResult.stderr);
          assert.equal(exitResult.stderr, "");
          assert.equal(watchSession.records.at(-1)?.kind, "streamSuccess");
        } finally {
          watchSession.dispose();
        }
      },
    );
  });

  void it("serves cross-process shared session across edits, broken config recovery, and SIGINT", async (t) => {
    await withCliTempHost(
      { host: "e2e/basic", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        using sessionSocketDir = mkdtempDisposableSync(
          join(tmpdir(), "verule-e2e-sock-"),
        );
        const sharedSocketPath = join(sessionSocketDir.path, "verule.sock");
        const rulesConfigPath = host.resolvePath("verule.rules.config.ts");
        const initialHandlers = host.readText("src/handlers.ts");
        const cleanHandlers = host.readText("variants/handlers-clean.ts");

        const sessionProc = spawnNdjsonProcess(
          entry,
          [
            "session",
            "--config",
            rulesConfigPath,
            "--socket",
            sharedSocketPath,
            "--output",
            "ndjson",
          ],
          host.rootDir,
        );

        function invokeAndCompareShared(label: string, expectedStatus: 0 | 1) {
          const t0 = performance.now();
          const sharedRes = invoke(
            tmpdir(),
            "check",
            "--session",
            sharedSocketPath,
            "--output",
            "json",
          );
          const sharedMs = performance.now() - t0;
          t.diagnostic(
            `Deployed cross-process check --session (${label}): ${sharedMs.toFixed(2)} ms`,
          );
          assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);

          const coldRes = invoke(
            host.rootDir,
            "check",
            "--config",
            rulesConfigPath,
            "--output",
            "json",
          );
          assert.equal(coldRes.status, expectedStatus, coldRes.stderr);

          const sharedData = (
            JSON.parse(sharedRes.stdout) as { data: CheckReport }
          ).data;
          const coldData = (JSON.parse(coldRes.stdout) as { data: CheckReport })
            .data;
          assert.deepEqual(sharedData, coldData);
          return sharedData;
        }

        try {
          await sessionProc.waitForRecord((r) => r.kind === "stream");
          const readyRec = await sessionProc.waitForRecord(
            (r) => r.kind === "record" && r.variant === "ready",
          );
          assert.equal(
            (readyRec.data as { endpoint?: string }).endpoint,
            sharedSocketPath,
          );
          assert.equal(existsSync(sharedSocketPath), true);

          // Initial findings via second process
          const initialFindings = invokeAndCompareShared("initial-findings", 1);
          assert.equal(initialFindings.diagnostics.length, 2);

          // Fix violation -> immediately query from second process (0ms sleep) -> retracted
          host.writeText("src/handlers.ts", cleanHandlers);
          const cleanReport = invokeAndCompareShared("immediate-fix", 0);
          assert.equal(cleanReport.diagnostics.length, 0);

          // Reintroduce violation -> immediately query from second process
          host.writeText("src/handlers.ts", initialHandlers);
          const findingsReport = invokeAndCompareShared(
            "immediate-violation",
            1,
          );
          assert.equal(findingsReport.diagnostics.length, 2);

          // Break config -> client gets exit 2 while session stays alive -> restore -> recovers
          const validRulesConfig = host.readText("verule.rules.config.ts");
          host.writeText("verule.rules.config.ts", "export default { broken(");
          const failedShared = invoke(
            tmpdir(),
            "check",
            "--session",
            sharedSocketPath,
            "--output",
            "json",
          );
          assert.equal(failedShared.status, 2);
          const failedEnv = JSON.parse(failedShared.stderr) as {
            kind: string;
            variant: string;
            data: { code: string };
          };
          assert.equal(failedEnv.kind, "failure");
          assert.equal(failedEnv.data.code, "INVALID_CONFIG");

          host.writeText("verule.rules.config.ts", validRulesConfig);
          invokeAndCompareShared("immediate-recover", 1);

          // SIGINT closes session, cleans socket, and standalone check still matches
          const sessionExit = await sessionProc.stopWithSigint();
          assert.equal(sessionExit.code, 0, sessionExit.stderr);
          assert.equal(sessionExit.stderr, "");
          assert.equal(sessionProc.records.at(-1)?.kind, "streamSuccess");
          assert.equal(existsSync(sharedSocketPath), false);

          const postCloseStandalone = invoke(
            host.rootDir,
            "check",
            "--config",
            rulesConfigPath,
            "--output",
            "json",
          );
          assert.equal(
            postCloseStandalone.status,
            1,
            postCloseStandalone.stderr,
          );
        } finally {
          sessionProc.dispose();
        }
      },
    );
  });

  void it("updates shared session immediately when additional inputs change", async () => {
    await withCliTempHost(
      { host: "e2e/additional-inputs", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        await host.typecheck();

        using manifestSockDir = mkdtempDisposableSync(
          join(tmpdir(), "verule-manifest-sock-"),
        );
        const manifestSocketPath = join(manifestSockDir.path, "manifest.sock");
        const manifestConfigPath = host.resolvePath("verule.config.ts");

        const manifestSession = spawnNdjsonProcess(
          entry,
          [
            "session",
            "--config",
            manifestConfigPath,
            "--socket",
            manifestSocketPath,
            "--output",
            "ndjson",
          ],
          host.rootDir,
        );

        function compareManifestRound(expectedStatus: 0 | 1) {
          const sharedRes = invoke(
            tmpdir(),
            "check",
            "--session",
            manifestSocketPath,
            "--output",
            "json",
          );
          assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);
          const coldRes = invoke(
            host.rootDir,
            "check",
            "--config",
            manifestConfigPath,
            "--output",
            "json",
          );
          assert.equal(coldRes.status, expectedStatus, coldRes.stderr);
          const sharedData = (
            JSON.parse(sharedRes.stdout) as { data: CheckReport }
          ).data;
          const coldData = (JSON.parse(coldRes.stdout) as { data: CheckReport })
            .data;
          assert.deepEqual(sharedData, coldData);
          assert.deepEqual(sharedData.projects[0]?.sourceFiles, ["src/app.ts"]);
          assert.deepEqual(
            sharedData.fileOrigins.map((o) => o.file),
            ["src/app.ts"],
          );
          assert.equal(sharedData.additionalInputs.length, 1);
          assert.deepEqual(sharedData.additionalInputs[0]?.sources, [
            { kind: "config" },
            { kind: "rule", id: "e2e-allowlist-auditor" },
            { kind: "rule", id: "e2e-allowlist-reader" },
          ]);
          return sharedData;
        }

        try {
          await manifestSession.waitForRecord(
            (r) => r.kind === "record" && r.variant === "ready",
          );
          compareManifestRound(0);

          // Edit only allowed-packages.json -> immediate query -> exit 1
          host.writeText(
            "allowed-packages.json",
            JSON.stringify({ allowed: ["lodash"] }, null, 2),
          );
          const findingsRound = compareManifestRound(1);
          assert.equal(findingsRound.diagnostics.length, 1);

          // Restore only allowed-packages.json -> immediate query -> exit 0
          host.writeText(
            "allowed-packages.json",
            JSON.stringify({ allowed: ["zod"] }, null, 2),
          );
          const cleanRound = compareManifestRound(0);
          assert.equal(cleanRound.diagnostics.length, 0);

          const exitRes = await manifestSession.stopWithSigint();
          assert.equal(exitRes.code, 0, exitRes.stderr);
          assert.equal(existsSync(manifestSocketPath), false);
        } finally {
          manifestSession.dispose();
        }
      },
    );
  });

  void it("supports third-party FactTypes, provider swapping, merging, and order-independent conflicts", async () => {
    await withCliTempHost(
      { host: "e2e/fact-providers", sdkPackageDir: deployedSdkPackageDir },
      async (host) => {
        await host.typecheck();

        const swapA = invoke(
          host.rootDir,
          "check",
          "--config",
          "verule.a.config.ts",
          "--output",
          "json",
        );
        const swapB = invoke(
          host.rootDir,
          "check",
          "--config",
          "verule.b.config.ts",
          "--output",
          "json",
        );
        assert.equal(swapA.status, 1, swapA.stderr);
        assert.equal(swapB.status, 1, swapB.stderr);
        assert.match(swapA.stdout, /\[provider-a\]/u);
        assert.match(swapB.stdout, /\[provider-b\]/u);

        const mergeAB = invoke(
          host.rootDir,
          "check",
          "--config",
          "verule.ab.config.ts",
          "--output",
          "json",
        );
        const mergeBA = invoke(
          host.rootDir,
          "check",
          "--config",
          "verule.ba.config.ts",
          "--output",
          "json",
        );
        assert.equal(mergeAB.status, 1, mergeAB.stderr);
        assert.equal(mergeBA.status, 1, mergeBA.stderr);
        assert.equal(mergeAB.stdout, mergeBA.stdout);
        assert.match(mergeAB.stdout, /\[provider-a, provider-b\]/u);

        const conflictAC = invoke(
          host.rootDir,
          "check",
          "--config",
          "verule.conflict.ac.config.ts",
          "--output",
          "json",
        );
        const conflictCA = invoke(
          host.rootDir,
          "check",
          "--config",
          "verule.conflict.ca.config.ts",
          "--output",
          "json",
        );
        assert.equal(conflictAC.status, 2);
        assert.equal(conflictCA.status, 2);
        assert.equal(conflictAC.stdout, "");
        assert.equal(conflictAC.stderr, conflictCA.stderr);
        const conflictEnv = JSON.parse(conflictAC.stderr) as {
          kind: string;
          data: {
            code: string;
            conflict: {
              parties: { providerId: string; conclusionSummary: string }[];
            };
          };
        };
        assert.equal(conflictEnv.kind, "failure");
        assert.equal(conflictEnv.data.code, "FACT_CONFLICT");
        assert.deepEqual(
          conflictEnv.data.conflict.parties.map((p) => [
            p.providerId,
            p.conclusionSummary,
          ]),
          [
            ["provider-a", "id=required"],
            ["provider-conflict", "id=optional"],
          ],
        );
      },
    );
  });

  void it("resolves conditional ESM/CJS exports and falls back to declaration-only gaps", async () => {
    await withCliTempHost(
      {
        host: "e2e/package-behavior",
        sdkPackageDir: deployedSdkPackageDir,
        setup: (host) => {
          copyDirectory(
            host.resolvePath("deps/dual-pkg"),
            host.resolvePath("node_modules/dual-pkg"),
          );
          host.removePath("deps");
        },
      },
      async (host) => {
        await host.typecheck("packages/esm/tsconfig.json");
        await host.typecheck("packages/cjs/tsconfig.json");

        const pkgCheck1 = invoke(host.rootDir, "check", "--output", "json");
        assert.equal(pkgCheck1.status, 1, pkgCheck1.stderr);
        const pkgData1 = (JSON.parse(pkgCheck1.stdout) as { data: CheckReport })
          .data;
        assert.equal(pkgData1.diagnostics.length, 1);
        assert.equal(
          pkgData1.diagnostics[0]!.at.file,
          "packages/cjs/src/app.ts",
        );
        assert.ok(
          pkgData1.diagnostics[0]!.evidence.some(
            (e) => e.at?.file === "node_modules/dual-pkg/lib/index.cjs",
          ),
        );
        assert.ok(
          pkgData1.fileOrigins.every((o) => !o.file.includes("node_modules/")),
        );

        host.removePath("node_modules/dual-pkg/lib/index.mjs");
        host.removePath("node_modules/dual-pkg/lib/index.cjs");
        const pkgCheck2 = invoke(host.rootDir, "check", "--output", "json");
        assert.equal(pkgCheck2.status, 0, pkgCheck2.stderr);
        const pkgData2 = (JSON.parse(pkgCheck2.stdout) as { data: CheckReport })
          .data;
        assert.ok(
          pkgData2.gaps.some((g) => g.kind === "missing-instance-model"),
        );
        assert.ok(
          pkgData2.gaps.some(
            (g) => g.kind === "missing-package-implementation",
          ),
        );
      },
    );
  });
});
