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

function createProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-call-effects-"));
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

void test("verule check and --at explain verify close-A-clean-B, cross-file helpers, dynamic Gaps, validation vs raw, and reentrant scheduler callback field effects", async () => {
  const root = createProject({
    "node_modules/@acme/lifecycle/index.d.ts": [
      "export interface IDisposable { dispose(): void; }",
      "export declare function createResource(label: string): IDisposable;",
      "export declare function onDidClose(cb: () => void): IDisposable;",
      "",
    ].join("\n"),
    "node_modules/@acme/lifecycle/package.json": JSON.stringify({
      name: "@acme/lifecycle",
      version: "1.0.0",
      types: "./index.d.ts",
    }),
    "src/helpers.ts": [
      "import type { IDisposable } from '@acme/lifecycle';",
      "export function releaseHelper(item: IDisposable): void {",
      "  item.dispose();",
      "}",
      "",
    ].join("\n"),
    "src/errorHandling.ts": [
      "export function callWithErrorHandling(fn: (...args: unknown[]) => unknown, args?: unknown[]): unknown {",
      "  return args ? fn(...args) : fn();",
      "}",
      "",
    ].join("\n"),
    "src/resources.ts": [
      "import { createResource, onDidClose } from '@acme/lifecycle';",
      "import { releaseHelper } from './helpers.js';",
      "",
      "export function closeAWronglyCleansB(): void {",
      "  const resA = createResource('A');",
      "  const resB = createResource('B');",
      "  onDidClose(() => {",
      "    releaseHelper(resB);",
      "  });",
      "  void resA;",
      "}",
      "",
      "export function closeACleanly(extraCb?: () => void): void {",
      "  const resA = createResource('A-clean');",
      "  onDidClose(() => {",
      "    releaseHelper(resA);",
      "    extraCb?.();",
      "  });",
      "}",
      "",
    ].join("\n"),
    "src/validation.ts": [
      "export function validate(raw: string): { ok: true; data: string } | { ok: false } {",
      "  const trimmed = raw.trim();",
      "  return trimmed ? { ok: true, data: trimmed } : { ok: false };",
      "}",
      "export function sink(_v: string): void {}",
      "export function badRoute(raw: string): void {",
      "  const parsed = validate(raw);",
      "  if (!parsed.ok) return;",
      "  sink(raw);",
      "}",
      "export function goodRoute(raw: string): void {",
      "  const parsed = validate(raw);",
      "  if (!parsed.ok) return;",
      "  sink(parsed.data);",
      "}",
      "",
    ].join("\n"),
    "src/scheduler.ts": [
      "import { callWithErrorHandling } from './errorHandling.js';",
      "const QUEUED = 1;",
      "const ALLOW_RECURSE = 4;",
      "export interface Job { (): void; flags: number; }",
      "export function queueJob(job: Job): void {",
      "  job.flags |= QUEUED;",
      "}",
      "export function flushJobBuggy(job: Job): void {",
      "  callWithErrorHandling(() => {",
      "    queueJob(job);",
      "  });",
      "  job.flags &= ~QUEUED;",
      "}",
      "export function flushJobFixed(job: Job): void {",
      "  callWithErrorHandling(() => {",
      "    queueJob(job);",
      "  });",
      "  if (!(job.flags & ALLOW_RECURSE)) {",
      "    job.flags &= ~QUEUED;",
      "  }",
      "}",
      "",
    ].join("\n"),
    "verule.config.mjs": `import { defineConfig, defineModel, defineRule, isSameInstance } from ${JSON.stringify(import.meta.resolve("@verule/sdk"))};

const lifecycleModel = defineModel({
  id: "cli-lifecycle-model",
  instanceBehaviors: [
    { kind: "allocates-fresh-instance", match: { symbol: "createResource" } },
  ],
  cleanupOperations: [
    { kind: "disposes-target", match: { member: "dispose" }, target: "receiver" },
  ],
  lifecycleEvents: [
    { kind: "lifecycle-end-callback", match: { symbol: "onDidClose" }, callbackArgumentIndex: 0 },
  ],
});

const cleanupRule = defineRule({
  id: "resource-cleanup",
  run: async (ctx) => {
    const fns = await ctx.findSyntax({ files: ["src/resources.ts"], kinds: ["FunctionDeclaration"] });
    const vars = await ctx.findSyntax({ files: ["src/resources.ts"], kinds: ["VariableDeclaration"] });
    const calls = await ctx.findSyntax({ files: ["src/resources.ts"], kinds: ["CallExpression"] });

    for (const fn of fns) {
      const resAVar = vars.find((v) => v.location.start >= fn.location.start && v.location.end <= fn.location.end && v.text.startsWith("resA ="));
      const closeCall = calls.find((c) => c.location.start >= fn.location.start && c.location.end <= fn.location.end && c.text.startsWith("onDidClose("));
      if (!resAVar?.initializer || !closeCall) continue;

      const [instRes] = await ctx.resolveInstances([resAVar.initializer]);
      if (!instRes?.instance) continue;

      const [cleanup] = await ctx.instanceCleanup({
        scopes: [closeCall.ref],
        targets: [instRes.instance],
      });
      const tr = cleanup?.targetResults[0];
      if (tr && !tr.cleanedOnAllPaths) {
        const wrong = cleanup.disposedInstances.find((d) => !isSameInstance(d.instance, instRes.instance));
        ctx.report({
          at: resAVar.location,
          message: wrong
            ? \`Closed A (\${tr.instanceKey}) but disposed B (\${wrong.instanceKey}) instead.\`
            : \`Resource A (\${tr.instanceKey}) was not disposed.\`,
          basis: wrong ? [tr, wrong] : [tr],
        });
      }
    }
  },
});

const validationRule = defineRule({
  id: "validated-arg",
  run: async (ctx) => {
    const fns = await ctx.findSyntax({ files: ["src/validation.ts"], kinds: ["FunctionDeclaration"] });
    const calls = await ctx.findSyntax({ files: ["src/validation.ts"], kinds: ["CallExpression"] });
    const branchesList = await ctx.listBranches(fns.map((f) => f.ref));
    const effects = await ctx.callEffects({ targets: fns.map((f) => f.ref) });

    for (const [idx, fn] of fns.entries()) {
      if (!fn.text.includes("Route(")) continue;
      const rawParam = fn.parameters?.[0];
      const sinkCall = calls.find((c) => c.location.start >= fn.location.start && c.location.end <= fn.location.end && c.text.startsWith("sink("));
      if (!rawParam || !sinkCall) continue;
      const [resolvedSink] = await ctx.resolveCalls([sinkCall.ref], { select: { arguments: true } });
      const sinkArg = resolvedSink?.arguments?.[0];
      if (!sinkArg) continue;

      const okFalse = branchesList[idx]?.branches.find((b) => b.conditionText.includes("parsed.ok") && b.direction === "false");
      const [cov] = await ctx.branchCoverage({ function: fn.ref, branches: okFalse ? [okFalse.ref] : [], targets: [sinkCall.ref] });
      const rawProp = await ctx.valuePropagation({ from: rawParam, to: sinkArg });
      const dataReads = effects[idx].fieldReads.filter((r) => r.propertyName === "data").map((r) => r.syntax);
      const dataProp = dataReads.length > 0 ? await ctx.valuePropagation({ from: dataReads, to: sinkArg }) : null;

      if (cov?.status !== "covered" || rawProp.reachableTargets.length > 0 || (dataProp?.reachableTargets.length ?? 0) === 0) {
        ctx.report({ at: sinkCall.location, message: "sink() received raw unvalidated value despite passing parsed.ok branch." });
      }
    }
  },
});

const schedulerRule = defineRule({
  id: "scheduler-flag-guard",
  run: async (ctx) => {
    const fns = await ctx.findSyntax({ files: ["src/scheduler.ts"], kinds: ["FunctionDeclaration"] });
    const effects = await ctx.callEffects({ targets: fns.map((f) => f.ref) });
    const branchesList = await ctx.listBranches(fns.map((f) => f.ref));

    for (const [idx, fn] of fns.entries()) {
      if (!fn.text.includes("flushJob")) continue;
      const eff = effects[idx];
      const requeue = eff.fieldWrites.find((w) => w.propertyName === "flags" && w.operator === "|=");
      const clearWrite = eff.fieldWrites.find((w) => w.propertyName === "flags" && w.operator === "&=" && w.viaCall === null);
      if (!requeue || !clearWrite) continue;

      const guardBranches = branchesList[idx].branches.filter((b) => b.conditionText.includes("ALLOW_RECURSE") && b.direction === "true");
      const [cov] = await ctx.branchCoverage({ function: fn.ref, branches: guardBranches.map((b) => b.ref), targets: [clearWrite.syntax] });
      if (cov?.status !== "covered") {
        ctx.report({ at: clearWrite.location, message: "Post-callback flag clear is missing ALLOW_RECURSE guard.", basis: cov ? [requeue, clearWrite, cov] : [requeue, clearWrite] });
      }
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  models: [lifecycleModel],
  rules: [cleanupRule, validationRule, schedulerRule],
});
`,
  });

  try {
    // 1. Run full `verule check --output json`
    const jsonRes = await captureCli(["check", "--output", "json"], root);
    assert.equal(
      jsonRes.status,
      1,
      `stdout=${jsonRes.stdout}\nstderr=${jsonRes.stderr}`,
    );
    const envelope = JSON.parse(jsonRes.stdout) as {
      readonly data: unknown;
    };
    const report = checkReportSchema.parse(envelope.data);
    assert.equal(report.status, "findings");
    assert.equal(report.diagnostics.length, 3);
    assert.ok(
      report.diagnostics.some(
        (d) =>
          d.ruleId === "resource-cleanup" &&
          d.message.includes("Closed A") &&
          d.message.includes("disposed B"),
      ),
    );
    assert.ok(
      report.diagnostics.some(
        (d) => d.ruleId === "validated-arg" && d.at.line === 9,
      ),
    );
    assert.ok(
      report.diagnostics.some(
        (d) => d.ruleId === "scheduler-flag-guard" && d.at.line === 12,
      ),
    );
    assert.ok(report.gaps.some((g) => g.kind === "dynamic-callee"));

    // 2. Run `verule check --rule resource-cleanup --at src/resources.ts:14 --output json` for explain cleanupPaths
    // Exit status is 1 because `closeAWronglyCleansB` in the same file has a finding, while `--at` explains line 14 (`covered_by_cleanup`).
    const explainJsonRes = await captureCli(
      [
        "check",
        "--rule",
        "resource-cleanup",
        "--at",
        "src/resources.ts:14",
        "--output",
        "json",
      ],
      root,
    );
    assert.equal(explainJsonRes.status, 1);
    const explainEnvelope = JSON.parse(explainJsonRes.stdout) as {
      readonly data: unknown;
    };
    const explainReport = checkReportSchema.parse(explainEnvelope.data);
    assert.equal(explainReport.explanation?.status, "covered_by_cleanup");
    assert.equal(explainReport.explanation?.cleanupPaths.length, 1);
    assert.ok(
      explainReport.explanation?.cleanupPaths[0]?.cleanupLocations.some(
        (l) => l.file === "src/resources.ts" && l.line === 16,
      ),
    );

    // 3. Also verify human text output renders `covered_by_cleanup` and `cleanupPath`
    const explainTextRes = await captureCli(
      ["check", "--rule", "resource-cleanup", "--at", "src/resources.ts:14"],
      root,
    );
    assert.equal(explainTextRes.status, 1);
    assert.match(explainTextRes.stdout, /covered_by_cleanup/);
    assert.match(explainTextRes.stdout, /cleanupPath/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
