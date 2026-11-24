import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };

async function captureCli(argv: readonly string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    argv: ["node", "verule", ...argv],
    cwd,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

function createExplainProject(): { root: string; evalLogPath: string } {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-explain-"));
  const evalLogPath = join(root, "lazy-eval-count.txt");
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "app.ts"),
    [
      "function sink(value: string | number): string {",
      "  return String(value);",
      "}",
      "export function handle(input: string | number): string {",
      '  if (typeof input === "string") {',
      "    return sink(input);",
      "  }",
      "  return sink(input);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(root, "verule.config.mjs"),
    `import { appendFileSync } from "node:fs";
const logPath = ${JSON.stringify(evalLogPath)};

export default {
  tsconfig: "tsconfig.json",
  rules: [
    {
      id: "rule-no-string-sink",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const sinks = calls.filter((c) => c.text.startsWith("sink("));
        const args = sinks.map((c) => c.arguments?.[0]).filter(Boolean);
        const types = await ctx.typeAt(args);
        for (const [i, ty] of types.entries()) {
          const call = sinks[i];
          if (ty.typeText === "string") {
            ctx.checkpoint("require-string", call, "pass", () => {
              appendFileSync(logPath, "1\\n");
              return { actualType: ty.typeText };
            });
            ctx.report({
              at: call.location,
              message: "Disallowed string sink call",
              basis: [{ kind: "type", message: "Argument narrowed to string" }],
            });
          } else {
            ctx.checkpoint("require-string", call, "exclude", () => {
              appendFileSync(logPath, "1\\n");
              return { actualType: ty.typeText, expected: "string" };
            });
          }
        }
      },
    },
    {
      id: "rule-other",
      run: async (ctx) => {
        await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
      },
    },
  ],
};
`,
    "utf8",
  );
  return { root, evalLogPath };
}

void test("verule check --rule and --at explain why a source location did not report", async () => {
  const { root } = createExplainProject();
  try {
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
      root,
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
      root,
    );
    assert.equal(textRes.status, 1, textRes.stderr);
    assert.match(textRes.stdout, /Explanation \[rule-no-string-sink\]/u);
    assert.match(textRes.stdout, /not_in_candidates/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule check --observe and --observe-limit report overhead, truncation, and preserve identical business reports", async () => {
  const { root, evalLogPath } = createExplainProject();
  try {
    const offStart = performance.now();
    const offRes = await captureCli(["check", "--output", "json"], root);
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
      root,
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
          overhead: { checkpointMs: number; encodeMs: number; writeMs: number };
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
      root,
    );
    assert.equal(unlimitedDetail.status, 1);
    assert.equal(existsSync(evalLogPath), true);
    assert.ok(readFileSync(evalLogPath, "utf8").trim().split("\n").length >= 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule check rejects unknown --rule, invalid --at, and invalid --observe-limit with exit 2", async () => {
  const { root } = createExplainProject();
  try {
    const badRule = await captureCli(
      ["check", "--rule", "does-not-exist", "--output", "json"],
      root,
    );
    assert.equal(badRule.status, 2);
    assert.equal(JSON.parse(badRule.stderr).data.code, "INVALID_CONFIG");

    const badAt = await captureCli(
      ["check", "--at", "src/app.ts:0", "--output", "json"],
      root,
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
      root,
    );
    assert.equal(badLimit.status, 2);
    assert.equal(JSON.parse(badLimit.stderr).data.code, "INVALID_CONFIG");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule check --observe and --at surface adapter providers, ruleId, candidates, and reuse", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-facts-observe-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  writeFileSync(
    join(root, "src", "app.ts"),
    "export function checkInput(x: string): string { return x; }\n",
    "utf8",
  );
  const sdkUrl = import.meta.resolve("@verule/sdk");
  writeFileSync(
    join(root, "verule.config.mjs"),
    `import { defineAdapter, defineConfig, defineFactType, defineRule } from ${JSON.stringify(sdkUrl)};

const SampleFact = defineFactType({
  id: "cli.sample-fact",
  subjectKind: "syntax",
});

const sampleAdapter = defineAdapter({
  id: "sample-provider",
  provides: [
    {
      factType: SampleFact,
      extract: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        return fns.map((fn) => ({
          subject: fn.ref,
          value: { ok: true },
        }));
      },
    },
  ],
});

const ruleFirst = defineRule({
  id: "rule-first",
  run: async (ctx) => {
    await ctx.facts(SampleFact);
  },
});

const ruleSecond = defineRule({
  id: "rule-second",
  run: async (ctx) => {
    await ctx.facts(SampleFact);
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [sampleAdapter],
  rules: [ruleFirst, ruleSecond],
});
`,
    "utf8",
  );

  try {
    const textRes = await captureCli(
      ["check", "--observe", "detail", "--at", "src/app.ts:1:1"],
      root,
    );
    assert.equal(textRes.status, 0, textRes.stderr);
    assert.match(textRes.stdout, /providers: .*sample-provider/u);
    assert.match(textRes.stdout, /provider=sample-provider/u);
    assert.match(textRes.stdout, /rule=rule-first/u);
    assert.match(textRes.stdout, /rule=rule-second/u);
    assert.match(textRes.stdout, /cache=computed/u);
    assert.match(textRes.stdout, /cache=reused/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule check --at --output json strips undefined properties from checkpoint details", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-explain-undef-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({ include: ["src/**/*.ts"] }),
    "utf8",
  );
  writeFileSync(join(root, "src", "app.ts"), "export const x = 1;\n", "utf8");
  const sdkUrl = import.meta.resolve("@verule/sdk");
  writeFileSync(
    join(root, "verule.config.mjs"),
    `import { defineConfig, defineRule } from ${JSON.stringify(sdkUrl)};

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "rule-with-optional-detail",
      run: async (ctx) => {
        const decls = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
        for (const decl of decls) {
          ctx.checkpoint("checked-decl", decl.location, "pass", () => ({
            present: true,
            optionalName: undefined,
          }));
        }
      },
    }),
  ],
});
`,
    "utf8",
  );

  try {
    const res = await captureCli(
      ["check", "--at", "src/app.ts:1", "--output", "json"],
      root,
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
