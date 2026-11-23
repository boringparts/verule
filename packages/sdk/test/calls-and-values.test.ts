import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  VeruleExecutionError,
  defineConfig,
  defineRule,
  openSession,
  runCheck,
  type CallRef,
  type DeclarationRef,
  type SyntaxRef,
} from "@verule/sdk";

function createTempProject(
  files: Record<string, string>,
  compilerOptions?: Record<string, unknown>,
): string {
  const root = mkdtempSync(join(tmpdir(), "verule-calls-values-test-"));
  if (!("tsconfig.json" in files)) {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            ...compilerOptions,
          },
          include: ["src/**/*"],
        },
        null,
        2,
      ),
      "utf8",
    );
  }
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void describe("@verule/sdk call graph and value propagation", () => {
  void it("resolves callersOf and calleesOf across aliases, same-name symbols, and dynamic call targets with gaps", async () => {
    const root = createTempProject({
      "src/inner.ts": [
        "export function processItem(item: string): string {",
        "  return item;",
        "}",
        "",
      ].join("\n"),
      "src/reexport.ts": [
        'export { processItem as forwardedProcess } from "./inner.js";',
        "",
      ].join("\n"),
      "src/other.ts": [
        "export function processItem(item: string): string {",
        "  return item;",
        "}",
        "",
      ].join("\n"),
      "src/entry.ts": [
        'import { forwardedProcess as aliasedProcess } from "./reexport.js";',
        'import { processItem as otherProcess } from "./other.js";',
        "",
        "interface Handler {",
        "  run: (value: string) => string;",
        "}",
        "",
        "export function runAll(",
        "  input: string,",
        "  flag: boolean,",
        "  cb: (v: string) => string,",
        "  handler: Handler,",
        "): string {",
        "  function processItem(localVal: string): string {",
        "    return localVal;",
        "  }",
        "  const a = aliasedProcess(input);",
        "  const b = otherProcess(input);",
        "  const c = processItem(input);",
        "  const mixed = flag ? aliasedProcess : cb;",
        "  const d = mixed(a);",
        "  const e = handler.run(b);",
        "  return `${c}:${d}:${e}`;",
        "}",
        "",
      ].join("\n"),
    });

    try {
      let innerCallLines: number[] = [];
      let otherCallLines: number[] = [];
      let localCallLines: number[] = [];
      let aliasedTargetFile: string | undefined;
      let aliasedTargetName: string | null | undefined;
      let aliasedBindingParamName: string | null | undefined;
      let aliasedReturnCount = 0;
      let mixedTargetNames: (string | null)[] = [];
      let mixedGapKinds: string[] = [];
      let ifaceGapKinds: string[] = [];

      const rule = defineRule({
        id: "inspect-call-graph",
        run: async (ctx) => {
          const funcDecls = await ctx.findSyntax({
            kinds: ["FunctionDeclaration"],
          });
          const declResolutions = await ctx.resolveDeclarations(
            funcDecls.map((f) => f.ref),
            { select: { name: true, location: true } },
          );

          const findDecl = (file: string, name: string): DeclarationRef => {
            const found = declResolutions.find(
              (row) => row.location?.file === file && row.name === name,
            );
            assert.ok(found?.declaration, `Missing decl ${name} in ${file}`);
            return found.declaration;
          };

          const innerDecl = findDecl("src/inner.ts", "processItem");
          const otherDecl = findDecl("src/other.ts", "processItem");
          const localDecl = findDecl("src/entry.ts", "processItem");

          const callers = await ctx.callersOf([
            innerDecl,
            otherDecl,
            localDecl,
          ]);
          assert.equal(callers.length, 3);
          innerCallLines = callers[0]!.callSites.map((s) => s.location.line);
          otherCallLines = callers[1]!.callSites.map((s) => s.location.line);
          localCallLines = callers[2]!.callSites.map((s) => s.location.line);

          const callNodes = await ctx.findSyntax({
            files: ["src/entry.ts"],
            kinds: ["CallExpression"],
          });
          const callRes = await ctx.resolveCalls(
            callNodes.map((n) => n.ref),
            { select: { location: true } },
          );
          const callAtLine = (line: number): CallRef => {
            const row = callRes.find((r) => r.location?.line === line);
            assert.ok(row?.call, `Missing call at line ${line}`);
            return row.call;
          };

          const aliasedCall = callAtLine(17);
          const mixedCall = callAtLine(21);
          const ifaceCall = callAtLine(22);

          const callees = await ctx.calleesOf([
            aliasedCall,
            mixedCall,
            ifaceCall,
          ]);
          assert.equal(callees.length, 3);

          const aliasedResult = callees[0]!;
          assert.equal(aliasedResult.targets.length, 1);
          assert.deepEqual(aliasedResult.gaps, []);
          aliasedTargetFile = aliasedResult.resolvedTargets[0]?.location?.file;
          aliasedTargetName = aliasedResult.resolvedTargets[0]?.name;
          aliasedBindingParamName =
            aliasedResult.resolvedTargets[0]?.parameterBindings[0]
              ?.parameterName;
          aliasedReturnCount =
            aliasedResult.resolvedTargets[0]?.returnExpressions.length ?? 0;

          const mixedResult = callees[1]!;
          mixedTargetNames = mixedResult.resolvedTargets.map((t) => t.name);
          mixedGapKinds = mixedResult.gaps.map((g) => g.kind);

          const ifaceResult = callees[2]!;
          ifaceGapKinds = ifaceResult.gaps.map((g) => g.kind);
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      // Line 17 is direct aliasedProcess(input); line 21 is mixed(a) which may call aliasedProcess
      assert.ok(innerCallLines.includes(17), `Got ${innerCallLines.join(",")}`);
      assert.ok(
        !innerCallLines.includes(18) && !innerCallLines.includes(19),
        "Must not confuse same-name symbols",
      );
      assert.deepEqual(otherCallLines, [18]);
      assert.deepEqual(localCallLines, [19]);

      assert.equal(aliasedTargetFile, "src/inner.ts");
      assert.equal(aliasedTargetName, "processItem");
      assert.equal(aliasedBindingParamName, "item");
      assert.equal(aliasedReturnCount, 1);

      assert.deepEqual(mixedTargetNames, ["processItem"]);
      assert.ok(mixedGapKinds.includes("dynamic-callee"));
      assert.ok(ifaceGapKinds.includes("dynamic-callee"));
      assert.ok(report.gaps.length >= 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("traces mixed TS -> JS -> TS calls, reads JSDoc param types with checkJs: false, and evaluates propagation: value", async () => {
    const root = createTempProject(
      {
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
          " * @returns {string}",
          " */",
          "export function forwardBridge(mode, payload) {",
          "  const local = payload;",
          "  return deliver(mode, local);",
          "}",
          "",
        ].join("\n"),
        "src/entry.ts": [
          'import { forwardBridge } from "./bridge.js";',
          "",
          "function createToken(): string {",
          '  return "secret";',
          "}",
          "",
          "async function asyncPass(v: string): Promise<string> {",
          "  return v;",
          "}",
          "",
          "function idFn(v: string): string {",
          "  return v;",
          "}",
          "",
          "function fetchRow(): { id: string; tag: string } {",
          '  return { id: "1", tag: "ok" };',
          "}",
          "",
          "export async function run(",
          "  cond: boolean,",
          "  cb: (x: string) => string,",
          "): Promise<string> {",
          "  const raw = createToken();",
          "  const unwrapped = (await asyncPass(raw)) as string;",
          '  const row = { secret: unwrapped, extra: "ok" };',
          "  const { extra, ...rest } = row;",
          '  const delivered = forwardBridge("alpha", rest.secret);',
          "  const { secret: extracted, ...withoutSecret } = row;",
          "  const isolatedA = idFn(raw);",
          '  const isolatedB = idFn("safe");',
          "  const templated = `prefix:${raw}`;",
          "  let overwritten = raw;",
          '  overwritten = "clean";',
          "  const opaque = fetchRow();",
          "  const { id: _id, ...restRow } = opaque;",
          "  const mixedOut = (cond ? idFn : cb)(raw);",
          "  return `${delivered}:${extra}:${extracted}:${Object.keys(withoutSecret).length}:${isolatedA}:${isolatedB}:${templated}:${overwritten}:${restRow.tag}:${mixedOut}`;",
          "}",
          "",
        ].join("\n"),
      },
      {
        allowJs: true,
        checkJs: false,
      },
    );

    // Override tsconfig.json so only entry.ts is explicitly listed in files/include
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

    try {
      let jsDocTypeText: string | undefined;
      let jsDocUnionMembers: readonly string[] | undefined;
      let bridgeCallerFile: string | undefined;
      let sinkCallerFile: string | undefined;
      let deliveredReachable = false;
      let deliveredEvidenceFiles: string[] = [];
      let deliveredStepKinds: string[] = [];
      let extractedReachable = false;
      let withoutSecretReachable = true;
      let extraReachable = true;
      let isolatedAReachable = false;
      let isolatedBReachable = true;
      let templatedReachable = true;
      let overwrittenReachable = true;
      let restRowReachable = false;
      let mixedReachable = false;
      let mixedGapKinds: string[] = [];

      const rule = defineRule({
        id: "mixed-ts-js-propagation",
        run: async (ctx) => {
          assert.equal(ctx.project.compilerOptions.allowJs, true);
          assert.equal(ctx.project.compilerOptions.checkJs, false);

          const entryCalls = await ctx.findSyntax({
            files: ["src/entry.ts"],
            kinds: ["CallExpression"],
          });
          const bridgeCalls = await ctx.findSyntax({
            files: ["src/bridge.js"],
            kinds: ["CallExpression"],
          });

          const forwardCallSyntax = entryCalls.find((c) =>
            c.text.startsWith("forwardBridge("),
          );
          assert.ok(forwardCallSyntax);
          const [resolvedForward] = await ctx.resolveCalls(
            [forwardCallSyntax.ref],
            {
              select: {
                instantiatedParameterTypes: [0],
                calleeDeclaration: true,
              },
            },
          );
          const param0 = resolvedForward?.instantiatedParameterTypes[0];
          jsDocTypeText = param0?.type.typeText;
          jsDocUnionMembers = param0?.type.unionMembers;

          assert.ok(resolvedForward?.call);
          const [bridgeCallee] = await ctx.calleesOf([resolvedForward.call]);
          assert.equal(
            bridgeCallee?.resolvedTargets[0]?.location?.file,
            "src/bridge.js",
          );

          const deliverCallSyntax = bridgeCalls.find((c) =>
            c.text.startsWith("deliver("),
          );
          assert.ok(deliverCallSyntax);
          const [resolvedDeliver] = await ctx.resolveCalls([
            deliverCallSyntax.ref,
          ]);
          assert.ok(resolvedDeliver?.call);
          const [deliverCallee] = await ctx.calleesOf([resolvedDeliver.call]);
          assert.equal(
            deliverCallee?.resolvedTargets[0]?.location?.file,
            "src/sink.ts",
          );

          const callers = await ctx.callersOf([
            resolvedForward.calleeDeclaration!,
            deliverCallee.targets[0]!,
          ]);
          bridgeCallerFile = callers[0]?.callSites[0]?.location.file;
          sinkCallerFile = callers[1]?.callSites[0]?.location.file;

          // Trace raw = createToken() -> various targets
          const varDecls = await ctx.findSyntax({
            files: ["src/entry.ts"],
            kinds: ["VariableDeclaration"],
          });
          const varInitOf = (name: string): SyntaxRef => {
            const decl = varDecls.find(
              (d) =>
                d.text.startsWith(`${name} =`) ||
                d.text.startsWith(`{ ${name}`) ||
                d.text.includes(`...${name}`),
            );
            assert.ok(decl?.initializer, `Missing var ${name}`);
            return decl.initializer;
          };
          const varDeclRef = async (name: string): Promise<DeclarationRef> => {
            const decl = varDecls.find((d) => d.text.startsWith(`${name} =`));
            assert.ok(decl, `Missing varDecl ${name}`);
            const [res] = await ctx.resolveDeclarations([decl.ref]);
            return res!.declaration!;
          };

          const rawOrigin = varInitOf("raw");
          const deliveredTarget = await varDeclRef("delivered");
          const isolatedATarget = await varDeclRef("isolatedA");
          const isolatedBTarget = await varDeclRef("isolatedB");
          const templatedTarget = await varDeclRef("templated");
          const mixedTarget = await varDeclRef("mixedOut");

          const bindingIdentifiers = await ctx.findSyntax({
            files: ["src/entry.ts"],
            kinds: ["Identifier"],
          });
          const findIdent = (name: string, line: number): SyntaxRef => {
            const match = bindingIdentifiers.find(
              (id) => id.text === name && id.location.line === line,
            );
            assert.ok(match, `Missing identifier ${name} at line ${line}`);
            return match.ref;
          };

          const extraTarget = findIdent("extra", 26);
          const extractedTarget = findIdent("extracted", 28);
          const withoutSecretTarget = findIdent("withoutSecret", 28);
          const overwrittenRead = findIdent("overwritten", 37);

          const propRes = await ctx.valuePropagation({
            propagation: "value",
            from: rawOrigin,
            to: [
              deliveredTarget,
              extractedTarget,
              withoutSecretTarget,
              extraTarget,
              isolatedATarget,
              isolatedBTarget,
              templatedTarget,
              overwrittenRead,
              mixedTarget,
            ],
          });

          deliveredReachable = propRes.results[0]!.reachable;
          deliveredEvidenceFiles = propRes.results[0]!.evidence.map(
            (e) => e.at?.file,
          ).filter((f): f is string => f !== undefined);
          deliveredStepKinds =
            propRes.results[0]!.paths[0]?.steps.map((s) => s.kind) ?? [];
          extractedReachable = propRes.results[1]!.reachable;
          withoutSecretReachable = propRes.results[2]!.reachable;
          extraReachable = propRes.results[3]!.reachable;
          isolatedAReachable = propRes.results[4]!.reachable;
          isolatedBReachable = propRes.results[5]!.reachable;
          templatedReachable = propRes.results[6]!.reachable;
          overwrittenReachable = propRes.results[7]!.reachable;
          mixedReachable = propRes.results[8]!.reachable;
          mixedGapKinds = propRes.results[8]!.gaps.map((g) => g.kind);

          // Rest destructuring on opaque object: opaque -> restRow
          const opaqueOrigin = varInitOf("opaque");
          const restRowIdent = findIdent("restRow", 35);
          const opaqueProp = await ctx.valuePropagation({
            propagation: "value",
            from: opaqueOrigin,
            to: [restRowIdent],
          });
          restRowReachable = opaqueProp.results[0]!.reachable;
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      assert.equal(jsDocTypeText, '"alpha" | "beta"');
      assert.deepEqual(jsDocUnionMembers, ['"alpha"', '"beta"']);
      assert.equal(bridgeCallerFile, "src/entry.ts");
      assert.equal(sinkCallerFile, "src/bridge.js");

      assert.equal(deliveredReachable, true);
      assert.ok(deliveredEvidenceFiles.includes("src/entry.ts"));
      assert.ok(deliveredEvidenceFiles.includes("src/bridge.js"));
      assert.ok(deliveredEvidenceFiles.includes("src/sink.ts"));
      assert.ok(deliveredStepKinds.includes("awaitUnwrap"));
      assert.ok(deliveredStepKinds.includes("typeAssertion"));
      assert.ok(deliveredStepKinds.includes("propertyRead"));
      assert.ok(deliveredStepKinds.includes("callArgument"));
      assert.ok(deliveredStepKinds.includes("returnValue"));

      assert.equal(extractedReachable, true);
      assert.equal(withoutSecretReachable, false);
      assert.equal(extraReachable, false);
      assert.equal(isolatedAReachable, true);
      assert.equal(isolatedBReachable, false);
      assert.equal(templatedReachable, false);
      assert.equal(overwrittenReachable, false);
      assert.equal(restRowReachable, true);
      assert.equal(mixedReachable, true);
      assert.ok(mixedGapKinds.includes("dynamic-callee"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("follows workspace symlink packages and reports missing-function-body gaps for .d.ts-only dependencies", async () => {
    const root = createTempProject({
      "packages/ws-bridge/package.json": JSON.stringify({
        name: "@acme/ws-bridge",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": "./src/index.ts",
        },
      }),
      "packages/ws-bridge/src/index.ts": [
        "export function relayValue<T>(val: T): T {",
        "  const copied = val;",
        "  return copied;",
        "}",
        "",
      ].join("\n"),
      "node_modules/@acme/decl-only/package.json": JSON.stringify({
        name: "@acme/decl-only",
        version: "1.0.0",
        type: "module",
        exports: {
          ".": {
            types: "./index.d.ts",
          },
        },
      }),
      "node_modules/@acme/decl-only/index.d.ts": [
        "export declare function opaqueBox(input: string): string;",
        "",
      ].join("\n"),
      "src/app.ts": [
        'import { relayValue } from "@acme/ws-bridge";',
        'import { opaqueBox } from "@acme/decl-only";',
        "",
        "function makeOrigin(): string {",
        '  return "origin";',
        "}",
        "",
        "export function main(): string {",
        "  const origin = makeOrigin();",
        "  const relayed = relayValue(origin);",
        "  const boxed = opaqueBox(origin);",
        "  return `${relayed}:${boxed}`;",
        "}",
        "",
      ].join("\n"),
    });

    mkdirSync(join(root, "node_modules", "@acme"), { recursive: true });
    symlinkSync(
      join(root, "packages", "ws-bridge"),
      join(root, "node_modules", "@acme", "ws-bridge"),
      "dir",
    );

    try {
      let wsTargetsCount = 0;
      let wsCallerCount = 0;
      let relayedReachable = false;
      let relayedFiles: string[] = [];
      let boxedReachable = true;
      let boxedGapKinds: string[] = [];

      const rule = defineRule({
        id: "workspace-symlink-forwarding",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["CallExpression"],
          });
          const relayCallSyntax = calls.find((c) =>
            c.text.startsWith("relayValue("),
          );
          assert.ok(relayCallSyntax);
          const [resolvedRelay] = await ctx.resolveCalls([relayCallSyntax.ref]);
          assert.ok(resolvedRelay?.call);
          const [relayCallees] = await ctx.calleesOf([resolvedRelay.call]);
          wsTargetsCount = relayCallees?.targets.length ?? 0;

          const [relayDecl] = relayCallees!.targets;
          assert.ok(relayDecl);
          const [relayCallers] = await ctx.callersOf([relayDecl]);
          wsCallerCount = relayCallers?.calls.length ?? 0;

          const varDecls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["VariableDeclaration"],
          });
          const originInit = varDecls.find((d) =>
            d.text.startsWith("origin ="),
          )?.initializer;
          assert.ok(originInit);

          const relayedDecl = varDecls.find((d) =>
            d.text.startsWith("relayed ="),
          );
          const boxedDecl = varDecls.find((d) => d.text.startsWith("boxed ="));
          const [relayedRes, boxedRes] = await ctx.resolveDeclarations([
            relayedDecl!.ref,
            boxedDecl!.ref,
          ]);

          const prop = await ctx.valuePropagation({
            propagation: "value",
            from: originInit,
            to: [relayedRes!.declaration!, boxedRes!.declaration!],
          });

          relayedReachable = prop.results[0]!.reachable;
          relayedFiles = prop.results[0]!.evidence.map(
            (e) => e.at?.file,
          ).filter((f): f is string => f !== undefined);
          boxedReachable = prop.results[1]!.reachable;
          boxedGapKinds = prop.results[1]!.gaps.map((g) => g.kind);
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      assert.equal(wsTargetsCount, 1);
      assert.equal(wsCallerCount, 1);
      assert.equal(relayedReachable, true);
      assert.ok(
        relayedFiles.some((f) => f.includes("packages/ws-bridge/src/index.ts")),
        `Expected workspace file in evidence, got ${relayedFiles.join(", ")}`,
      );
      assert.equal(boxedReachable, false);
      assert.ok(boxedGapKinds.includes("missing-function-body"));
      assert.ok(report.gaps.some((g) => g.kind === "missing-function-body"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("invalidates call and value propagation caches on session.update() and rejects stale refs", async () => {
    const root = createTempProject({
      "src/helper.ts": [
        "export function relay(x: string): string {",
        "  return x;",
        "}",
        "",
      ].join("\n"),
      "src/main.ts": [
        'import { relay } from "./helper.js";',
        "function make(): string {",
        '  return "secret";',
        "}",
        "export function run(): string {",
        "  const origin = make();",
        "  const out = relay(origin);",
        "  return out;",
        "}",
        "",
      ].join("\n"),
    });

    let staleDeclRef: DeclarationRef | undefined;
    let staleCallRef: CallRef | undefined;
    let staleSyntaxRef: SyntaxRef | undefined;

    const inspectRule = defineRule({
      id: "inspect-prop",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["src/main.ts"],
          kinds: ["CallExpression"],
        });
        const relayCall = calls.find((c) => c.text.startsWith("relay("));
        assert.ok(relayCall);
        const [resolvedCall] = await ctx.resolveCalls([relayCall.ref]);
        assert.ok(resolvedCall?.call);
        const [callees] = await ctx.calleesOf([resolvedCall.call]);
        // Query a second time in the same snapshot to exercise SDK cache reuse
        await ctx.calleesOf([resolvedCall.call]);
        const targetDecl = callees?.targets[0];
        assert.ok(targetDecl);
        await ctx.callersOf([targetDecl]);
        await ctx.callersOf([targetDecl]);

        const varDecls = await ctx.findSyntax({
          files: ["src/main.ts"],
          kinds: ["VariableDeclaration"],
        });
        const originInit = varDecls.find((d) =>
          d.text.startsWith("origin ="),
        )?.initializer;
        const outDecl = varDecls.find((d) => d.text.startsWith("out ="));
        assert.ok(originInit && outDecl);
        const [outRes] = await ctx.resolveDeclarations([outDecl.ref]);
        assert.ok(outRes?.declaration);

        const prop = await ctx.valuePropagation({
          propagation: "value",
          from: originInit,
          to: [outRes.declaration],
        });
        await ctx.valuePropagation({
          propagation: "value",
          from: originInit,
          to: [outRes.declaration],
        });

        staleDeclRef ??= targetDecl;
        staleCallRef ??= resolvedCall.call;
        staleSyntaxRef ??= originInit;

        if (prop.results[0]?.reachable) {
          ctx.report({
            at: relayCall.location,
            message: "Origin propagates through relay()",
            evidence: prop.results[0].evidence,
          });
        }
      },
    });

    const session = await openSession({
      cwd: root,
      config: defineConfig({
        tsconfig: "tsconfig.json",
        rules: [inspectRule],
      }),
    });

    try {
      const report1 = await session.check({ observe: "summary" });
      assert.equal(report1.status, "findings");
      assert.equal(report1.diagnostics.length, 1);
      assert.ok((report1.observation?.reusedQueryCount ?? 0) >= 3);

      // Update helper.ts to stop returning the argument -> propagation must invalidate and clear finding
      writeFileSync(
        join(root, "src/helper.ts"),
        [
          "export function relay(_x: string): string {",
          '  return "constant";',
          "}",
          "",
        ].join("\n"),
        "utf8",
      );
      await session.update({ changed: ["src/helper.ts"] });

      const report2 = await session.check();
      assert.equal(report2.status, "clean");
      assert.equal(report2.diagnostics.length, 0);
      assert.equal("observation" in report2, false);

      // Passing stale DeclarationRef / CallRef / SyntaxRef from snapshot 1 must fail with STALE_REFERENCE
      await assert.rejects(
        () =>
          session.check([
            defineRule({
              id: "use-stale-decl",
              run: async (ctx) => {
                await ctx.callersOf([staleDeclRef!]);
              },
            }),
          ]),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "STALE_REFERENCE",
      );

      await assert.rejects(
        () =>
          session.check([
            defineRule({
              id: "use-stale-call",
              run: async (ctx) => {
                await ctx.calleesOf([staleCallRef!]);
              },
            }),
          ]),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "STALE_REFERENCE",
      );

      await assert.rejects(
        () =>
          session.check([
            defineRule({
              id: "use-stale-endpoint",
              run: async (ctx) => {
                await ctx.valuePropagation({
                  propagation: "value",
                  from: staleSyntaxRef!,
                  to: [staleDeclRef!],
                });
              },
            }),
          ]),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "STALE_REFERENCE",
      );
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("distinguishes clean, gaps-only, findings-with-gaps, and gap-escalated-to-violation with observe off", async () => {
    const root = createTempProject({
      "src/app.ts": [
        "function knownSink(v: string): string {",
        "  return v;",
        "}",
        "function makeSecret(): string {",
        '  return "secret";',
        "}",
        "export function run(useDynamic: boolean, cb: (v: string) => string): string {",
        "  const secret = makeSecret();",
        "  const safe = knownSink(secret);",
        "  if (useDynamic) {",
        "    return cb(secret);",
        "  }",
        "  return safe;",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const makeRule = (options: {
        readonly reportDirectFlow: boolean;
        readonly escalateGap: boolean;
        readonly includeDynamicCall: boolean;
      }) =>
        defineRule({
          id: "flow-and-gap-policy",
          run: async (ctx) => {
            const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
            const relevantCalls = calls.filter(
              (c) =>
                c.text.startsWith("knownSink(") ||
                (options.includeDynamicCall && c.text.startsWith("cb(")),
            );
            const resolved = await ctx.resolveCalls(
              relevantCalls.map((c) => c.ref),
            );
            const callees = await ctx.calleesOf(
              resolved.map((r) => r.call!).filter(Boolean),
            );

            if (options.reportDirectFlow) {
              const varDecls = await ctx.findSyntax({
                kinds: ["VariableDeclaration"],
              });
              const secretInit = varDecls.find((d) =>
                d.text.startsWith("secret ="),
              )?.initializer;
              const safeDecl = varDecls.find((d) =>
                d.text.startsWith("safe ="),
              );
              assert.ok(secretInit && safeDecl);
              const [safeRes] = await ctx.resolveDeclarations([safeDecl.ref]);
              const prop = await ctx.valuePropagation({
                propagation: "value",
                from: secretInit,
                to: [safeRes!.declaration!],
              });
              if (prop.results[0]?.reachable) {
                ctx.report({
                  at: safeDecl.location,
                  message: "Secret reached knownSink result",
                  evidence: prop.results[0].evidence,
                });
              }
            }

            if (options.escalateGap) {
              for (const row of callees) {
                for (const gap of row.gaps) {
                  if (gap.at) {
                    ctx.report({
                      at: gap.at,
                      message: `Unresolved dynamic target escalated to error: ${gap.message}`,
                      evidence: [
                        { kind: "note", message: gap.kind, at: gap.at },
                      ],
                    });
                  }
                }
              }
            }
          },
        });

      // (a) No violations and no gaps
      const cleanNoGaps = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            makeRule({
              reportDirectFlow: false,
              escalateGap: false,
              includeDynamicCall: false,
            }),
          ],
        }),
      });
      assert.equal(cleanNoGaps.status, "clean");
      assert.deepEqual(cleanNoGaps.diagnostics, []);
      assert.deepEqual(cleanNoGaps.gaps, []);
      assert.equal("observation" in cleanNoGaps, false);

      // (b) No violations, but gap present
      const cleanWithGaps = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            makeRule({
              reportDirectFlow: false,
              escalateGap: false,
              includeDynamicCall: true,
            }),
          ],
        }),
      });
      assert.equal(cleanWithGaps.status, "clean");
      assert.deepEqual(cleanWithGaps.diagnostics, []);
      assert.equal(cleanWithGaps.gaps.length, 1);
      assert.equal(cleanWithGaps.gaps[0]?.kind, "dynamic-callee");
      assert.equal("observation" in cleanWithGaps, false);

      // (c) Violations and gaps coexisting
      const findingsAndGaps = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            makeRule({
              reportDirectFlow: true,
              escalateGap: false,
              includeDynamicCall: true,
            }),
          ],
        }),
      });
      assert.equal(findingsAndGaps.status, "findings");
      assert.equal(findingsAndGaps.diagnostics.length, 1);
      assert.equal(findingsAndGaps.gaps.length, 1);
      assert.equal(findingsAndGaps.gaps[0]?.kind, "dynamic-callee");
      assert.equal("observation" in findingsAndGaps, false);

      // (d) Rule actively escalates gap to violation
      const escalatedGap = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            makeRule({
              reportDirectFlow: false,
              escalateGap: true,
              includeDynamicCall: true,
            }),
          ],
        }),
      });
      assert.equal(escalatedGap.status, "findings");
      assert.equal(escalatedGap.diagnostics.length, 1);
      assert.match(escalatedGap.diagnostics[0]!.message, /escalated/u);
      assert.equal(escalatedGap.gaps.length, 1);
      assert.equal("observation" in escalatedGap, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("resolves callersOf across default exports, exported variable aliases, constructors, super(), and string element calls", async () => {
    const root = createTempProject({
      "src/defs.ts": [
        "function internalMake(tag: string): { tag: string } {",
        "  return { tag };",
        "}",
        "export const publicMake = internalMake;",
        "export default function defaultFactory(x: string): string {",
        "  return x;",
        "}",
        "export class BaseBox {",
        "  constructor(public readonly label: string) {}",
        "  ping(): string { return this.label; }",
        "}",
        "",
      ].join("\n"),
      "src/caller.ts": [
        "import defFn, { BaseBox, publicMake as renamedMake } from './defs.js';",
        "export class ChildBox extends BaseBox {",
        "  constructor(label: string) {",
        "    super(label);",
        "  }",
        "}",
        "export function exercise(flag: boolean): string {",
        "  const pick = flag ? renamedMake : renamedMake;",
        "  const made = pick('ok');",
        "  const box = new BaseBox(made.tag);",
        "  const child = new ChildBox(defFn('hi'));",
        "  return box['ping']() + child.ping();",
        "}",
        "",
      ].join("\n"),
      "src/unrelated.ts": [
        "export function ping(): string { return 'other'; }",
        "export function runUnrelated(): string { return ping(); }",
        "",
      ].join("\n"),
    });

    try {
      let internalCallerLines: number[] = [];
      let defaultCallerLines: number[] = [];
      let ctorCallerLines: number[] = [];
      let pingCallerLines: number[] = [];

      await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            defineRule({
              id: "lazy-call-graph-coverage",
              run: async (ctx) => {
                const defsNodes = await ctx.findSyntax({
                  files: ["src/defs.ts"],
                  kinds: [
                    "FunctionDeclaration",
                    "Constructor",
                    "MethodDeclaration",
                  ],
                });
                const decls = await ctx.resolveDeclarations(
                  defsNodes.map((n) => n.ref),
                  { select: { name: true, kind: true } },
                );

                const internalDecl = decls.find(
                  (d) => d.name === "internalMake",
                )?.declaration;
                const defaultDecl = decls.find(
                  (d) => d.name === "default" || d.name === "defaultFactory",
                )?.declaration;
                const ctorDecl = decls.find(
                  (d) => d.kind === "Constructor",
                )?.declaration;
                const pingDecl = decls.find(
                  (d) => d.name === "ping",
                )?.declaration;

                assert.ok(internalDecl && defaultDecl && ctorDecl && pingDecl);
                const rows = await ctx.callersOf([
                  internalDecl,
                  defaultDecl,
                  ctorDecl,
                  pingDecl,
                ]);
                internalCallerLines = rows[0]!.callSites.map(
                  (s) => s.location.line,
                );
                defaultCallerLines = rows[1]!.callSites.map(
                  (s) => s.location.line,
                );
                ctorCallerLines = rows[2]!.callSites.map(
                  (s) => s.location.line,
                );
                pingCallerLines = rows[3]!.callSites.map(
                  (s) => s.location.line,
                );
              },
            }),
          ],
        }),
      });

      assert.deepEqual(internalCallerLines, [9]);
      assert.deepEqual(defaultCallerLines, [11]);
      assert.deepEqual(ctorCallerLines, [4, 10]);
      assert.deepEqual(pingCallerLines, [12, 12]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("finds callers of functions returned by a factory", async () => {
    const root = createTempProject({
      "src/defs.ts": [
        "export function getCallable() {",
        "  return function computeUnique(value: number): number {",
        "    return value > 10 ? computeUnique(value - 1) : value + 1;",
        "  };",
        "}",
        "",
      ].join("\n"),
      "src/entry.ts": [
        'import { getCallable } from "./defs.js";',
        "const selected = getCallable();",
        "selected(1);",
        "getCallable()(2);",
        "",
      ].join("\n"),
    });

    try {
      let callerLocations: string[] = [];
      let gapKinds: string[] = [];
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            defineRule({
              id: "returned-function-callers",
              run: async (ctx) => {
                const declarations = await ctx.findSyntax({
                  files: ["src/defs.ts"],
                  kinds: ["FunctionExpression"],
                });
                const projected = await ctx.resolveDeclarations(
                  declarations.map((node) => node.ref),
                  { select: { name: true } },
                );
                const target = projected.find(
                  (row) => row.name === "computeUnique",
                )?.declaration;
                assert.ok(target);

                const callers = await ctx.callersOf([target]);
                callerLocations = callers[0]!.callSites.map(
                  (site) => `${site.location.file}:${site.location.line}`,
                );
                callerLocations.sort();
                gapKinds = callers[0]!.gaps.map((gap) => gap.kind);
              },
            }),
          ],
        }),
      });

      assert.equal(report.status, "clean");
      assert.deepEqual(callerLocations, [
        "src/defs.ts:3",
        "src/entry.ts:3",
        "src/entry.ts:4",
      ]);
      assert.deepEqual(gapKinds, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("finds callers through a generic identity function", async () => {
    const root = createTempProject({
      "src/library.ts": [
        "export function computeUnique(input: number): number {",
        "  return input > 10 ? computeUnique(input - 1) : input + 1;",
        "}",
        "export function keepIdentity<T>(value: T): T {",
        "  return value;",
        "}",
        "",
      ].join("\n"),
      "src/entry.ts": [
        'import { computeUnique, keepIdentity } from "./library.js";',
        "const selected = keepIdentity(computeUnique);",
        "selected(1);",
        "",
      ].join("\n"),
    });

    try {
      let callerLocations: string[] = [];
      let gapKinds: string[] = [];
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [
            defineRule({
              id: "generic-callers",
              run: async (ctx) => {
                const callSyntaxes = await ctx.findSyntax({
                  files: ["src/entry.ts"],
                  kinds: ["CallExpression"],
                });
                const targetCall = callSyntaxes.find(
                  (call) => call.location.line === 3,
                );
                assert.ok(targetCall);
                const [resolvedCall] = await ctx.resolveCalls([targetCall.ref]);
                assert.ok(resolvedCall?.call);
                const [callee] = await ctx.calleesOf([resolvedCall.call]);
                const target = callee?.targets[0];
                assert.ok(target);
                const [callers] = await ctx.callersOf([target]);
                callerLocations = callers!.callSites.map(
                  (site) => `${site.location.file}:${site.location.line}`,
                );
                callerLocations.sort();
                gapKinds = callers!.gaps.map((gap) => gap.kind);
              },
            }),
          ],
        }),
      });

      assert.equal(report.status, "clean");
      assert.deepEqual(callerLocations, ["src/entry.ts:3", "src/library.ts:2"]);
      assert.deepEqual(gapKinds, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
