import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { CliWriteError } from "@boringparts/cli-contract";
import {
  defineCommandScenarios,
  defineFailureScenarios,
  runCliScenario,
} from "@boringparts/cli-contract/testing";

import { getCliContract, runCli } from "../../src/main.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { TEST_CLI_IDENTITY, testCliContract } from "./cli-test-helpers.ts";

void test("treats a closed stdout pipe as a normal exit", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity: TEST_CLI_IDENTITY,
    argv: ["node", "verule", "--version"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw Object.assign(new Error("closed"), { code: "EPIPE" });
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(destinations, ["stdout"]);
});

void test("returns an execution failure even when its diagnostic cannot be written", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity: TEST_CLI_IDENTITY,
    argv: ["node", "verule", "--version"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw new Error("write failed");
    },
  });
  assert.equal(status, 2);
  assert.deepEqual(destinations, ["stdout", "stderr"]);
});

void test("does not retry a failed stderr write", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity: TEST_CLI_IDENTITY,
    argv: ["node", "verule", "--unknown"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw Object.assign(new Error("closed"), { code: "EPIPE" });
    },
  });
  assert.equal(status, 2);
  assert.deepEqual(destinations, ["stderr"]);
});

void test("memoizes CLI contracts per identity and runs bare command via runCli", async () => {
  assert.equal(
    getCliContract(TEST_CLI_IDENTITY),
    getCliContract({ ...TEST_CLI_IDENTITY }),
  );

  let stdout = "";
  let stderr = "";
  const bareStatus = await runCli({
    identity: TEST_CLI_IDENTITY,
    argv: ["node", "verule"],
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  assert.equal(bareStatus, 0, stderr);
  assert.equal(stderr, "");
  assert.match(stdout, /^verule 0\.0\.0 \(engine \d+\.\d+\.\d+\)\n$/u);
});

void test("rejects write failures in runCliScenario beforeWrite and cleans up stream resources", async () => {
  await assert.rejects(
    () =>
      runCliScenario(testCliContract, {
        argv: ["--version"],
        dependencies: { cwd: tmpdir() },
        beforeWrite: () => {
          throw Object.assign(new Error("closed"), { code: "EPIPE" });
        },
      }),
    (error: unknown) =>
      error instanceof CliWriteError && error.destination === "stdout",
  );

  await withCliTempHost({ host: "integration/session-text" }, async (host) => {
    const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-epipe-sock-"));
    const socketPath = join(socketDir, "epipe.sock");
    host.addCleanup(() => {
      rmSync(socketDir, { recursive: true, force: true });
    });

    await assert.rejects(
      () =>
        runCliScenario(testCliContract, {
          argv: ["session", "--socket", socketPath],
          dependencies: { cwd: host.rootDir },
          beforeWrite: ({ destination, chunk }) => {
            if (
              destination === "stdout" &&
              chunk.includes("Shared session ready")
            ) {
              throw Object.assign(new Error("closed"), { code: "EPIPE" });
            }
          },
        }),
      (error: unknown) =>
        error instanceof CliWriteError && error.destination === "stdout",
    );
    assert.equal(existsSync(socketPath), false);
  });
});

void test("covers all executable commands and declared failures via contract testing scenarios", async () => {
  await withCliTempHost({ host: "integration/command-basic" }, async (host) => {
    await host.typecheck();

    const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-scenarios-sock-"));
    const socketPath = join(socketDir, "scenario.sock");
    const watchAbort = new AbortController();
    const sessionAbort = new AbortController();
    host.addCleanup(() => {
      watchAbort.abort();
      sessionAbort.abort();
      rmSync(socketDir, { recursive: true, force: true });
    });

    const commandScenarios = defineCommandScenarios(testCliContract, {
      version: {
        argv: ["version"],
        dependencies: { cwd: host.rootDir },
      },
      check: {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      },
      watch: {
        argv: ["watch"],
        dependencies: { cwd: host.rootDir, signal: watchAbort.signal },
      },
      session: {
        argv: ["session", "--socket", socketPath],
        dependencies: { cwd: host.rootDir, signal: sessionAbort.signal },
      },
    });

    const versionObs = await runCliScenario(
      testCliContract,
      commandScenarios.version,
    );
    assert.equal(versionObs.termination.kind, "applicationResult");
    assert.equal(versionObs.termination.exitCode, 0);
    assert.equal(versionObs.termination.result.kind, "data");
    assert.equal(versionObs.termination.result.command, "version");
    assert.match(
      versionObs.stdout,
      /^verule 0\.0\.0 \(engine \d+\.\d+\.\d+\)\n$/u,
    );

    const checkObs = await runCliScenario(
      testCliContract,
      commandScenarios.check,
    );
    assert.equal(checkObs.termination.kind, "applicationResult");
    assert.equal(checkObs.termination.exitCode, 0);
    assert.equal(checkObs.termination.result.kind, "data");
    assert.equal(checkObs.termination.result.command, "check");
    assert.equal(checkObs.termination.result.variant, "clean");

    const watchObs = await runCliScenario(testCliContract, {
      ...commandScenarios.watch,
      beforeWrite: ({ destination, chunk }) => {
        if (destination === "stdout" && chunk.includes("[watch #1]")) {
          watchAbort.abort();
        }
      },
    });
    assert.equal(watchObs.termination.kind, "applicationResult");
    assert.equal(watchObs.termination.exitCode, 0);
    assert.equal(watchObs.termination.result.kind, "streamSuccess");
    assert.equal(watchObs.termination.result.command, "watch");
    assert.match(watchObs.stdout, /Watch stopped\./u);

    const sessionObs = await runCliScenario(testCliContract, {
      ...commandScenarios.session,
      beforeWrite: ({ destination, chunk }) => {
        if (
          destination === "stdout" &&
          chunk.includes("Shared session ready")
        ) {
          sessionAbort.abort();
        }
      },
    });
    assert.equal(sessionObs.termination.kind, "applicationResult");
    assert.equal(sessionObs.termination.exitCode, 0);
    assert.equal(sessionObs.termination.result.kind, "streamSuccess");
    assert.equal(sessionObs.termination.result.command, "session");
    assert.match(sessionObs.stdout, /Shared session stopped\./u);
    assert.equal(existsSync(socketPath), false);
  });

  await withCliTempHost({ linkSdk: false }, async (emptyHost) => {
    const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-fail-sock-"));
    const socketPath = join(socketDir, "fail.sock");
    emptyHost.addCleanup(() => {
      rmSync(socketDir, { recursive: true, force: true });
    });

    const failureScenarios = defineFailureScenarios(testCliContract, {
      check: {
        failed: {
          argv: ["check", "--output", "json"],
          dependencies: { cwd: emptyHost.rootDir },
        },
      },
      session: {
        failed: {
          argv: ["session", "--socket", socketPath, "--output", "ndjson"],
          dependencies: { cwd: emptyHost.rootDir },
        },
      },
    });

    const checkFailObs = await runCliScenario(
      testCliContract,
      failureScenarios.check.failed,
    );
    assert.equal(checkFailObs.termination.kind, "applicationResult");
    assert.equal(checkFailObs.termination.exitCode, 2);
    assert.equal(checkFailObs.termination.result.kind, "failure");
    assert.equal(checkFailObs.termination.result.command, "check");
    assert.equal(checkFailObs.termination.result.variant, "failed");
    assert.equal(checkFailObs.termination.result.data.reportVersion, "1");
    assert.equal(checkFailObs.termination.result.data.code, "INVALID_CONFIG");

    const sessionFailObs = await runCliScenario(
      testCliContract,
      failureScenarios.session.failed,
    );
    assert.equal(sessionFailObs.termination.kind, "applicationResult");
    assert.equal(sessionFailObs.termination.exitCode, 2);
    assert.equal(sessionFailObs.termination.result.kind, "failure");
    assert.equal(sessionFailObs.termination.result.command, "session");
    assert.equal(sessionFailObs.termination.result.variant, "failed");
    assert.equal(sessionFailObs.termination.result.data.code, "INVALID_CONFIG");
  });
});

void test("preserves --version, --help, --schema, constraints projection, and usage failures", async () => {
  const version = await runCliScenario(testCliContract, {
    argv: ["--version"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(version.termination.kind, "version");
  assert.equal(version.termination.exitCode, 0);
  assert.equal(version.stdout, "verule 0.0.0\n");

  const help = await runCliScenario(testCliContract, {
    argv: ["--help"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(help.termination.kind, "help");
  assert.equal(help.termination.exitCode, 0);
  assert.match(help.stdout, /check/u);
  assert.match(help.stdout, /watch/u);
  assert.match(help.stdout, /--schema/u);

  const checkHelp = await runCliScenario(testCliContract, {
    argv: ["check", "--help"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(checkHelp.termination.kind, "help");
  assert.equal(checkHelp.termination.exitCode, 0);
  assert.match(checkHelp.stdout, /Constraints/u);
  assert.match(checkHelp.stdout, /Cannot combine --session with --config\./u);
  assert.match(checkHelp.stdout, /\(choices: "off", "summary", "detail"\)/u);

  const schema = await runCliScenario(testCliContract, {
    argv: ["--schema"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(schema.termination.kind, "schema");
  assert.equal(schema.termination.exitCode, 0);
  assert.partialDeepStrictEqual(schema.termination.document, {
    kind: "directory",
    command: "verule",
  });

  const checkSchema = await runCliScenario(testCliContract, {
    argv: ["check", "--schema"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(checkSchema.termination.kind, "schema");
  assert.equal(checkSchema.termination.exitCode, 0);
  assert.partialDeepStrictEqual(checkSchema.termination.document, {
    kind: "summary",
    command: "check",
    usageConstraints: [
      {
        kind: "forbiddenCombination",
        all: [
          { kind: "present", field: "session" },
          { kind: "present", field: "config" },
        ],
      },
    ],
  });

  const unknown = await runCliScenario(testCliContract, {
    argv: ["--unknown"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(unknown.termination.kind, "usageFailure");
  assert.equal(unknown.termination.exitCode, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /--unknown/u);

  const forbiddenCombo = await runCliScenario(testCliContract, {
    argv: ["check", "--session", "demo.sock", "--config", "verule.config.ts"],
    dependencies: { cwd: tmpdir() },
  });
  assert.equal(forbiddenCombo.termination.kind, "usageFailure");
  assert.equal(forbiddenCombo.termination.exitCode, 2);
  assert.equal(forbiddenCombo.termination.command, "check");
  assert.deepEqual(forbiddenCombo.termination.issues, [
    {
      code: "forbiddenCombinationViolation",
      facts: [
        { kind: "present", field: "session" },
        { kind: "present", field: "config" },
      ],
    },
  ]);
  assert.equal(forbiddenCombo.stdout, "");
  assert.partialDeepStrictEqual(JSON.parse(forbiddenCombo.stderr), {
    schemaVersion: "3",
    command: "check",
    kind: "usageFailure",
  });
});

void test("check exits 0 with default zero rules in text and json modes", async () => {
  await withCliTempHost({ host: "integration/command-basic" }, async (host) => {
    await host.typecheck();

    const textResult = await runCliScenario(testCliContract, {
      argv: ["check"],
      dependencies: { cwd: host.rootDir },
    });
    assert.equal(textResult.termination.exitCode, 0, textResult.stderr);
    assert.equal(textResult.stderr, "");
    assert.match(textResult.stdout, /No violations found/u);

    const jsonResult = await runCliScenario(testCliContract, {
      argv: ["check", "--output", "json"],
      dependencies: { cwd: host.rootDir },
    });
    assert.equal(jsonResult.termination.kind, "applicationResult");
    assert.equal(jsonResult.termination.exitCode, 0, jsonResult.stderr);
    assert.equal(jsonResult.stderr, "");
    assert.equal(jsonResult.termination.result.kind, "data");
    assert.equal(jsonResult.termination.result.command, "check");
    assert.equal(jsonResult.termination.result.variant, "clean");
    assert.equal(jsonResult.termination.result.data.reportVersion, "1");
    assert.equal(jsonResult.termination.result.data.status, "clean");
    assert.deepEqual(jsonResult.termination.result.data.diagnostics, []);
  });
});

void test("check exits 1 when rules report violations and distinguishes failures with exit 2", async () => {
  await withCliTempHost({ host: "integration/command-basic" }, async (host) => {
    const textFindings = await runCliScenario(testCliContract, {
      argv: ["check", "--config", "verule.findings.config.ts"],
      dependencies: { cwd: host.rootDir },
    });
    assert.equal(textFindings.termination.exitCode, 1);
    assert.match(textFindings.stdout, /no-narrowed-string/u);
    assert.match(textFindings.stdout, /src\/index\.ts:6:12/u);

    const jsonFindings = await runCliScenario(testCliContract, {
      argv: [
        "check",
        "--config",
        "verule.findings.config.ts",
        "--output",
        "json",
      ],
      dependencies: { cwd: host.rootDir },
    });
    assert.equal(jsonFindings.termination.kind, "applicationResult");
    assert.equal(jsonFindings.termination.exitCode, 1);
    assert.equal(jsonFindings.termination.result.kind, "data");
    assert.equal(jsonFindings.termination.result.command, "check");
    assert.equal(jsonFindings.termination.result.variant, "findings");
    assert.equal(jsonFindings.termination.result.data.status, "findings");
    assert.equal(jsonFindings.termination.result.data.diagnostics.length, 1);

    const failJson = await runCliScenario(testCliContract, {
      argv: [
        "check",
        "--config",
        "verule.throwing.config.ts",
        "--output",
        "json",
      ],
      dependencies: { cwd: host.rootDir },
    });
    assert.equal(failJson.termination.kind, "applicationResult");
    assert.equal(failJson.termination.exitCode, 2);
    assert.equal(failJson.termination.result.kind, "failure");
    assert.equal(failJson.termination.result.command, "check");
    assert.equal(failJson.termination.result.variant, "failed");
    assert.equal(failJson.termination.result.data.code, "RULE_EXECUTION_ERROR");
  });

  // Missing config -> exit 2
  await withCliTempHost({ linkSdk: false }, async (emptyHost) => {
    const missingText = await runCliScenario(testCliContract, {
      argv: ["check"],
      dependencies: { cwd: emptyHost.rootDir },
    });
    assert.equal(missingText.termination.exitCode, 2);
    assert.match(missingText.stderr, /Check failed/u);
  });
});

void test("check reports multi-project scope, entry chains, divergent types, and merged diagnostics in text and json modes", async () => {
  await withCliTempHost(
    { host: "integration/command-multiproject" },
    async (host) => {
      await host.typecheck("packages/web/tsconfig.json");
      await host.typecheck("packages/node/tsconfig.json");

      const textResult = await runCliScenario(testCliContract, {
        argv: ["check"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(textResult.termination.exitCode, 1);
      assert.match(
        textResult.stdout,
        /tsconfig\.json -> packages\/web\/tsconfig\.json/u,
      );
      assert.match(
        textResult.stdout,
        /tsconfig\.json -> packages\/node\/tsconfig\.json/u,
      );
      assert.match(
        textResult.stdout,
        /packages\/shared\/shared\.ts <- .*packages\/node\/tsconfig\.json.*packages\/web\/tsconfig\.json/u,
      );
      assert.match(
        textResult.stdout,
        /\[projects: packages\/node\/tsconfig\.json, packages\/web\/tsconfig\.json\]/u,
      );

      const jsonResult = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(jsonResult.termination.kind, "applicationResult");
      assert.equal(jsonResult.termination.exitCode, 1);
      assert.equal(jsonResult.termination.result.kind, "data");
      assert.equal(jsonResult.termination.result.command, "check");

      const report = jsonResult.termination.result.data;
      assert.equal(report.projects.length, 3);
      const webMeta = report.projects.find(
        (p) => p.configFile === "packages/web/tsconfig.json",
      );
      assert.deepEqual(webMeta?.entryChain, [
        "tsconfig.json",
        "packages/web/tsconfig.json",
      ]);
      assert.equal(webMeta?.compilerOptions.strict, true);

      const sharedOrigin = report.fileOrigins.find(
        (o) => o.file === "packages/shared/shared.ts",
      );
      assert.deepEqual(
        sharedOrigin?.projects.map((p) => p.projectId),
        ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
      );

      assert.equal(report.diagnostics.length, 3);
      assert.deepEqual(
        report.diagnostics.find((d) => d.message === "Shared sink call")
          ?.projects,
        ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
      );
      assert.deepEqual(
        report.diagnostics.find((d) => d.message.includes('"web"'))?.projects,
        ["packages/web/tsconfig.json"],
      );
      assert.deepEqual(
        report.diagnostics.find((d) => d.message.includes('"node"'))?.projects,
        ["packages/node/tsconfig.json"],
      );
    },
  );
});
