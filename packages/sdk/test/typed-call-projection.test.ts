import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  type SignatureRef,
  type SyntaxRef,
  type TypeRef,
} from "@verule/sdk";

function createMultiFileTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-projection-test-"));
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
          },
          include: ["src/**/*.ts"],
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

void describe("@verule/sdk typed call projection", () => {
  void it("queries local syntax by source range, resolves calls & declarations across aliases, and maps back to syntax", async () => {
    const defsSource = [
      "export function targetHelper(label: string, count: number): string {",
      "  return `${label}:${count}`;",
      "}",
      "",
      "export function ignoredHelper(flag: boolean): boolean {",
      "  return flag;",
      "}",
      "",
    ].join("\n");

    const callerSource = [
      'import { targetHelper as aliasedTarget, ignoredHelper } from "./defs.js";',
      "",
      "export function runWorkflow(input: string): string {",
      "  const first = ignoredHelper(true);",
      '  const second = aliasedTarget("ok", first ? 1 : 2);',
      "  return second;",
      "}",
      "",
    ].join("\n");

    const root = createMultiFileTempProject({
      "src/defs.ts": defsSource,
      "src/caller.ts": callerSource,
    });

    let foundCallKind: string | undefined;
    let foundFuncBodyKind: string | undefined;
    let foundParamCount: number | undefined;
    let resolvedDeclName: string | null | undefined;
    let resolvedDeclFile: string | undefined;
    let resolvedDeclLine: number | undefined;
    let reverseSyntaxKind: string | undefined;
    let reverseSyntaxFile: string | undefined;
    let reverseSyntaxLine: number | undefined;
    let reverseCallHasLocation = false;
    let omittedKeyPresentOnRuntimeRow = true;

    const rule = defineRule({
      id: "range-to-decl-and-call",
      run: async (ctx) => {
        const rangeCalls = await ctx.findSyntax({
          range: {
            file: "src/caller.ts",
            startLine: 5,
            endLine: 5,
          },
          kinds: ["CallExpression"],
        });
        assert.equal(rangeCalls.length, 1);
        const callSyntax = rangeCalls[0]!;
        foundCallKind = callSyntax.kind;
        assert.equal(callSyntax.arguments?.length, 2);
        assert.ok(callSyntax.expression);

        const defFuncs = await ctx.findSyntax({
          range: {
            file: "src/defs.ts",
            startLine: 1,
            endLine: 3,
          },
          kinds: ["FunctionDeclaration"],
        });
        assert.equal(defFuncs.length, 1);
        foundParamCount = defFuncs[0]!.parameters?.length;
        assert.ok(defFuncs[0]!.body);

        const callResolutions = await ctx.resolveCalls([callSyntax.ref], {
          select: {
            location: true,
            calleeDeclaration: true,
          },
        });
        assert.equal(callResolutions.length, 1);
        const callRow = callResolutions[0]!;
        omittedKeyPresentOnRuntimeRow =
          Object.hasOwn(callRow, "signature") ||
          Object.hasOwn(callRow, "returnType");
        const callRef: CallRef | null = callRow.call;
        assert.ok(callRef);
        assert.deepEqual(callRow.gaps, []);

        const declResolutions = await ctx.resolveDeclarations(
          [callSyntax.expression as SyntaxRef],
          {
            select: {
              name: true,
              location: true,
              syntax: true,
              kind: true,
            },
          },
        );
        assert.equal(declResolutions.length, 1);
        const declRow = declResolutions[0]!;
        const declRef: DeclarationRef | null = declRow.declaration;
        assert.ok(declRef);
        assert.deepEqual(declRow.gaps, []);
        resolvedDeclName = declRow.name;
        resolvedDeclFile = declRow.location?.file;
        resolvedDeclLine = declRow.location?.line;

        const reversed = await ctx.syntaxOf([declRef, callRef], {
          select: {
            kind: true,
            location: true,
            body: true,
            parameters: true,
          },
        });
        assert.equal(reversed.length, 2);
        const declSyntaxRow = reversed[0]!;
        reverseSyntaxKind = declSyntaxRow.kind ?? undefined;
        reverseSyntaxFile = declSyntaxRow.location?.file;
        reverseSyntaxLine = declSyntaxRow.location?.line;
        assert.equal(declSyntaxRow.parameters?.length, 2);
        assert.ok(declSyntaxRow.body);

        const bodySyntax = await ctx.findSyntax({
          range: {
            file: "src/defs.ts",
            start: declSyntaxRow.location!.start,
            end: declSyntaxRow.location!.end,
          },
          kinds: ["Block"],
        });
        foundFuncBodyKind = bodySyntax[0]?.kind;

        const callSyntaxLookup = reversed[1]!;
        reverseCallHasLocation = callSyntaxLookup.location?.line === 5;
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");
      assert.equal(foundCallKind, "CallExpression");
      assert.equal(foundFuncBodyKind, "Block");
      assert.equal(foundParamCount, 2);
      assert.equal(resolvedDeclName, "targetHelper");
      assert.equal(resolvedDeclFile, "src/defs.ts");
      assert.equal(resolvedDeclLine, 1);
      assert.equal(reverseSyntaxKind, "FunctionDeclaration");
      assert.equal(reverseSyntaxFile, "src/defs.ts");
      assert.equal(reverseSyntaxLine, 1);
      assert.equal(reverseCallHasLocation, true);
      assert.equal(omittedKeyPresentOnRuntimeRow, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("evaluates overloads, generic instantiation, narrowing, and assignability in a single snapshot", async () => {
    const source = [
      "export function parseInput(value: string): { kind: 'text'; value: string };",
      "export function parseInput(value: number): { kind: 'num'; value: number };",
      "export function parseInput(value: string | number): { kind: string; value: string | number } {",
      "  return typeof value === 'string' ? { kind: 'text', value } : { kind: 'num', value };",
      "}",
      "",
      "export function wrap<T>(item: T, tag: string): { item: T; tag: string } {",
      "  return { item, tag };",
      "}",
      "",
      "export function run(input: string | number, wider: { item: string | number; tag: string }) {",
      "  const textParsed = parseInput('hello');",
      "  const numParsed = parseInput(42);",
      "  if (typeof input === 'string') {",
      "    const wrappedStr = wrap(input, 'str');",
      "    return { textParsed, numParsed, wrappedStr, wider };",
      "  }",
      "  const wrappedNum = wrap(input, 'num');",
      "  return { textParsed, numParsed, wrappedNum, wider };",
      "}",
      "",
    ].join("\n");

    const root = createMultiFileTempProject({
      "src/overloads.ts": source,
    });

    const rule = defineRule({
      id: "overload-generic-assignability",
      run: async (ctx) => {
        const callSyntax = await ctx.findSyntax({
          range: { file: "src/overloads.ts", startLine: 11, endLine: 20 },
          kinds: ["CallExpression"],
        });
        assert.equal(callSyntax.length, 4);

        const resolvedCalls = await ctx.resolveCalls(
          callSyntax.map((c) => c.ref),
        );
        const callRefs = resolvedCalls
          .map((r) => r.call)
          .filter((c): c is CallRef => c !== null);
        assert.equal(callRefs.length, 4);

        // Single batch call projection evaluating signature, instantiated parameters, and return type.
        const projectedCalls = await ctx.projectCalls(callRefs, {
          select: {
            location: true,
            signature: true,
            instantiatedParameterTypes: [0],
            returnType: true,
          },
        });

        const [textCall, numCall, wrapStrCall, wrapNumCall] = projectedCalls;
        assert.ok(
          textCall && numCall && wrapStrCall && wrapNumCall,
          "expected 4 projected calls",
        );

        // Overload 1 vs Overload 2
        assert.equal(
          textCall.instantiatedParameterTypes[0]?.type.typeText,
          "string",
        );
        assert.equal(
          numCall.instantiatedParameterTypes[0]?.type.typeText,
          "number",
        );
        assert.match(
          textCall.returnType?.typeText ?? "",
          /kind:\s*['"]text['"]/u,
        );
        assert.match(
          numCall.returnType?.typeText ?? "",
          /kind:\s*['"]num['"]/u,
        );

        // Follow-up SignatureRef query confirming exact overload declaration line + instantiation
        assert.ok(textCall.signature);
        assert.ok(numCall.signature);
        assert.ok(wrapStrCall.signature);
        const sigRows = await ctx.projectSignatures(
          [textCall.signature, numCall.signature, wrapStrCall.signature],
          {
            select: {
              location: true,
              isInstantiated: true,
              instantiatedParameterTypes: true,
              returnType: true,
              parameters: true,
            },
          },
        );
        assert.equal(sigRows[0]!.location?.line, 1);
        assert.equal(sigRows[1]!.location?.line, 2);
        assert.equal(sigRows[0]!.isInstantiated, false);
        assert.equal(sigRows[2]!.isInstantiated, true);
        assert.equal(sigRows[2]!.parameters?.length, 2);
        assert.equal(
          sigRows[2]!.instantiatedParameterTypes?.[0]?.type.typeText,
          "string",
        );
        assert.equal(
          sigRows[2]!.instantiatedParameterTypes?.[1]?.type.typeText,
          "string",
        );

        // Generic instantiation + narrowing on wrap(input, ...)
        assert.equal(
          wrapStrCall.instantiatedParameterTypes[0]?.type.typeText,
          "string",
        );
        assert.equal(
          wrapNumCall.instantiatedParameterTypes[0]?.type.typeText,
          "number",
        );

        // Inspect properties of the instantiated returnType via projectTypes
        assert.ok(wrapStrCall.returnType);
        const [retTypeRow] = await ctx.projectTypes(
          [wrapStrCall.returnType.ref],
          {
            select: {
              typeText: true,
              properties: true,
            },
          },
        );
        assert.deepEqual(
          retTypeRow?.properties?.map((p) => p.name),
          ["item", "tag"],
        );

        // Compare narrowed parameter types and generic return types with isAssignableTo
        const strParamType = wrapStrCall.instantiatedParameterTypes[0]!.type.ref;
        const numParamType = wrapNumCall.instantiatedParameterTypes[0]!.type.ref;
        const paramDecls = await ctx.findSyntax({
          range: { file: "src/overloads.ts", startLine: 11, endLine: 11 },
          kinds: ["Parameter"],
        });
        assert.equal(paramDecls.length, 2);
        const [inputParamType, widerParamType] = await ctx.typeAt(
          paramDecls.map((p) => p.ref),
        );
        assert.ok(inputParamType && widerParamType);

        const assignability = await ctx.isAssignableTo([
          { source: strParamType, target: inputParamType.ref }, // string -> string | number: true
          { source: inputParamType.ref, target: strParamType }, // string | number -> string: false
          { source: strParamType, target: numParamType }, // string -> number: false
          { source: wrapStrCall.returnType.ref, target: widerParamType.ref }, // { item: string; tag: string } -> { item: string | number; tag: string }: true
          { source: widerParamType.ref, target: wrapStrCall.returnType.ref }, // wider -> narrower: false
        ]);

        assert.deepEqual(
          assignability.map((a) => a.assignable),
          [true, false, false, true, false],
        );

        // Use ordinary TS on scalar projection values and report a diagnostic when overload 2 is called
        if (numCall.instantiatedParameterTypes[0]?.type.typeText === "number") {
          ctx.report({
            at: numCall.location,
            message: "Matched numeric overload",
            findingKey: "numeric-overload",
            evidence: [
              {
                kind: "type",
                message: `Selected overload at line ${String(sigRows[1]!.location?.line)}`,
                at: sigRows[1]!.location ?? numCall.location,
              },
            ],
          });
        }
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });
      assert.equal(report.status, "findings");
      assert.equal(report.diagnostics.length, 1);
      assert.equal(report.diagnostics[0]!.at.line, 13);
      assert.deepEqual(report.gaps, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("distinguishes unrequested fields, requested empty values, and indeterminate gaps", async () => {
    const source = [
      'import type { MissingType } from "./does-not-exist.js";',
      "function ping(): void {}",
      "const anon = () => 1;",
      "declare const dyn: any;",
      "declare const broken: MissingType;",
      "export function testAll() {",
      "  ping();",
      "  dyn(123);",
      "  // @ts-expect-error unresolved call",
      "  missingFn('arg');",
      "  return [anon, broken];",
      "}",
      "",
    ].join("\n");

    const root = createMultiFileTempProject({
      "src/three-state.ts": source,
    });

    const rule = defineRule({
      id: "three-state-check",
      run: async (ctx) => {
        const callNodes = await ctx.findSyntax({
          range: { file: "src/three-state.ts", startLine: 6, endLine: 12 },
          kinds: ["CallExpression"],
        });
        assert.equal(callNodes.length, 3);

        // 1. Unrequested vs Requested-but-empty on ping()
        const [pingRow] = await ctx.resolveCalls([callNodes[0]!.ref], {
          select: {
            arguments: true,
            instantiatedParameterTypes: true,
            returnType: true,
          },
        });
        assert.ok(pingRow);
        assert.equal(Object.hasOwn(pingRow, "signature"), false);
        assert.equal(Object.hasOwn(pingRow, "callee"), false);
        assert.equal(Object.hasOwn(pingRow, "location"), false);
        assert.equal(Object.hasOwn(pingRow, "arguments"), true);
        assert.deepEqual(pingRow.arguments, []);
        assert.deepEqual(pingRow.instantiatedParameterTypes, []);
        assert.equal(pingRow.returnType?.typeText, "void");
        assert.deepEqual(pingRow.gaps, []);

        // Requested-but-null on anonymous arrow function name
        const [arrowDecl] = await ctx.findSyntax({
          range: { file: "src/three-state.ts", startLine: 3, endLine: 3 },
          kinds: ["ArrowFunction"],
        });
        assert.ok(arrowDecl);
        const [arrowLookup] = await ctx.syntaxOf(
          [
            (
              await ctx.resolveCalls([callNodes[0]!.ref])
            )[0]!.call!,
          ],
          { select: { body: true } },
        );
        // CallExpression has no body -> requested `body` is present and null with no gaps
        assert.ok(arrowLookup);
        assert.equal(Object.hasOwn(arrowLookup, "body"), true);
        assert.equal(arrowLookup.body, null);
        assert.deepEqual(arrowLookup.gaps, []);

        // 2. Indeterminate candidate on dyn(123): calleeDeclaration known, signature unknown -> Gap
        const [dynRow] = await ctx.resolveCalls([callNodes[1]!.ref], {
          select: {
            calleeDeclaration: true,
            signature: true,
            arguments: true,
            instantiatedParameterTypes: true,
            returnType: true,
          },
        });
        assert.ok(dynRow);
        assert.ok(dynRow.call);
        assert.ok(dynRow.calleeDeclaration);
        assert.equal(dynRow.arguments.length, 1);
        assert.equal(dynRow.signature, null);
        assert.equal(dynRow.returnType, null);
        assert.deepEqual(dynRow.instantiatedParameterTypes, []);
        assert.ok(
          dynRow.gaps.some((g) => g.kind === "unresolved-signature"),
          "expected unresolved-signature gap on dyn(123)",
        );

        // 3. Unresolved identifier call missingFn('arg'): both declaration and signature are gaps, arguments preserved
        const [missingRow] = await ctx.resolveCalls([callNodes[2]!.ref], {
          select: {
            calleeDeclaration: true,
            signature: true,
            arguments: true,
          },
        });
        assert.ok(missingRow);
        assert.equal(missingRow.arguments.length, 1);
        assert.equal(missingRow.calleeDeclaration, null);
        assert.equal(missingRow.signature, null);
        assert.ok(
          missingRow.gaps.some((g) => g.kind === "unresolved-declaration"),
        );
        assert.ok(
          missingRow.gaps.some((g) => g.kind === "unresolved-signature"),
        );

        // 4. Error/unresolved type on `broken` identifier
        const brokenVars = await ctx.findSyntax({
          range: { file: "src/three-state.ts", startLine: 5, endLine: 5 },
          kinds: ["VariableDeclaration"],
        });
        assert.equal(brokenVars.length, 1);
        const [brokenType] = await ctx.typeAt([brokenVars[0]!.ref]);
        assert.ok(brokenType);
        const [brokenProj] = await ctx.projectTypes([brokenType.ref], {
          select: { typeText: true },
        });
        assert.ok(
          brokenProj?.gaps.some((g) => g.kind === "unresolved-type"),
          `expected unresolved-type gap, got ${JSON.stringify(brokenProj?.gaps)}`,
        );
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");
      assert.ok(report.gaps.some((g) => g.kind === "unresolved-signature"));
      assert.ok(report.gaps.some((g) => g.kind === "unresolved-declaration"));
      assert.ok(report.gaps.some((g) => g.kind === "unresolved-type"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("rejects stale references and cross-project references with VeruleExecutionError", async () => {
    const root = createMultiFileTempProject({
      "proj-a/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022" },
        include: ["src/**/*.ts"],
      }),
      "proj-a/src/a.ts":
        "export function fnA(x: string): string { return x; }\nconst _r = fnA('a');\n",
      "proj-b/tsconfig.json": JSON.stringify({
        compilerOptions: { strict: true, target: "ES2022" },
        include: ["src/**/*.ts"],
      }),
      "proj-b/src/b.ts":
        "export function fnB(y: number): number { return y; }\nconst _r = fnB(1);\n",
    });

    let capturedCall: CallRef | undefined;
    let capturedSig: SignatureRef | undefined;
    let capturedDecl: DeclarationRef | undefined;
    let capturedType: TypeRef | undefined;

    try {
      // Cross-project reference check within the same session
      const session = await openSession({
        cwd: root,
        config: defineConfig({
          projects: ["proj-a/tsconfig.json", "proj-b/tsconfig.json"],
        }),
      });
      try {
        assert.equal(session.projects.length, 2);

        const crossRule = defineRule({
          id: "capture-then-cross",
          run: async (ctx) => {
            if (ctx.project.configFile.startsWith("proj-a")) {
              const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
              const [res] = await ctx.resolveCalls([calls[0]!.ref], {
                select: {
                  calleeDeclaration: true,
                  signature: true,
                  returnType: true,
                },
              });
              capturedCall = res!.call!;
              capturedSig = res!.signature!;
              capturedDecl = res!.calleeDeclaration!;
              capturedType = res!.returnType!.ref;
            } else {
              assert.ok(capturedCall);
              await ctx.projectCalls([capturedCall], {
                select: { location: true },
              });
            }
          },
        });

        await assert.rejects(
          () => session.check([crossRule]),
          (err: unknown) =>
            err instanceof VeruleExecutionError &&
            err.code === "CROSS_PROJECT_REFERENCE",
        );

        // Also verify cross-project SignatureRef, DeclarationRef, TypeRef
        const crossSigRule = defineRule({
          id: "cross-sig",
          run: async (ctx) => {
            if (ctx.project.configFile.startsWith("proj-b")) {
              await ctx.projectSignatures([capturedSig!], {
                select: { returnType: true },
              });
            }
          },
        });
        await assert.rejects(
          () => session.check([crossSigRule]),
          (err: unknown) =>
            err instanceof VeruleExecutionError &&
            err.code === "CROSS_PROJECT_REFERENCE",
        );

        const crossDeclRule = defineRule({
          id: "cross-decl",
          run: async (ctx) => {
            if (ctx.project.configFile.startsWith("proj-b")) {
              await ctx.syntaxOf([capturedDecl!], { select: { kind: true } });
            }
          },
        });
        await assert.rejects(
          () => session.check([crossDeclRule]),
          (err: unknown) =>
            err instanceof VeruleExecutionError &&
            err.code === "CROSS_PROJECT_REFERENCE",
        );

        const crossTypeRule = defineRule({
          id: "cross-type",
          run: async (ctx) => {
            if (ctx.project.configFile.startsWith("proj-b")) {
              await ctx.isAssignableTo([
                { source: capturedType!, target: capturedType! },
              ]);
            }
          },
        });
        await assert.rejects(
          () => session.check([crossTypeRule]),
          (err: unknown) =>
            err instanceof VeruleExecutionError &&
            err.code === "CROSS_PROJECT_REFERENCE",
        );
      } finally {
        await session.close();
      }

      // Stale reference check in a brand-new session after closing the previous session
      for (const [label, fn] of [
        [
          "stale CallRef",
          async (ctx: Parameters<Parameters<typeof defineRule>[0]["run"]>[0]) => {
            await ctx.projectCalls([capturedCall!], {
              select: { location: true },
            });
          },
        ],
        [
          "stale SignatureRef",
          async (ctx: Parameters<Parameters<typeof defineRule>[0]["run"]>[0]) => {
            await ctx.projectSignatures([capturedSig!], {
              select: { returnType: true },
            });
          },
        ],
        [
          "stale DeclarationRef",
          async (ctx: Parameters<Parameters<typeof defineRule>[0]["run"]>[0]) => {
            await ctx.syntaxOf([capturedDecl!], { select: { location: true } });
          },
        ],
        [
          "stale TypeRef",
          async (ctx: Parameters<Parameters<typeof defineRule>[0]["run"]>[0]) => {
            await ctx.projectTypes([capturedType!], {
              select: { typeText: true },
            });
          },
        ],
      ] as const) {
        await assert.rejects(
          () =>
            runCheck({
              cwd: root,
              config: defineConfig({
                projects: ["proj-a/tsconfig.json"],
                rules: [defineRule({ id: `stale-${label}`, run: fn })],
              }),
            }),
          (err: unknown) =>
            err instanceof VeruleExecutionError &&
            err.code === "STALE_REFERENCE",
          `expected STALE_REFERENCE for ${label}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
