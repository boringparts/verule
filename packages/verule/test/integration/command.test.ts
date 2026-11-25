import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { TEST_CLI_IDENTITY, captureCli } from "./cli-test-helpers.ts";

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

void test("preserves bare command, --version, --help, --schema, and --unknown", async () => {
  const bare = await captureCli([]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /^verule 0\.0\.0 \(engine \d+\.\d+\.\d+\)\n$/u);

  const version = await captureCli(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, "verule 0.0.0\n");

  const help = await captureCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /check/u);
  assert.match(help.stdout, /watch/u);
  assert.match(help.stdout, /--schema/u);

  const schema = await captureCli(["--schema"]);
  assert.equal(schema.status, 0, schema.stderr);
  assert.partialDeepStrictEqual(JSON.parse(schema.stdout), {
    kind: "directory",
    command: "verule",
  });

  const unknown = await captureCli(["--unknown"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /--unknown/u);
});

void test("check exits 0 with default zero rules in text and json modes", async () => {
  await withCliTempHost({ host: "integration/command-basic" }, async (host) => {
    await host.typecheck();

    const textResult = await captureCli(["check"], host.rootDir);
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.equal(textResult.stderr, "");
    assert.match(textResult.stdout, /No violations found/u);

    const jsonResult = await captureCli(
      ["check", "--output", "json"],
      host.rootDir,
    );
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.equal(jsonResult.stderr, "");
    const envelope = JSON.parse(jsonResult.stdout) as {
      kind: string;
      variant: string;
      data: { reportVersion: string; status: string; diagnostics: unknown[] };
    };
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "clean");
    assert.equal(envelope.data.reportVersion, "1");
    assert.equal(envelope.data.status, "clean");
    assert.deepEqual(envelope.data.diagnostics, []);
  });
});

void test("check exits 1 when rules report violations and distinguishes failures with exit 2", async () => {
  await withCliTempHost({ host: "integration/command-basic" }, async (host) => {
    const textFindings = await captureCli(
      ["check", "--config", "verule.findings.config.ts"],
      host.rootDir,
    );
    assert.equal(textFindings.status, 1);
    assert.match(textFindings.stdout, /no-narrowed-string/u);
    assert.match(textFindings.stdout, /src\/index\.ts:6:12/u);

    const jsonFindings = await captureCli(
      ["check", "--config", "verule.findings.config.ts", "--output", "json"],
      host.rootDir,
    );
    assert.equal(jsonFindings.status, 1);
    const envelope = JSON.parse(jsonFindings.stdout) as {
      kind: string;
      variant: string;
      data: { status: string; diagnostics: { ruleId: string }[] };
    };
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    assert.equal(envelope.data.status, "findings");
    assert.equal(envelope.data.diagnostics.length, 1);

    const failJson = await captureCli(
      ["check", "--config", "verule.throwing.config.ts", "--output", "json"],
      host.rootDir,
    );
    assert.equal(failJson.status, 2);
    const failEnvelope = JSON.parse(failJson.stderr) as {
      kind: string;
      variant: string;
      data: { code: string; message: string };
    };
    assert.equal(failEnvelope.kind, "failure");
    assert.equal(failEnvelope.variant, "failed");
    assert.equal(failEnvelope.data.code, "RULE_EXECUTION_ERROR");
  });

  // Missing config -> exit 2
  await withCliTempHost({ linkSdk: false }, async (emptyHost) => {
    const missingText = await captureCli(["check"], emptyHost.rootDir);
    assert.equal(missingText.status, 2);
    assert.match(missingText.stderr, /Check failed/u);

    const missingJson = await captureCli(
      ["check", "--output", "json"],
      emptyHost.rootDir,
    );
    assert.equal(missingJson.status, 2);
    const errEnvelope = JSON.parse(missingJson.stderr) as {
      kind: string;
      variant: string;
      data: { reportVersion: string; code: string; message: string };
    };
    assert.equal(errEnvelope.kind, "failure");
    assert.equal(errEnvelope.variant, "failed");
    assert.equal(errEnvelope.data.reportVersion, "1");
    assert.equal(errEnvelope.data.code, "INVALID_CONFIG");
  });
});

void test("check reports multi-project scope, entry chains, divergent types, and merged diagnostics in text and json modes", async () => {
  await withCliTempHost(
    { host: "integration/command-multiproject" },
    async (host) => {
      await host.typecheck("packages/web/tsconfig.json");
      await host.typecheck("packages/node/tsconfig.json");

      const textResult = await captureCli(["check"], host.rootDir);
      assert.equal(textResult.status, 1);
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

      const jsonResult = await captureCli(
        ["check", "--output", "json"],
        host.rootDir,
      );
      assert.equal(jsonResult.status, 1);
      const envelope = JSON.parse(jsonResult.stdout) as {
        kind: string;
        variant: string;
        data: {
          projects: {
            configFile: string;
            entryConfig: string;
            entryChain: string[];
            compilerOptions: { strict: boolean; allowJs: boolean };
          }[];
          fileOrigins: {
            file: string;
            projects: { projectId: string; entryChain: string[] }[];
          }[];
          diagnostics: { message: string; projects: string[] }[];
        };
      };

      assert.equal(envelope.data.projects.length, 3);
      const webMeta = envelope.data.projects.find(
        (p) => p.configFile === "packages/web/tsconfig.json",
      );
      assert.deepEqual(webMeta?.entryChain, [
        "tsconfig.json",
        "packages/web/tsconfig.json",
      ]);
      assert.equal(webMeta?.compilerOptions.strict, true);

      const sharedOrigin = envelope.data.fileOrigins.find(
        (o) => o.file === "packages/shared/shared.ts",
      );
      assert.deepEqual(
        sharedOrigin?.projects.map((p) => p.projectId),
        ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
      );

      assert.equal(envelope.data.diagnostics.length, 3);
      assert.deepEqual(
        envelope.data.diagnostics.find((d) => d.message === "Shared sink call")
          ?.projects,
        ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
      );
      assert.deepEqual(
        envelope.data.diagnostics.find((d) => d.message.includes('"web"'))
          ?.projects,
        ["packages/web/tsconfig.json"],
      );
      assert.deepEqual(
        envelope.data.diagnostics.find((d) => d.message.includes('"node"'))
          ?.projects,
        ["packages/node/tsconfig.json"],
      );
    },
  );
});
