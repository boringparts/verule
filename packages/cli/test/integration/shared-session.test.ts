import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };

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

type CheckJsonOutput = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly envelope:
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
};

async function runCliCheck(
  cwd: string,
  args: readonly string[],
): Promise<CheckJsonOutput> {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    cwd,
    argv: ["node", "verule", "check", ...args],
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  const rawJson = status === 2 ? stderr : stdout;
  return {
    status,
    stdout,
    stderr,
    envelope: JSON.parse(rawJson) as CheckJsonOutput["envelope"],
  };
}

async function runCliText(cwd: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    cwd,
    argv: ["node", "verule", ...args],
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

function createTsConfig(include: readonly string[]): string {
  return JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include,
    },
    null,
    2,
  );
}

void test("verule session and verule check --session align every round with standalone verule check", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-shared-"));
  const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-sock-"));
  const socketPath = join(socketDir, "shared.sock");
  mkdirSync(join(root, "src"), { recursive: true });

  const tsconfigPath = join(root, "tsconfig.json");
  const sharedPath = join(root, "src", "shared.ts");
  const consumerPath = join(root, "src", "consumer.ts");
  const unrelatedPath = join(root, "src", "unrelated.ts");
  const modelPath = join(root, "verule.model.mjs");
  const rulesPath = join(root, "verule.rules.mjs");
  const configPath = join(root, "verule.config.mjs");

  writeFileSync(
    tsconfigPath,
    createTsConfig(["src/shared.ts", "src/consumer.ts", "src/unrelated.ts"]),
    "utf8",
  );
  writeFileSync(
    sharedPath,
    'export function getMode(): "safe" | "fast" {\n  return "safe";\n}\n',
    "utf8",
  );
  writeFileSync(
    consumerPath,
    [
      'import { getMode } from "./shared.js";',
      "function sink(mode: string): string {",
      "  return mode;",
      "}",
      "export function runConsumer(): string {",
      "  return sink(getMode());",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(unrelatedPath, "export const note = 1;\n", "utf8");

  writeFileSync(
    modelPath,
    [
      "export const modePolicy = {",
      '  id: "mode-policy",',
      '  version: "1",',
      '  facts: { disallowedMode: "fast" },',
      "};",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    rulesPath,
    [
      "export function createRules() {",
      "  return [",
      "    {",
      '      id: "disallow-mode",',
      "      run: async (ctx) => {",
      '        const model = ctx.getModel("mode-policy");',
      '        const forbidden = model?.facts?.disallowedMode ?? "fast";',
      '        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      '        const sinks = calls.filter((c) => c.text.startsWith("sink("));',
      "        const args = sinks.map((c) => c.arguments?.[0]).filter(Boolean);",
      "        if (args.length === 0) return;",
      "        const types = await ctx.typeAt(args);",
      "        for (const [i, ty] of types.entries()) {",
      "          if (ty.isLiteral && ty.literalValue === forbidden) {",
      "            ctx.report({",
      "              at: sinks[i].location,",
      "              message: `Disallowed mode ${String(forbidden)} (v${model?.version ?? '0'})`,",
      "              findingKey: `mode:${String(forbidden)}`,",
      "              evidence: [{ kind: 'type', message: `Narrowed to ${ty.typeText}`, at: sinks[i].location }],",
      "            });",
      "          }",
      "        }",
      "      },",
      "    },",
      "  ];",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    configPath,
    [
      'import { modePolicy } from "./verule.model.mjs";',
      'import { createRules } from "./verule.rules.mjs";',
      "export default {",
      '  tsconfig: "tsconfig.json",',
      "  models: [modePolicy],",
      "  rules: createRules(),",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  const lines: SessionNdjsonLine[] = [];
  let buffer = "";
  let sessionStderr = "";
  let waiters: (() => void)[] = [];
  const abortController = new AbortController();

  function wakeAll(): void {
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  }

  async function waitForRecord(
    predicate: (line: SessionNdjsonLine) => boolean,
  ): Promise<SessionNdjsonLine> {
    const deadline = Date.now() + 10_000;
    let cursor = 0;
    while (true) {
      while (cursor < lines.length) {
        const line = lines[cursor]!;
        cursor += 1;
        if (predicate(line)) return line;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for session record. Received=${JSON.stringify(lines)} stderr=${sessionStderr}`,
        );
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 100);
        waiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }

  async function queryAndCompare(
    label: string,
    expectedStatus: 0 | 1,
    extraArgs: readonly string[] = [],
  ) {
    const start = performance.now();
    const sharedRes = await runCliCheck(tmpdir(), [
      "--session",
      socketPath,
      ...extraArgs,
      "--output",
      "json",
    ]);
    const elapsedMs = performance.now() - start;
    t.diagnostic(`CLI shared query (${label}): ${elapsedMs.toFixed(2)}ms`);

    assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);
    assert.equal(sharedRes.envelope.kind, "data");

    const coldRes = await runCliCheck(root, [
      "--config",
      configPath,
      ...extraArgs,
      "--output",
      "json",
    ]);
    assert.equal(coldRes.status, expectedStatus, coldRes.stderr);
    assert.equal(coldRes.envelope.kind, "data");

    assert.deepEqual(sharedRes.envelope.data, coldRes.envelope.data);
    return sharedRes.envelope.data;
  }

  try {
    const sessionPromise = runCli({
      identity,
      cwd: root,
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
      write: ({ destination, chunk }) => {
        if (destination === "stderr") {
          sessionStderr += chunk;
          return;
        }
        buffer += chunk;
        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx === -1) break;
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (raw.length > 0) {
            lines.push(JSON.parse(raw) as SessionNdjsonLine);
            wakeAll();
          }
        }
      },
    });

    const ready = await waitForRecord(
      (line) => line.kind === "record" && line.variant === "ready",
    );
    assert.equal(ready.kind, "record");
    assert.equal(ready.data.endpoint, socketPath);
    assert.equal(existsSync(socketPath), true);

    // 1. Initial clean state from another working directory
    await queryAndCompare("initial-clean", 0);

    // Cannot combine --session and --config
    const invalidCombo = await runCliCheck(root, [
      "--session",
      socketPath,
      "--config",
      configPath,
      "--output",
      "json",
    ]);
    assert.equal(invalidCombo.status, 2);
    assert.equal(invalidCombo.envelope.kind, "failure");
    assert.equal(invalidCombo.envelope.data.code, "INVALID_CONFIG");

    // 2. Introduce violation -> query immediately (0ms)
    writeFileSync(
      consumerPath,
      [
        'import { getMode } from "./shared.js";',
        "function sink(mode: string): string {",
        "  return mode;",
        "}",
        "export function runConsumer(): string {",
        '  void getMode(); return sink("fast");',
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    const findingsData = await queryAndCompare("introduce-violation", 1);
    assert.equal(findingsData.diagnostics.length, 1);

    // Text mode check via --session
    const textFindings = await runCliText(tmpdir(), [
      "check",
      "--session",
      socketPath,
    ]);
    assert.equal(textFindings.status, 1, textFindings.stderr);
    assert.match(textFindings.stdout, /disallow-mode/u);

    // Targeted explain & rule filter via --session
    const explained = await runCliCheck(tmpdir(), [
      "--session",
      socketPath,
      "--rule",
      "disallow-mode",
      "--at",
      "src/consumer.ts:6:26",
      "--output",
      "json",
    ]);
    assert.equal(explained.status, 1, explained.stderr);
    assert.equal(explained.envelope.kind, "data");
    assert.equal(explained.envelope.data.explanation?.status, "reported");

    // Observation mode via --session
    const observed = await runCliCheck(tmpdir(), [
      "--session",
      socketPath,
      "--observe",
      "detail",
      "--output",
      "json",
    ]);
    assert.equal(observed.status, 1, observed.stderr);
    assert.equal(observed.envelope.kind, "data");
    assert.ok(observed.envelope.data.observation);

    // 3. Fix violation -> query immediately -> retracted
    writeFileSync(
      consumerPath,
      [
        'import { getMode } from "./shared.js";',
        "function sink(mode: string): string {",
        "  return mode;",
        "}",
        "export function runConsumer(): string {",
        "  return sink(getMode());",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    await queryAndCompare("fix-violation", 0);

    // 4. Modify shared definition & unrelated file
    writeFileSync(
      sharedPath,
      'export function getMode(): "fast" {\n  return "fast";\n}\n',
      "utf8",
    );
    await queryAndCompare("shared-definition-change", 1);

    writeFileSync(unrelatedPath, "export const note = 2;\n", "utf8");
    await queryAndCompare("unrelated-file-change", 1);

    // 5. Config/model reload & single-round failure recovery
    const savedConfig = [
      'import { modePolicy } from "./verule.model.mjs";',
      'import { createRules } from "./verule.rules.mjs";',
      "export default {",
      '  tsconfig: "tsconfig.json",',
      "  models: [modePolicy],",
      "  rules: createRules(),",
      "};",
      "",
    ].join("\n");
    writeFileSync(configPath, "export default { broken(", "utf8");

    const brokenRes = await runCliCheck(tmpdir(), [
      "--session",
      socketPath,
      "--output",
      "json",
    ]);
    assert.equal(brokenRes.status, 2);
    assert.equal(brokenRes.envelope.kind, "failure");
    assert.equal(brokenRes.envelope.data.code, "INVALID_CONFIG");

    // Restore config and update model -> recovers immediately
    writeFileSync(configPath, savedConfig, "utf8");
    writeFileSync(
      modelPath,
      [
        "export const modePolicy = {",
        '  id: "mode-policy",',
        '  version: "2",',
        '  facts: { disallowedMode: "safe" },',
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const recovered = await queryAndCompare("recover-and-model-reload", 0);
    assert.equal(recovered.identity.models[0]?.version, "2");

    // 6. Shut down shared session -> socket cleaned up, standalone check still works
    abortController.abort();
    const exitCode = await sessionPromise;
    assert.equal(exitCode, 0, sessionStderr);
    assert.equal(sessionStderr, "");
    assert.equal(lines.at(-1)?.kind, "streamSuccess");
    assert.equal(existsSync(socketPath), false);

    const afterCloseShared = await runCliCheck(tmpdir(), [
      "--session",
      socketPath,
      "--output",
      "json",
    ]);
    assert.equal(afterCloseShared.status, 2);
    assert.equal(afterCloseShared.envelope.kind, "failure");

    const standaloneAfterClose = await runCliCheck(root, [
      "--config",
      configPath,
      "--output",
      "json",
    ]);
    assert.equal(standaloneAfterClose.status, 0);
    assert.equal(standaloneAfterClose.envelope.kind, "data");
    assert.deepEqual(standaloneAfterClose.envelope.data, recovered);
  } finally {
    abortController.abort();
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});

void test("verule session text mode prints ready and shutdown lines and exits 2 on missing config", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-session-text-"));
  const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-sock-text-"));
  const socketPath = join(socketDir, "text.sock");

  try {
    const missingRes = await runCliText(root, [
      "session",
      "--config",
      "missing.config.ts",
      "--socket",
      socketPath,
    ]);
    assert.equal(missingRes.status, 2);
    assert.match(missingRes.stderr, /Session failed/u);
    assert.equal(existsSync(socketPath), false);

    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(
      join(root, "tsconfig.json"),
      createTsConfig(["src/**/*.ts"]),
      "utf8",
    );
    writeFileSync(
      join(root, "src", "index.ts"),
      "export const a = 1;\n",
      "utf8",
    );
    writeFileSync(
      join(root, "verule.config.mjs"),
      'export default { tsconfig: "tsconfig.json" };\n',
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    const abortController = new AbortController();
    const sessionPromise = runCli({
      identity,
      cwd: root,
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
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});
