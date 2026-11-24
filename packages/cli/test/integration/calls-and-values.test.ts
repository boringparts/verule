import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

function createMixedProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-calls-values-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          allowJs: true,
          checkJs: false,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        files: ["src/entry.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void test("verule check distinguishes clean, gaps-only, findings-with-gaps, and escalated-gap on mixed TS/JS with observe off", async () => {
  const root = createMixedProject({
    "src/sink.ts": [
      'export function deliver(_mode: "alpha" | "beta", received: string): string {',
      "  return received;",
      "}",
      "",
    ].join("\n"),
    "src/bridge.js": [
      'import { deliver } from "./sink.js";',
      "",
      "/**",
      ' * @param {"alpha" | "beta"} mode',
      " * @param {string} payload",
      " */",
      "export function forwardBridge(mode, payload) {",
      "  return deliver(mode, payload);",
      "}",
      "",
    ].join("\n"),
    "src/entry.ts": [
      'import { forwardBridge } from "./bridge.js";',
      "",
      "function makeSecret(): string {",
      '  return "secret";',
      "}",
      "",
      "export function execute(",
      "  useDynamic: boolean,",
      "  cb: (v: string) => string,",
      "): string {",
      "  const secret = makeSecret();",
      '  const delivered = forwardBridge("alpha", secret);',
      "  if (useDynamic) {",
      "    return cb(secret);",
      "  }",
      "  return delivered;",
      "}",
      "",
    ].join("\n"),
    "verule.clean.config.mjs": `
      export default {
        tsconfig: "tsconfig.json",
        rules: [
          {
            id: "clean-check",
            run: async (ctx) => {
              const calls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["CallExpression"] });
              const forwardCall = calls.find((c) => c.text.startsWith("forwardBridge("));
              const resolved = await ctx.resolveCalls([forwardCall.ref]);
              await ctx.calleesOf([resolved[0].call]);
            },
          },
        ],
      };
    `,
    "verule.gaps-only.config.mjs": `
      export default {
        tsconfig: "tsconfig.json",
        rules: [
          {
            id: "gaps-only-check",
            run: async (ctx) => {
              const calls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["CallExpression"] });
              const dynCall = calls.find((c) => c.text.startsWith("cb("));
              const resolved = await ctx.resolveCalls([dynCall.ref]);
              await ctx.calleesOf([resolved[0].call]);
            },
          },
        ],
      };
    `,
    "verule.findings-and-gaps.config.mjs": `
      export default {
        tsconfig: "tsconfig.json",
        rules: [
          {
            id: "mixed-flow-and-gap",
            run: async (ctx) => {
              const calls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["CallExpression"] });
              const dynCall = calls.find((c) => c.text.startsWith("cb("));
              const [dynRes] = await ctx.resolveCalls([dynCall.ref]);
              await ctx.calleesOf([dynRes.call]);

              const varDecls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["VariableDeclaration"] });
              const secretInit = varDecls.find((d) => d.text.startsWith("secret =")).initializer;
              const deliveredDecl = varDecls.find((d) => d.text.startsWith("delivered ="));
              const [deliveredRes] = await ctx.resolveDeclarations([deliveredDecl.ref]);

              const prop = await ctx.valuePropagation({
                propagation: "value",
                from: secretInit,
                to: [deliveredRes.declaration],
              });
              if (prop.results[0].reachable) {
                ctx.report({
                  at: deliveredDecl.location,
                  message: "Secret reached sink across TS -> JS -> TS",
                  basis: [prop.results[0]],
                });
              }
            },
          },
        ],
      };
    `,
    "verule.escalate-gap.config.mjs": `
      export default {
        tsconfig: "tsconfig.json",
        rules: [
          {
            id: "escalate-dynamic-gap",
            run: async (ctx) => {
              const calls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["CallExpression"] });
              const dynCall = calls.find((c) => c.text.startsWith("cb("));
              const [dynRes] = await ctx.resolveCalls([dynCall.ref]);
              const [calleeRes] = await ctx.calleesOf([dynRes.call]);
              for (const gap of calleeRes.gaps) {
                ctx.report({
                  at: gap.at ?? dynCall.location,
                  message: "Escalated dynamic gap: " + gap.message,
                  basis: [{ kind: "note", message: gap.kind, at: gap.at }],
                });
              }
            },
          },
        ],
      };
    `,
  });

  try {
    // (a) Clean with zero gaps
    const cleanJson = await captureCli(
      ["check", "--config", "verule.clean.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(cleanJson.status, 0, cleanJson.stderr);
    const cleanEnv = JSON.parse(cleanJson.stdout) as {
      variant: string;
      data: {
        status: string;
        diagnostics: unknown[];
        gaps: unknown[];
        observation?: unknown;
      };
    };
    assert.equal(cleanEnv.variant, "clean");
    assert.equal(cleanEnv.data.status, "clean");
    assert.deepEqual(cleanEnv.data.diagnostics, []);
    assert.deepEqual(cleanEnv.data.gaps, []);
    assert.equal("observation" in cleanEnv.data, false);

    // (b) Clean with gaps present -> exit 0 and gaps listed
    const gapsText = await captureCli(
      ["check", "--config", "verule.gaps-only.config.mjs"],
      root,
    );
    assert.equal(gapsText.status, 0, gapsText.stderr);
    assert.match(gapsText.stdout, /gap \[dynamic-callee\]/u);
    assert.match(gapsText.stdout, /No violations found.*1 gap\(s\)/u);

    const gapsJson = await captureCli(
      ["check", "--config", "verule.gaps-only.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(gapsJson.status, 0, gapsJson.stderr);
    const gapsEnv = JSON.parse(gapsJson.stdout) as {
      variant: string;
      data: {
        status: string;
        diagnostics: unknown[];
        gaps: { kind: string }[];
        observation?: unknown;
      };
    };
    assert.equal(gapsEnv.variant, "clean");
    assert.deepEqual(gapsEnv.data.diagnostics, []);
    assert.equal(gapsEnv.data.gaps.length, 1);
    assert.equal(gapsEnv.data.gaps[0]?.kind, "dynamic-callee");
    assert.equal("observation" in gapsEnv.data, false);

    // (c) Findings + gaps coexisting -> exit 1 and both diagnostics & gaps preserved
    const mixedText = await captureCli(
      ["check", "--config", "verule.findings-and-gaps.config.mjs"],
      root,
    );
    assert.equal(mixedText.status, 1, mixedText.stderr);
    assert.match(mixedText.stdout, /mixed-flow-and-gap/u);
    assert.match(mixedText.stdout, /gap \[dynamic-callee\]/u);
    assert.match(mixedText.stdout, /Found 1 violation\(s\) \(1 gap\(s\)\)/u);

    const mixedJson = await captureCli(
      [
        "check",
        "--config",
        "verule.findings-and-gaps.config.mjs",
        "--output",
        "json",
      ],
      root,
    );
    assert.equal(mixedJson.status, 1, mixedJson.stderr);
    const mixedEnv = JSON.parse(mixedJson.stdout) as {
      variant: string;
      data: {
        status: string;
        diagnostics: { evidence: { at?: { file: string } }[] }[];
        gaps: { kind: string }[];
        observation?: unknown;
      };
    };
    assert.equal(mixedEnv.variant, "findings");
    assert.equal(mixedEnv.data.diagnostics.length, 1);
    assert.ok(
      mixedEnv.data.diagnostics[0]!.evidence.some(
        (e) => e.at?.file === "src/bridge.js",
      ),
    );
    assert.ok(
      mixedEnv.data.diagnostics[0]!.evidence.some(
        (e) => e.at?.file === "src/sink.ts",
      ),
    );
    assert.equal(mixedEnv.data.gaps.length, 1);
    assert.equal(mixedEnv.data.gaps[0]?.kind, "dynamic-callee");
    assert.equal("observation" in mixedEnv.data, false);

    // (d) Rule actively escalates gap to violation -> exit 1
    const escalateJson = await captureCli(
      [
        "check",
        "--config",
        "verule.escalate-gap.config.mjs",
        "--output",
        "json",
      ],
      root,
    );
    assert.equal(escalateJson.status, 1, escalateJson.stderr);
    const escalateEnv = JSON.parse(escalateJson.stdout) as {
      variant: string;
      data: {
        status: string;
        diagnostics: { message: string }[];
        gaps: { kind: string }[];
      };
    };
    assert.equal(escalateEnv.variant, "findings");
    assert.equal(escalateEnv.data.diagnostics.length, 1);
    assert.match(
      escalateEnv.data.diagnostics[0]!.message,
      /Escalated dynamic gap/u,
    );
    assert.equal(escalateEnv.data.gaps.length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
