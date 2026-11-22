import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  defineConfig,
  defineModel,
  defineRule,
  isSameInstance,
  openSession,
  runCheck,
  type InstanceResolutionResult,
  type SyntaxRef,
} from "@verule/sdk";

function createTempWorkspace(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-package-behavior-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void describe("@verule/sdk package behavior resolution", () => {
  void it("resolves conditional exports separately for ESM import and CJS require callers without expanding checked source files", async () => {
    const root = createTempWorkspace({
      "node_modules/dual-pkg/package.json": JSON.stringify(
        {
          name: "dual-pkg",
          version: "1.2.3",
          exports: {
            ".": {
              types: "./dist/index.d.ts",
              import: "./dist/index.mjs",
              require: "./dist/index.cjs",
            },
            "./sub": {
              types: "./dist/sub.d.ts",
              import: "./dist/sub.mjs",
              require: "./dist/sub.cjs",
            },
          },
        },
        null,
        2,
      ),
      "node_modules/dual-pkg/dist/index.d.ts": [
        "export interface Payload {",
        "  readonly id: string;",
        "}",
        "export declare function transformPayload<T extends Payload>(input: T): T;",
        "",
      ].join("\n"),
      "node_modules/dual-pkg/dist/index.mjs": [
        "export function transformPayload(input) {",
        "  return input;",
        "}",
        "",
      ].join("\n"),
      "node_modules/dual-pkg/dist/index.cjs": [
        "exports.transformPayload = function transformPayload(input) {",
        "  return { ...input };",
        "};",
        "",
      ].join("\n"),
      "node_modules/dual-pkg/dist/sub.d.ts": [
        "import type { Payload } from './index.js';",
        "export declare function transformSub<T extends Payload>(input: T): T;",
        "",
      ].join("\n"),
      "node_modules/dual-pkg/dist/sub.mjs": [
        "export function transformSub(input) {",
        "  const forwarded = input;",
        "  return forwarded;",
        "}",
        "",
      ].join("\n"),
      "node_modules/dual-pkg/dist/sub.cjs": [
        "function transformSub(input) {",
        "  return { ...input };",
        "}",
        "module.exports = { transformSub };",
        "",
      ].join("\n"),
      "packages/esm-app/package.json": JSON.stringify({
        name: "esm-app",
        type: "module",
      }),
      "packages/esm-app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*"],
      }),
      "packages/esm-app/src/app.ts": [
        'import { transformPayload, type Payload } from "dual-pkg";',
        'import { transformSub } from "dual-pkg/sub";',
        "",
        "export function runEsm(): void {",
        '  const input: Payload = { id: "esm" };',
        "  const mainOut = transformPayload(input);",
        "  const subOut = transformSub(input);",
        "  void [mainOut, subOut];",
        "}",
        "",
      ].join("\n"),
      "packages/cjs-app/package.json": JSON.stringify({
        name: "cjs-app",
        type: "commonjs",
      }),
      "packages/cjs-app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*"],
      }),
      "packages/cjs-app/src/app.ts": [
        'import dual = require("dual-pkg");',
        'import { transformSub } from "dual-pkg/sub";',
        "",
        "export function runCjs(): void {",
        '  const input = { id: "cjs" };',
        "  const mainOut = dual.transformPayload(input);",
        "  const subOut = transformSub(input);",
        "  void [mainOut, subOut];",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const observations = new Map<
        string,
        {
          readonly mainImplFile: string | null;
          readonly mainMode: string | null;
          readonly mainSubpath: string | null;
          readonly mainVersion: string | null;
          readonly subImplFile: string | null;
          readonly subMode: string | null;
          readonly subSubpath: string | null;
          readonly mainPropReachable: boolean;
          readonly mainPropEvidenceFiles: readonly string[];
          readonly subPropReachable: boolean;
          readonly inputInst: InstanceResolutionResult;
          readonly mainOutInst: InstanceResolutionResult;
          readonly subOutInst: InstanceResolutionResult;
        }
      >();

      const rule = defineRule({
        id: "inspect-conditional-exports",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({
            kinds: ["CallExpression"],
          });
          const mainCallSyntax = calls.find((c) =>
            c.text.includes("transformPayload("),
          );
          const subCallSyntax = calls.find((c) =>
            c.text.includes("transformSub("),
          );
          assert.ok(mainCallSyntax && subCallSyntax);

          const [mainCallRow, subCallRow] = await ctx.resolveCalls([
            mainCallSyntax.ref,
            subCallSyntax.ref,
          ]);
          assert.ok(mainCallRow?.call && subCallRow?.call);

          const [mainImpl, subImpl] = await ctx.resolveImplementations([
            mainCallRow.call,
            subCallRow.call,
          ]);
          assert.ok(mainImpl && subImpl);

          const [mainCalleeInfo] = await ctx.calleesOf([mainCallRow.call]);
          assert.ok(mainCalleeInfo);
          assert.equal(
            mainCalleeInfo.resolvedTargets[0]?.implementation?.file,
            mainImpl.implementation?.file,
          );
          const retExprs =
            mainCalleeInfo.resolvedTargets[0]?.returnExpressions ?? [];
          assert.ok(retExprs.length > 0);
          const [retSyn] = await ctx.syntaxOf([retExprs[0]!], {
            select: { location: true },
          });
          assert.equal(retSyn?.location?.file, mainImpl.implementation?.file);

          const varDecls = await ctx.findSyntax({
            kinds: ["VariableDeclaration"],
          });
          const findInit = (prefix: string): SyntaxRef => {
            const found = varDecls.find((d) => d.text.startsWith(prefix));
            assert.ok(found?.initializer, `Missing ${prefix}`);
            return found.initializer;
          };
          const inputInit = findInit("input");
          const mainOutInit = findInit("mainOut");
          const subOutInit = findInit("subOut");

          const [inputDeclRow, mainOutDeclRow, subOutDeclRow] =
            await ctx.resolveDeclarations([
              varDecls.find((d) => d.text.startsWith("input"))!.ref,
              varDecls.find((d) => d.text.startsWith("mainOut"))!.ref,
              varDecls.find((d) => d.text.startsWith("subOut"))!.ref,
            ]);

          const prop = await ctx.valuePropagation({
            propagation: "value",
            from: inputInit,
            to: [mainOutDeclRow!.declaration!, subOutDeclRow!.declaration!],
          });

          const [inputInst, mainOutInst, subOutInst] =
            await ctx.resolveInstances([
              inputDeclRow!.declaration!,
              mainOutInit,
              subOutInit,
            ]);
          assert.ok(inputInst && mainOutInst && subOutInst);

          const key = ctx.project.configFile.includes("esm-app")
            ? "esm"
            : "cjs";
          observations.set(key, {
            mainImplFile: mainImpl.implementation?.file ?? null,
            mainMode: mainImpl.implementation?.resolutionMode ?? null,
            mainSubpath: mainImpl.implementation?.subpath ?? null,
            mainVersion: mainImpl.implementation?.packageVersion ?? null,
            subImplFile: subImpl.implementation?.file ?? null,
            subMode: subImpl.implementation?.resolutionMode ?? null,
            subSubpath: subImpl.implementation?.subpath ?? null,
            mainPropReachable: prop.results[0]!.reachable,
            mainPropEvidenceFiles: prop.results[0]!.evidence.map(
              (e) => e.at?.file,
            ).filter((f): f is string => f !== undefined),
            subPropReachable: prop.results[1]!.reachable,
            inputInst,
            mainOutInst,
            subOutInst,
          });
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          projects: [
            "packages/esm-app/tsconfig.json",
            "packages/cjs-app/tsconfig.json",
          ],
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      for (const proj of report.projects) {
        assert.ok(
          proj.sourceFiles.every((f) => !f.includes("node_modules/")),
          `node_modules must not enter ProjectSummary.sourceFiles: ${proj.sourceFiles.join(", ")}`,
        );
      }
      assert.ok(
        report.fileOrigins.every((o) => !o.file.includes("node_modules/")),
        `node_modules must not enter CheckReport.fileOrigins`,
      );

      const esm = observations.get("esm");
      const cjs = observations.get("cjs");
      assert.ok(esm && cjs);

      assert.equal(esm.mainImplFile, "node_modules/dual-pkg/dist/index.mjs");
      assert.equal(esm.mainMode, "import");
      assert.equal(esm.mainSubpath, ".");
      assert.equal(esm.mainVersion, "1.2.3");
      assert.equal(esm.subImplFile, "node_modules/dual-pkg/dist/sub.mjs");
      assert.equal(esm.subMode, "import");
      assert.equal(esm.subSubpath, "./sub");
      assert.equal(esm.mainPropReachable, true);
      assert.ok(
        esm.mainPropEvidenceFiles.includes(
          "node_modules/dual-pkg/dist/index.mjs",
        ),
      );
      assert.equal(esm.subPropReachable, true);
      assert.equal(
        isSameInstance(esm.inputInst.instance, esm.mainOutInst.instance),
        true,
      );
      assert.equal(
        isSameInstance(esm.inputInst.instance, esm.subOutInst.instance),
        true,
      );
      assert.ok(
        esm.mainOutInst.evidence.some(
          (e) => e.at?.file === "node_modules/dual-pkg/dist/index.mjs",
        ),
      );

      assert.equal(cjs.mainImplFile, "node_modules/dual-pkg/dist/index.cjs");
      assert.equal(cjs.mainMode, "require");
      assert.equal(cjs.mainSubpath, ".");
      assert.equal(cjs.subImplFile, "node_modules/dual-pkg/dist/sub.cjs");
      assert.equal(cjs.subMode, "require");
      assert.equal(cjs.subSubpath, "./sub");
      assert.equal(cjs.mainPropReachable, false);
      assert.equal(cjs.subPropReachable, false);
      assert.equal(
        isSameInstance(cjs.inputInst.instance, cjs.mainOutInst.instance),
        false,
      );
      assert.equal(
        isSameInstance(cjs.inputInst.instance, cjs.subOutInst.instance),
        false,
      );
      assert.equal(
        cjs.mainOutInst.allocationLocation?.file,
        "node_modules/dual-pkg/dist/index.cjs",
      );
      assert.equal(
        cjs.subOutInst.allocationLocation?.file,
        "node_modules/dual-pkg/dist/sub.cjs",
      );
      assert.ok(
        cjs.mainOutInst.evidence.some(
          (e) => e.at?.file === "node_modules/dual-pkg/dist/index.cjs",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("covers workspace symlinks, pure-JS dependencies, customConditions isolation, and intra-project .mts/.cts conditions", async () => {
    const root = createTempWorkspace({
      "packages/ws-ts/package.json": JSON.stringify({
        name: "@ws/ts-relay",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "packages/ws-ts/src/index.ts": [
        "export function relayTs<T>(x: T): T {",
        "  return x;",
        "}",
        "",
      ].join("\n"),
      "packages/ws-js/package.json": JSON.stringify({
        name: "@ws/js-relay",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.js" },
      }),
      "packages/ws-js/src/index.js": [
        "/** @template T @param {T} x @returns {T} */",
        "export function relayJs(x) {",
        "  return x;",
        "}",
        "",
      ].join("\n"),
      "node_modules/pure-js-dep/package.json": JSON.stringify({
        name: "pure-js-dep",
        version: "1.0.0",
        main: "./index.js",
      }),
      "node_modules/pure-js-dep/index.js": [
        "export function passPureJs(x) {",
        "  const ref = x;",
        "  return ref;",
        "}",
        "",
      ].join("\n"),
      "node_modules/cond-custom/package.json": JSON.stringify({
        name: "cond-custom",
        version: "2.0.0",
        exports: {
          ".": {
            "fast-forward": "./dist/fast.mjs",
            "safe-clone": "./dist/clone.mjs",
            types: "./dist/index.d.ts",
            import: "./dist/fast.mjs",
            require: "./dist/clone.cjs",
          },
        },
      }),
      "node_modules/cond-custom/dist/index.d.ts": [
        "export declare function adapt<T extends object>(value: T): T;",
        "",
      ].join("\n"),
      "node_modules/cond-custom/dist/fast.mjs": [
        "export function adapt(value) {",
        "  return value;",
        "}",
        "",
      ].join("\n"),
      "node_modules/cond-custom/dist/clone.mjs": [
        "export function adapt(value) {",
        "  return { ...value };",
        "}",
        "",
      ].join("\n"),
      "node_modules/cond-custom/dist/clone.cjs": [
        "exports.adapt = function adapt(value) {",
        "  return { ...value };",
        "};",
        "",
      ].join("\n"),
      "packages/shared/entry.ts": [
        'import { adapt } from "cond-custom";',
        "",
        "export function runShared(): void {",
        "  const seed = { tag: 1 };",
        "  const out = adapt(seed);",
        "  void out;",
        "}",
        "",
      ].join("\n"),
      "packages/fast-proj/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          customConditions: ["fast-forward"],
        },
        include: ["../shared/entry.ts"],
      }),
      "packages/clone-proj/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          customConditions: ["safe-clone"],
        },
        include: ["../shared/entry.ts"],
      }),
      "packages/mixed-app/tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          allowJs: true,
          maxNodeModuleJsDepth: 1,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*"],
      }),
      "packages/mixed-app/src/esm.mts": [
        'import { relayTs } from "@ws/ts-relay";',
        'import { relayJs } from "@ws/js-relay";',
        'import { passPureJs } from "pure-js-dep";',
        'import { adapt } from "cond-custom";',
        "",
        "export function runEsm(): void {",
        "  const base = { kind: 'a' };",
        "  const viaWs = relayTs(base);",
        "  const viaWsJs = relayJs(viaWs);",
        "  const viaJs = passPureJs(viaWsJs);",
        "  const viaCond = adapt(viaJs);",
        "  void viaCond;",
        "}",
        "",
      ].join("\n"),
      "packages/mixed-app/src/cjs.cts": [
        'import cond = require("cond-custom");',
        "",
        "export function runCjs(): void {",
        "  const base = { kind: 'b' };",
        "  const viaCond = cond.adapt(base);",
        "  void viaCond;",
        "}",
        "",
      ].join("\n"),
    });

    mkdirSync(join(root, "node_modules/@ws"), { recursive: true });
    symlinkSync(
      join(root, "packages/ws-ts"),
      join(root, "node_modules/@ws/ts-relay"),
      "dir",
    );
    symlinkSync(
      join(root, "packages/ws-js"),
      join(root, "node_modules/@ws/js-relay"),
      "dir",
    );

    try {
      const condResults = new Map<
        string,
        { readonly same: boolean; readonly file: string | null }
      >();
      let mixedWsSame = false;
      let mixedJsSame = false;
      let mixedEsmSame = false;
      let mixedCjsSame = true;
      let mixedPureJsImplFile: string | null = null;
      let mixedEsmImplFile: string | null = null;
      let mixedCjsImplFile: string | null = null;
      let mixedJsPropReachable = false;

      const rule = defineRule({
        id: "check-entries-and-conditions",
        run: async (ctx) => {
          if (ctx.project.configFile.includes("mixed-app")) {
            const varDecls = await ctx.findSyntax({
              kinds: ["VariableDeclaration"],
            });
            const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });

            const esmVars = await ctx.findSyntax({
              files: ["packages/mixed-app/src/esm.mts"],
              kinds: ["VariableDeclaration"],
            });
            const esmCalls = await ctx.findSyntax({
              files: ["packages/mixed-app/src/esm.mts"],
              kinds: ["CallExpression"],
            });
            const cjsVars = await ctx.findSyntax({
              files: ["packages/mixed-app/src/cjs.cts"],
              kinds: ["VariableDeclaration"],
            });
            const cjsCalls = await ctx.findSyntax({
              files: ["packages/mixed-app/src/cjs.cts"],
              kinds: ["CallExpression"],
            });

            const esmBase = esmVars.find((v) => v.text.startsWith("base ="));
            const viaWs = esmVars.find((v) => v.text.startsWith("viaWs ="));
            const viaWsJs = esmVars.find((v) => v.text.startsWith("viaWsJs ="));
            const viaJs = esmVars.find((v) => v.text.startsWith("viaJs ="));
            const viaCondEsm = esmVars.find((v) =>
              v.text.startsWith("viaCond ="),
            );
            const cjsBase = cjsVars.find((v) => v.text.startsWith("base ="));
            const viaCondCjs = cjsVars.find((v) =>
              v.text.startsWith("viaCond ="),
            );
            assert.ok(
              esmBase?.initializer &&
                viaWs?.initializer &&
                viaWsJs?.initializer &&
                viaJs?.initializer &&
                viaCondEsm?.initializer &&
                cjsBase?.initializer &&
                viaCondCjs?.initializer,
            );

            const [
              bInst,
              wsInst,
              wsJsInst,
              jsInst,
              esmCondInst,
              cjsBInst,
              cjsCondInst,
            ] = await ctx.resolveInstances([
              esmBase.initializer,
              viaWs.initializer,
              viaWsJs.initializer,
              viaJs.initializer,
              viaCondEsm.initializer,
              cjsBase.initializer,
              viaCondCjs.initializer,
            ]);
            mixedWsSame =
              isSameInstance(bInst!.instance, wsInst!.instance) &&
              isSameInstance(bInst!.instance, wsJsInst!.instance);
            mixedJsSame = isSameInstance(bInst!.instance, jsInst!.instance);
            mixedEsmSame = isSameInstance(
              bInst!.instance,
              esmCondInst!.instance,
            );
            mixedCjsSame = isSameInstance(
              cjsBInst!.instance,
              cjsCondInst!.instance,
            );

            const [viaJsDecl] = await ctx.resolveDeclarations([viaJs.ref]);
            const prop = await ctx.valuePropagation({
              from: esmBase.initializer,
              to: viaJsDecl!.declaration!,
            });
            mixedJsPropReachable = prop.results[0]!.reachable;

            const pureJsCall = esmCalls.find((c) =>
              c.text.startsWith("passPureJs("),
            );
            const esmAdaptCall = esmCalls.find((c) =>
              c.text.startsWith("adapt("),
            );
            const cjsAdaptCall = cjsCalls.find((c) =>
              c.text.includes("cond.adapt("),
            );
            assert.ok(pureJsCall && esmAdaptCall && cjsAdaptCall);

            const [pureImpl, esmImpl, cjsImpl] =
              await ctx.resolveImplementations([
                pureJsCall.ref,
                esmAdaptCall.ref,
                cjsAdaptCall.ref,
              ]);
            mixedPureJsImplFile = pureImpl!.implementation?.file ?? null;
            mixedEsmImplFile = esmImpl!.implementation?.file ?? null;
            mixedCjsImplFile = cjsImpl!.implementation?.file ?? null;
            void [varDecls, calls];
            return;
          }

          const varDecls = await ctx.findSyntax({
            kinds: ["VariableDeclaration"],
          });
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const seed = varDecls.find((d) => d.text.startsWith("seed ="));
          const out = varDecls.find((d) => d.text.startsWith("out ="));
          const adaptCall = calls.find((c) => c.text.startsWith("adapt("));
          assert.ok(seed?.initializer && out?.initializer && adaptCall);
          const [seedInst, outInst] = await ctx.resolveInstances([
            seed.initializer,
            out.initializer,
          ]);
          const [impl] = await ctx.resolveImplementations([adaptCall.ref]);
          const key = ctx.project.configFile.includes("fast-proj")
            ? "fast"
            : "clone";
          condResults.set(key, {
            same: isSameInstance(seedInst!.instance, outInst!.instance),
            file: impl!.implementation?.file ?? null,
          });
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          projects: [
            "packages/fast-proj/tsconfig.json",
            "packages/clone-proj/tsconfig.json",
            "packages/mixed-app/tsconfig.json",
          ],
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      for (const proj of report.projects) {
        assert.ok(
          proj.sourceFiles.every((f) => !f.includes("node_modules/")),
          `node_modules must stay excluded from sourceFiles: ${proj.sourceFiles.join(", ")}`,
        );
      }

      assert.deepEqual(condResults.get("fast"), {
        same: true,
        file: "node_modules/cond-custom/dist/fast.mjs",
      });
      assert.deepEqual(condResults.get("clone"), {
        same: false,
        file: "node_modules/cond-custom/dist/clone.mjs",
      });

      assert.equal(mixedWsSame, true);
      assert.equal(mixedJsSame, true);
      assert.equal(mixedJsPropReachable, true);
      assert.equal(mixedEsmSame, true);
      assert.equal(mixedCjsSame, false);
      assert.equal(mixedPureJsImplFile, "node_modules/pure-js-dep/index.js");
      assert.equal(mixedEsmImplFile, "node_modules/cond-custom/dist/fast.mjs");
      assert.equal(mixedCjsImplFile, "node_modules/cond-custom/dist/clone.cjs");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("preserves signatures, known Model evidence, and explicit Gaps when implementations are removed, packages are missing, or mappings are ambiguous", async () => {
    const root = createTempWorkspace({
      "node_modules/removable-pkg/package.json": JSON.stringify({
        name: "removable-pkg",
        version: "1.0.0",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            import: "./dist/index.mjs",
            require: "./dist/index.cjs",
          },
        },
      }),
      "node_modules/removable-pkg/dist/index.d.ts": [
        "export interface Item {",
        "  readonly name: string;",
        "}",
        "export declare function modeledOp<T extends Item>(item: T): T;",
        "export declare function unmodeledOp<T extends Item>(item: T): T;",
        "",
      ].join("\n"),
      "node_modules/removable-pkg/dist/index.mjs": [
        "export function modeledOp(item) { return item; }",
        "export function unmodeledOp(item) { return item; }",
        "",
      ].join("\n"),
      "node_modules/removable-pkg/dist/index.cjs": [
        "exports.modeledOp = function(item) { return { ...item }; };",
        "exports.unmodeledOp = function(item) { return { ...item }; };",
        "",
      ].join("\n"),
      "node_modules/ambiguous-pkg/package.json": JSON.stringify({
        name: "ambiguous-pkg",
        version: "1.0.0",
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            default: ["./dist/a.mjs", "./dist/b.mjs"],
          },
        },
      }),
      "node_modules/ambiguous-pkg/dist/index.d.ts": [
        "export declare function ambigOp<T>(x: T): T;",
        "",
      ].join("\n"),
      "node_modules/ambiguous-pkg/dist/a.mjs":
        "export function ambigOp(x) { return x; }\n",
      "node_modules/ambiguous-pkg/dist/b.mjs":
        "export function ambigOp(x) { return { ...x }; }\n",
      "package.json": JSON.stringify({
        name: "removable-host",
        type: "module",
      }),
      "tsconfig.json": JSON.stringify({
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*"],
      }),
      "src/app.ts": [
        'import { modeledOp, unmodeledOp, type Item } from "removable-pkg";',
        'import { ambigOp } from "ambiguous-pkg";',
        "// @ts-ignore testing uninstalled package behavior",
        'import { missingFn } from "not-installed-pkg";',
        "",
        "export function run(): void {",
        '  const item: Item = { name: "x" };',
        "  const m = modeledOp(item);",
        "  const u = unmodeledOp(item);",
        "  const a = ambigOp(item);",
        "  const z = missingFn(item);",
        "  void [m, u, a, z];",
        "}",
        "",
      ].join("\n"),
    });

    const model = defineModel({
      id: "removable-model",
      instanceBehaviors: [
        {
          kind: "forwards-argument",
          match: { module: "removable-pkg", member: "modeledOp" },
          argumentIndex: 0,
        },
      ],
    });

    try {
      let modeledReturnType: string | null = null;
      let unmodeledReturnType: string | null = null;
      let modeledParamType: string | null = null;
      let modeledUsesModel = false;
      let modeledSame = false;
      let unmodeledSame = false;
      let unmodeledInstanceNull = false;
      let unmodeledGapKind: string | undefined;
      let unmodeledImplStatus: string | undefined;
      let ambigImplStatus: string | undefined;
      let ambigCandidateCount = 0;
      let ambigGapKind: string | undefined;
      let missingImplStatus: string | undefined;
      let missingGapKind: string | undefined;
      let missingGapMsg: string | undefined;

      const rule = defineRule({
        id: "check-declaration-only-and-gaps",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["CallExpression"],
          });
          const varDecls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["VariableDeclaration"],
          });

          const callOf = (prefix: string) => {
            const c = calls.find((node) => node.text.startsWith(prefix));
            assert.ok(c, `Missing call ${prefix}`);
            return c;
          };
          const initOf = (prefix: string): SyntaxRef => {
            const d = varDecls.find((node) => node.text.startsWith(prefix));
            assert.ok(d?.initializer, `Missing var ${prefix}`);
            return d.initializer;
          };

          const mCallSyn = callOf("modeledOp(");
          const uCallSyn = callOf("unmodeledOp(");
          const aCallSyn = callOf("ambigOp(");
          const zCallSyn = callOf("missingFn(");

          const resolvedCalls = await ctx.resolveCalls(
            [mCallSyn.ref, uCallSyn.ref],
            {
              select: {
                signature: true,
                instantiatedParameterTypes: [0],
                returnType: true,
              },
            },
          );
          const [mCallRow, uCallRow] = resolvedCalls;
          assert.ok(mCallRow?.call && uCallRow?.call);

          const [mProj, uProj] = await ctx.projectCalls(
            [mCallRow.call, uCallRow.call],
            {
              select: {
                signature: true,
                instantiatedParameterTypes: [0],
                returnType: true,
              },
            },
          );
          assert.ok(mProj?.signature && uProj?.signature);
          const [mSigProj] = await ctx.projectSignatures([mProj.signature], {
            select: { signatureText: true, parameters: true },
          });
          assert.ok(mSigProj?.signatureText?.includes("Item"));

          const [mRet, uRet, mParam0] = await ctx.projectTypes(
            [
              mProj.returnType!.ref,
              uProj.returnType!.ref,
              mProj.instantiatedParameterTypes[0]!.type.ref,
            ],
            { select: { typeText: true } },
          );
          modeledReturnType = mRet?.typeText ?? null;
          unmodeledReturnType = uRet?.typeText ?? null;
          modeledParamType = mParam0?.typeText ?? null;

          const [itemInst, mInst, uInst, aInst, zInst] =
            await ctx.resolveInstances([
              initOf("item"),
              initOf("m ="),
              initOf("u ="),
              initOf("a ="),
              initOf("z ="),
            ]);
          modeledSame = isSameInstance(itemInst!.instance, mInst!.instance);
          modeledUsesModel = mInst!.evidence.some(
            (e) => e.kind === "model" && e.modelId === "removable-model",
          );
          unmodeledSame = isSameInstance(itemInst!.instance, uInst!.instance);
          unmodeledInstanceNull = uInst!.instance === null;
          unmodeledGapKind = uInst!.gaps[0]?.kind;

          const [uImpl, aImpl, zImpl] = await ctx.resolveImplementations([
            uCallSyn.ref,
            aCallSyn.ref,
            zCallSyn.ref,
          ]);
          unmodeledImplStatus = uImpl!.status;
          ambigImplStatus = aImpl!.status;
          ambigCandidateCount = aImpl!.candidates.length;
          ambigGapKind = aInst!.gaps[0]?.kind;
          missingImplStatus = zImpl!.status;
          missingGapKind = zInst!.gaps[0]?.kind;
          missingGapMsg = zInst!.gaps[0]?.message;
        },
      });

      const session = await openSession({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          models: [model],
          rules: [rule],
        }),
      });
      try {
        // Phase 1: with implementations present, unmodeledOp resolves and traces to index.mjs.
        const initialReport = await session.check();
        assert.equal(initialReport.status, "clean");
        assert.equal(unmodeledImplStatus, "resolved");
        assert.equal(unmodeledInstanceNull, false);
        assert.equal(unmodeledSame, true);

        // Phase 2: remove runtime `.mjs` and `.cjs` implementations, leaving only `.d.ts`.
        unlinkSync(join(root, "node_modules/removable-pkg/dist/index.mjs"));
        unlinkSync(join(root, "node_modules/removable-pkg/dist/index.cjs"));
        await session.update();

        const afterRemovalReport = await session.check();
        assert.equal(afterRemovalReport.status, "clean");
        assert.equal(modeledReturnType, "Item");
        assert.equal(unmodeledReturnType, "Item");
        assert.equal(modeledParamType, "Item");
        assert.equal(modeledSame, true);
        assert.equal(modeledUsesModel, true);
        assert.equal(unmodeledInstanceNull, true);
        assert.equal(unmodeledGapKind, "missing-instance-model");
        assert.equal(unmodeledImplStatus, "declaration-only");
        assert.equal(ambigImplStatus, "ambiguous");
        assert.equal(ambigCandidateCount, 2);
        assert.equal(ambigGapKind, "ambiguous-package-implementation");
        assert.equal(missingImplStatus, "missing-package");
        assert.equal(missingGapKind, "missing-package");
        assert.ok(missingGapMsg?.includes("not-installed-pkg"));
      } finally {
        await session.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
