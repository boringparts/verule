import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };

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
  let stdout = "";
  let stderr = "";
  const argv = [
    "node",
    "verule",
    "check",
    ...(configArg ? ["--config", configArg] : []),
    "--output",
    "json",
  ];
  const status = await runCli({
    identity,
    argv,
    cwd,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
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
      readonly diagnostics: readonly unknown[];
      readonly gaps: readonly unknown[];
      readonly identity: unknown;
    };
  };
  return { status, data: envelope.data };
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

void test("verule watch --output ndjson aligns every round with independent verule check, reloads rules/models/config, and recovers from errors", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-watch-ndjson-"));
  mkdirSync(join(root, "src"), { recursive: true });

  const tsconfigPath = join(root, "tsconfig.json");
  const altTsconfigPath = join(root, "tsconfig.alt.json");
  const sharedPath = join(root, "src", "shared.ts");
  const consumerPath = join(root, "src", "consumer.ts");
  const unrelatedPath = join(root, "src", "unrelated.ts");
  const altOnlyPath = join(root, "src", "alt-only.ts");
  const modelPath = join(root, "verule.model.mjs");
  const rulesPath = join(root, "verule.rules.mjs");
  const configPath = join(root, "verule.config.mjs");

  writeFileSync(
    tsconfigPath,
    createTsConfig(["src/shared.ts", "src/consumer.ts", "src/unrelated.ts"]),
    "utf8",
  );
  writeFileSync(
    altTsconfigPath,
    createTsConfig(["src/shared.ts", "src/alt-only.ts"]),
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
    altOnlyPath,
    [
      "function sink(mode: string): string {",
      "  return mode;",
      "}",
      "export function runAlt(): string {",
      '  return sink("safe");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

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

  const lines: NdjsonLine[] = [];
  let lineBuffer = "";
  let stderr = "";
  let waiters: (() => void)[] = [];
  const abortController = new AbortController();

  function pushLine(rawLine: string): void {
    lines.push(JSON.parse(rawLine) as NdjsonLine);
    const pending = waiters;
    waiters = [];
    for (const wake of pending) wake();
  }

  async function nextRecord(
    predicate: (line: NdjsonLine) => boolean,
  ): Promise<NdjsonLine> {
    const deadline = Date.now() + 10_000;
    let cursor = 0;
    while (true) {
      while (cursor < lines.length) {
        const candidate = lines[cursor]!;
        cursor += 1;
        if (predicate(candidate)) return candidate;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for watch record. Received so far: ${JSON.stringify(lines)}`,
        );
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 200);
        waiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }

  try {
    const watchPromise = runCli({
      identity,
      cwd: root,
      argv: ["node", "verule", "watch", "--output", "ndjson"],
      signal: abortController.signal,
      write: ({ destination, chunk }) => {
        if (destination === "stderr") {
          stderr += chunk;
          return;
        }
        lineBuffer += chunk;
        while (true) {
          const idx = lineBuffer.indexOf("\n");
          if (idx === -1) break;
          const raw = lineBuffer.slice(0, idx).trim();
          lineBuffer = lineBuffer.slice(idx + 1);
          if (raw.length > 0) pushLine(raw);
        }
      },
    });

    const header = await nextRecord((item) => item.kind === "stream");
    assert.equal(header.kind, "stream");

    async function assertMatchesColdCheck(
      seq: number,
      expectedStatus: "clean" | "findings",
    ) {
      const rec = await nextRecord(
        (item) =>
          item.kind === "record" &&
          item.variant === "report" &&
          item.data.sequence === seq,
      );
      assert.equal(rec.kind, "record");
      assert.equal(rec.variant, "report");
      assert.equal(rec.data.status, expectedStatus);
      assert.ok(rec.data.memory.hostRssBytes > 0);
      const cold = await runColdJsonCheck(root);
      assert.deepEqual(
        {
          reportVersion: rec.data.reportVersion,
          status: rec.data.status,
          projects: rec.data.projects,
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
    const r2 = await assertMatchesColdCheck(2, "findings");
    assert.equal(r2.diagnostics.length, 1);

    // 3. Fix violation (diagnostic retraction)
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
    const r3 = await assertMatchesColdCheck(3, "clean");
    assert.equal(r3.diagnostics.length, 0);

    // 4. Modify imported shared definition
    writeFileSync(
      sharedPath,
      'export function getMode(): "fast" {\n  return "fast";\n}\n',
      "utf8",
    );
    const r4 = await assertMatchesColdCheck(4, "findings");
    assert.equal(r4.diagnostics.length, 1);

    // 5. Modify unrelated file -> reusedFiles preserves unaffected files
    writeFileSync(unrelatedPath, "export const note = 2;\n", "utf8");
    const r5 = await assertMatchesColdCheck(5, "findings");
    assert.ok(r5.recomputation.recomputedFiles.includes("src/unrelated.ts"));
    assert.ok(r5.recomputation.reusedFiles.includes("src/consumer.ts"));

    // 6. Single-round failure (invalid config) -> emits failed record without exiting, then recovers
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
    const f6 = await nextRecord(
      (item) =>
        item.kind === "record" &&
        item.variant === "failed" &&
        item.data.sequence === 6,
    );
    assert.equal(f6.kind, "record");
    assert.equal(f6.variant, "failed");
    assert.equal(f6.data.code, "INVALID_CONFIG");

    // Restore valid config -> recovers cleanly on round 7
    writeFileSync(configPath, savedConfig, "utf8");
    await assertMatchesColdCheck(7, "findings");

    // 7a. Modify imported model file -> reloads model and updates identity & findings
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
    const r8 = await assertMatchesColdCheck(8, "clean");
    assert.equal(r8.identity.models[0]?.version, "2");

    // 7b. Modify imported rules file -> reloads rule
    writeFileSync(
      rulesPath,
      [
        "export function createRules() {",
        "  return [",
        "    {",
        '      id: "disallow-mode-v2",',
        "      run: async (ctx) => {",
        '        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
        "        for (const c of calls) {",
        '          if (c.text.startsWith("sink(")) {',
        '            ctx.report({ at: c.location, message: "sink called" });',
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
    const r9 = await assertMatchesColdCheck(9, "findings");
    assert.equal(r9.identity.rules[0]?.id, "disallow-mode-v2");

    // 7c. Modify config entry (switch tsconfig -> tsconfig.alt.json)
    writeFileSync(
      configPath,
      [
        'import { modePolicy } from "./verule.model.mjs";',
        'import { createRules } from "./verule.rules.mjs";',
        "export default {",
        '  projects: ["tsconfig.alt.json"],',
        "  models: [modePolicy],",
        "  rules: createRules(),",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );
    const r10 = await assertMatchesColdCheck(10, "findings");
    assert.equal(r10.diagnostics[0]?.at.file, "src/alt-only.ts");

    abortController.abort();
    const exitCode = await watchPromise;
    assert.equal(exitCode, 0, stderr);
    assert.equal(stderr, "");
    assert.equal(lines.at(-1)?.kind, "streamSuccess");
  } finally {
    abortController.abort();
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule watch text mode prints reports, handles failures, and stops cleanly on abort", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-watch-text-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    createTsConfig(["src/**/*.ts"]),
    "utf8",
  );
  writeFileSync(join(root, "src", "index.ts"), "export const x = 1;\n", "utf8");
  writeFileSync(
    join(root, "verule.config.mjs"),
    'export default { tsconfig: "tsconfig.json" };\n',
    "utf8",
  );

  let stdout = "";
  let stderr = "";
  const abortController = new AbortController();

  try {
    const watchPromise = runCli({
      identity,
      cwd: root,
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
  } finally {
    abortController.abort();
    rmSync(root, { recursive: true, force: true });
  }
});
