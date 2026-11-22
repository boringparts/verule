import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";
import { checkReportSchema } from "../../src/report-wire.ts";

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

function createWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-package-behavior-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void test("verule check traces ESM import vs CJS require conditional exports and preserves signatures, model evidence, and gaps after removing implementations", async () => {
  const root = createWorkspace({
    "node_modules/dual-pkg/package.json": JSON.stringify(
      {
        name: "dual-pkg",
        version: "1.0.0",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.mjs",
            require: "./dist/index.cjs",
          },
        },
      },
      null,
      2,
    ),
    "node_modules/dual-pkg/dist/index.d.ts": [
      "export interface SessionToken {",
      "  readonly id: string;",
      "}",
      "export declare function forwardOrClone<T extends SessionToken>(token: T): T;",
      "export declare function modeledFactory<T extends SessionToken>(token: T): T;",
      "",
    ].join("\n"),
    "node_modules/dual-pkg/dist/index.mjs": [
      "export function forwardOrClone(token) { return token; }",
      "export function modeledFactory(token) { return token; }",
      "",
    ].join("\n"),
    "node_modules/dual-pkg/dist/index.cjs": [
      "exports.forwardOrClone = function(token) { return { ...token }; };",
      "exports.modeledFactory = function(token) { return { ...token }; };",
      "",
    ].join("\n"),
    "packages/esm/package.json": JSON.stringify({
      name: "esm-caller",
      type: "module",
    }),
    "packages/esm/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src/**/*"],
    }),
    "packages/esm/src/app.ts": [
      'import { forwardOrClone, modeledFactory, type SessionToken } from "dual-pkg";',
      "",
      "export function runEsm(): void {",
      '  const tok: SessionToken = { id: "esm" };',
      "  const out = forwardOrClone(tok);",
      "  const mod = modeledFactory(tok);",
      "  void [out, mod];",
      "}",
      "",
    ].join("\n"),
    "packages/cjs/package.json": JSON.stringify({
      name: "cjs-caller",
      type: "commonjs",
    }),
    "packages/cjs/tsconfig.json": JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src/**/*"],
    }),
    "packages/cjs/src/app.ts": [
      'import dual = require("dual-pkg");',
      "",
      "export function runCjs(): void {",
      '  const tok = { id: "cjs" };',
      "  const out = dual.forwardOrClone(tok);",
      "  void out;",
      "}",
      "",
    ].join("\n"),
    "verule.config.mjs": `
      export default {
        projects: ["packages/esm/tsconfig.json", "packages/cjs/tsconfig.json"],
        models: [
          {
            id: "dual-pkg-model",
            instanceBehaviors: [
              {
                kind: "forwards-argument",
                match: { module: "dual-pkg", member: "modeledFactory" },
                argumentIndex: 0,
              },
            ],
          },
        ],
        rules: [
          {
            id: "check-conditional-package-copy",
            run: async (ctx) => {
              const varDecls = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
              const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
              const tokDecl = varDecls.find((d) => d.text.startsWith("tok"));
              const outDecl = varDecls.find((d) => d.text.startsWith("out ="));
              const modDecl = varDecls.find((d) => d.text.startsWith("mod ="));
              const callSyn = calls.find((c) => c.text.includes("forwardOrClone("));
              if (!tokDecl?.initializer || !outDecl?.initializer || !callSyn) return;

              const [callProj] = await ctx.resolveCalls([callSyn.ref], {
                select: { returnType: true, signature: true },
              });
              if (!callProj?.returnType || !callProj.signature) {
                throw new Error("Expected signature and return type from declaration");
              }

              const [implRes] = await ctx.resolveImplementations([callSyn.ref]);
              const [tokInst, outInst] = await ctx.resolveInstances([
                tokDecl.initializer,
                outDecl.initializer,
              ]);
              if (modDecl?.initializer) {
                await ctx.resolveInstances([modDecl.initializer]);
              }

              if (
                tokInst?.instance &&
                outInst?.instance &&
                tokInst.instanceKey !== outInst.instanceKey
              ) {
                ctx.report({
                  at: outDecl.location,
                  message: "Conditional export returned a cloned copy instead of the original instance.",
                  evidence: [...outInst.evidence, ...(implRes?.evidence ?? [])],
                });
              }
            },
          },
        ],
      };
    `,
  });

  try {
    // Phase 1: with implementations present -> ESM forwards (clean), CJS clones (finding with .cjs evidence)
    const json1 = await captureCli(
      ["check", "--config", "verule.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(json1.status, 1, json1.stderr);
    const env1 = JSON.parse(json1.stdout) as {
      readonly variant: string;
      readonly data: unknown;
    };
    assert.equal(env1.variant, "findings");
    const report1 = checkReportSchema.parse(env1.data);
    assert.equal(report1.diagnostics.length, 1);
    const diag = report1.diagnostics[0]!;
    assert.equal(diag.at.file, "packages/cjs/src/app.ts");
    assert.ok(
      diag.evidence.some(
        (e) => e.at?.file === "node_modules/dual-pkg/dist/index.cjs",
      ),
      `Expected evidence inside dist/index.cjs, got ${JSON.stringify(diag.evidence)}`,
    );
    for (const proj of report1.projects) {
      assert.ok(proj.sourceFiles.every((f) => !f.includes("node_modules/")));
    }
    assert.ok(
      report1.fileOrigins.every((o) => !o.file.includes("node_modules/")),
    );

    // Phase 2: remove `.mjs` and `.cjs` implementations, leaving only `.d.ts`
    unlinkSync(join(root, "node_modules/dual-pkg/dist/index.mjs"));
    unlinkSync(join(root, "node_modules/dual-pkg/dist/index.cjs"));

    const json2 = await captureCli(
      ["check", "--config", "verule.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(json2.status, 0, json2.stderr);
    const env2 = JSON.parse(json2.stdout) as {
      readonly variant: string;
      readonly data: unknown;
    };
    assert.equal(env2.variant, "clean");
    const report2 = checkReportSchema.parse(env2.data);
    assert.equal(report2.diagnostics.length, 0);
    assert.ok(
      report2.gaps.some((g) => g.kind === "missing-instance-model"),
      `Expected missing-instance-model gap, got ${JSON.stringify(report2.gaps)}`,
    );
    assert.ok(
      report2.gaps.some((g) => g.kind === "missing-package-implementation"),
      `Expected missing-package-implementation gap, got ${JSON.stringify(report2.gaps)}`,
    );

    const text2 = await captureCli(
      ["check", "--config", "verule.config.mjs"],
      root,
    );
    assert.equal(text2.status, 0, text2.stderr);
    assert.match(text2.stdout, /gap \[missing-instance-model\]:/u);
    assert.match(text2.stdout, /gap \[missing-package-implementation\]:/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
