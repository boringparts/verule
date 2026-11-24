import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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

function createInstanceProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-instance-identity-"));
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
        include: ["src/**/*"],
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

void test("verule check distinguishes resource instances across factories/models, emits model evidence, and surfaces missing-model gaps", async () => {
  const root = createInstanceProject({
    "node_modules/@acme/lifecycle/index.d.ts": [
      "export interface IDisposable {",
      "  dispose(): void;",
      "}",
      "export declare class Disposable {",
      "  protected _register<T extends IDisposable>(o: T): T;",
      "}",
      "export interface IMenuService {",
      "  createMenu(id: number): IDisposable;",
      "}",
      "export declare function createUntracked(): IDisposable;",
      "",
    ].join("\n"),
    "node_modules/@acme/lifecycle/package.json": JSON.stringify(
      {
        name: "@acme/lifecycle",
        version: "1.0.0",
        types: "./index.d.ts",
      },
      null,
      2,
    ),
    "src/helpers.ts": [
      "import type { IDisposable } from '@acme/lifecycle';",
      "",
      "export class Resource implements IDisposable {",
      "  dispose(): void {}",
      "}",
      "",
      "export function createResource(): Resource {",
      "  return new Resource();",
      "}",
      "",
      "export function passthrough<T>(value: T): T {",
      "  return value;",
      "}",
      "",
    ].join("\n"),
    "src/app.ts": [
      "import { Disposable, type IDisposable, type IMenuService, createUntracked } from '@acme/lifecycle';",
      "import { createResource as makeRes, passthrough } from './helpers.js';",
      "",
      "function release(item: IDisposable): void {",
      "  item.dispose();",
      "}",
      "",
      "export class BadController extends Disposable {",
      "  private _current: IDisposable;",
      "  constructor(menuService: IMenuService) {",
      "    super();",
      "    const first = this._register(makeRes());",
      "    const second = menuService.createMenu(1);",
      "    this._current = first;",
      "    // Bug: releases `second` instead of `this._current` (`first`).",
      "    release(second);",
      "    const untracked = createUntracked();",
      "    void untracked;",
      "  }",
      "}",
      "",
      "export class GoodController extends Disposable {",
      "  private _current: IDisposable;",
      "  constructor() {",
      "    super();",
      "    const first = this._register(makeRes());",
      "    this._current = passthrough(first);",
      "    const fn = () => release(this._current);",
      "    void fn;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "verule.config.mjs": `
      export default {
        tsconfig: "tsconfig.json",
        models: [
          {
            id: "acme-lifecycle",
            version: "1.0.0",
            instanceBehaviors: [
              {
                kind: "forwards-argument",
                match: { module: "@acme/lifecycle", container: "Disposable", member: "_register" },
                argumentIndex: 0,
              },
              {
                kind: "allocates-fresh-instance",
                match: { module: "@acme/lifecycle", container: "IMenuService", member: "createMenu" },
              },
            ],
          },
        ],
        rules: [
          {
            id: "check-instance-cleanup-match",
            run: async (ctx) => {
              const classes = await ctx.findSyntax({ files: ["src/app.ts"], kinds: ["ClassDeclaration"] });
              const calls = await ctx.findSyntax({ files: ["src/app.ts"], kinds: ["CallExpression"] });
              const props = await ctx.findSyntax({ files: ["src/app.ts"], kinds: ["PropertyAccessExpression"] });
              const varDecls = await ctx.findSyntax({ files: ["src/app.ts"], kinds: ["VariableDeclaration"] });

              // Inspect unmodeled external call to confirm missing-instance-model gap is surfaced.
              const untrackedDecl = varDecls.find((d) => d.text.startsWith("untracked ="));
              if (untrackedDecl?.initializer) {
                await ctx.resolveInstances([untrackedDecl.initializer]);
              }

              for (const cls of classes) {
                const clsStart = cls.location.start;
                const clsEnd = cls.location.end;
                const releaseCall = calls.find(
                  (c) =>
                    c.location.start >= clsStart &&
                    c.location.end <= clsEnd &&
                    c.text.startsWith("release("),
                );
                const currentRead = props.find(
                  (p) =>
                    p.location.start >= clsStart &&
                    p.location.end <= clsEnd &&
                    p.text === "this._current" &&
                    p.location.start > (varDecls.find((d) => d.location.start >= clsStart && d.location.end <= clsEnd && d.text.startsWith("first ="))?.location.end ?? 0),
                );
                if (!releaseCall?.arguments?.[0] || !currentRead) continue;

                const [expectedRes, releasedRes] = await ctx.resolveInstances([
                  currentRead.ref,
                  releaseCall.arguments[0],
                ]);
                if (
                  expectedRes?.instance &&
                  releasedRes?.instance &&
                  expectedRes.instanceKey !== releasedRes.instanceKey
                ) {
                  ctx.report({
                    at: releaseCall.location,
                    message: "release() targets a different instance than this._current.",
                    basis: [expectedRes, releasedRes],
                  });
                }
              }
            },
          },
        ],
      };
    `,
  });

  try {
    const jsonRun = await captureCli(
      ["check", "--config", "verule.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(jsonRun.status, 1, jsonRun.stderr);

    const envelope = JSON.parse(jsonRun.stdout) as {
      readonly variant: string;
      readonly data: unknown;
    };
    assert.equal(envelope.variant, "findings");
    const parsedReport = checkReportSchema.parse(envelope.data);
    assert.equal(parsedReport.status, "findings");
    assert.equal(parsedReport.diagnostics.length, 1);

    const diag = parsedReport.diagnostics[0]!;
    assert.equal(diag.ruleId, "check-instance-cleanup-match");
    assert.equal(diag.at.file, "src/app.ts");
    assert.match(diag.message, /different instance/u);
    assert.ok(
      diag.evidence.some((e) => e.kind === "source"),
      "Expected source evidence in CLI report",
    );
    assert.ok(
      diag.evidence.some(
        (e) =>
          e.kind === "model" &&
          e.modelId === "acme-lifecycle" &&
          e.declaration?.includes("_register"),
      ),
      "Expected model evidence for Disposable._register",
    );
    assert.ok(
      diag.evidence.some(
        (e) =>
          e.kind === "model" &&
          e.modelId === "acme-lifecycle" &&
          e.declaration?.includes("createMenu"),
      ),
      "Expected model evidence for IMenuService.createMenu",
    );
    assert.ok(
      parsedReport.gaps.some((g) => g.kind === "missing-instance-model"),
      `Expected missing-instance-model gap, got ${JSON.stringify(parsedReport.gaps)}`,
    );

    const textRun = await captureCli(
      ["check", "--config", "verule.config.mjs"],
      root,
    );
    assert.equal(textRun.status, 1, textRun.stderr);
    assert.match(textRun.stdout, /evidence \(source\):/u);
    assert.match(
      textRun.stdout,
      /evidence \(model\): .*\[model=acme-lifecycle:/u,
    );
    assert.match(textRun.stdout, /gap \[missing-instance-model\]:/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
