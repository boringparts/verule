import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const sdkRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const tscBin = join(sdkRoot, "node_modules", ".bin", "tsc");

function prepareExternalConsumer(root: string): void {
  const sdkPkgOut = join(root, "node_modules", "@verule", "sdk");
  mkdirSync(sdkPkgOut, { recursive: true });

  const sdkDist = join(sdkRoot, "dist");
  const consumerDist = join(sdkPkgOut, "dist");
  if (existsSync(join(sdkDist, "index.d.ts"))) {
    cpSync(sdkDist, consumerDist, { recursive: true });
  } else {
    execFileSync(
      tscBin,
      [
        "-p",
        join(sdkRoot, "tsconfig.build.json"),
        "--outDir",
        consumerDist,
        "--pretty",
        "false",
      ],
      { cwd: sdkRoot, encoding: "utf8" },
    );
  }

  const rawManifest = JSON.parse(
    readFileSync(join(sdkRoot, "package.json"), "utf8"),
  ) as {
    readonly name: string;
    readonly version: string;
    readonly type: string;
    readonly publishConfig?: { readonly exports?: unknown };
  };
  writeFileSync(
    join(sdkPkgOut, "package.json"),
    JSON.stringify(
      {
        name: rawManifest.name,
        version: rawManifest.version,
        type: rawManifest.type,
        exports: rawManifest.publishConfig?.exports ?? {
          ".": {
            types: "./dist/index.d.ts",
            default: "./dist/index.js",
          },
        },
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          types: [],
          noEmit: true,
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
}

function runConsumerTsc(
  root: string,
  sourceCode: string,
): { readonly ok: boolean; readonly output: string } {
  const srcDir = join(root, "src");
  rmSync(srcDir, { recursive: true, force: true });
  mkdirSync(srcDir, { recursive: true });
  writeFileSync(join(srcDir, "consumer.ts"), sourceCode, "utf8");

  try {
    const stdout = execFileSync(
      tscBin,
      ["-p", join(root, "tsconfig.json"), "--pretty", "false"],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { ok: true, output: stdout };
  } catch (err: unknown) {
    const execErr = err as {
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      ok: false,
      output: `${execErr.stdout ?? ""}\n${execErr.stderr ?? ""}`.trim(),
    };
  }
}

void describe("@verule/sdk external TypeScript consumer contract", () => {
  void it("compiles valid call -> signature -> instantiated parameter composition against built .d.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "verule-type-contract-ok-"));
    try {
      prepareExternalConsumer(root);

      const validCode = [
        'import { createAdditionalInputRegistry, defineConfig, defineRule, type AdditionalInputEntry, type AdditionalInputRegistrar, type AdditionalInputSource, type CallRef, type DeclarationRef, type SignatureRef, type SyntaxRef, type TypeRef } from "@verule/sdk";',
        "",
        'const registrar: AdditionalInputRegistrar = createAdditionalInputRegistry({ cwd: "/tmp/workspace" });',
        'const adapterSource: AdditionalInputSource = { kind: "adapter", id: "demo-adapter" };',
        'const regEntry: AdditionalInputEntry = registrar.registerAdditionalInput("allowed-packages.json", adapterSource);',
        "void regEntry;",
        "",
        "const validRule = defineRule({",
        '  id: "external-consumer-valid",',
        "  run: async (ctx) => {",
        '    const inputEntry: AdditionalInputEntry = ctx.registerAdditionalInput("allowed-packages.json");',
        "    if (inputEntry.exists) {",
        '      const raw: string = ctx.readAdditionalInput("allowed-packages.json");',
        "      void raw;",
        "    }",
        "    const syntaxNodes = await ctx.findSyntax({",
        '      range: { file: "src/app.ts", startLine: 1, endLine: 20 },',
        '      kinds: ["CallExpression"],',
        "    });",
        "    const callResolutions = await ctx.resolveCalls(",
        "      syntaxNodes.map((n) => n.ref),",
        "      { select: { signature: true, location: true } },",
        "    );",
        "    const callRefs: CallRef[] = [];",
        "    for (const row of callResolutions) {",
        "      if (row.call !== null) {",
        "        callRefs.push(row.call);",
        "      }",
        "    }",
        "    const callRows = await ctx.projectCalls(callRefs, {",
        "      select: { signature: true, returnType: true },",
        "    });",
        "    const sigRefs: SignatureRef[] = [];",
        "    for (const row of callRows) {",
        "      if (row.signature !== null) {",
        "        sigRefs.push(row.signature);",
        "      }",
        "    }",
        "    const sigRows = await ctx.projectSignatures(sigRefs, {",
        "      select: {",
        "        instantiatedParameterTypes: [0],",
        "        returnType: true,",
        "        declaration: true,",
        "      },",
        "    });",
        "    const firstSig = sigRows[0];",
        "    if (firstSig !== undefined) {",
        "      const param0 = firstSig.instantiatedParameterTypes[0];",
        "      if (param0 !== undefined) {",
        "        const sourceType: TypeRef = param0.type.ref;",
        "        const targetType: TypeRef = firstSig.returnType.ref;",
        "        const [assign] = await ctx.isAssignableTo([{ source: sourceType, target: targetType }]);",
        "        if (assign?.assignable) {",
        "          const decl: DeclarationRef | null = firstSig.declaration;",
        "          if (decl !== null) {",
        "            const [lookedUp] = await ctx.syntaxOf([decl], { select: { kind: true, location: true } });",
        "            const syn: SyntaxRef | null = lookedUp?.syntax ?? null;",
        "            if (syn !== null && lookedUp?.location != null) {",
        "              const callers = await ctx.callersOf([decl]);",
        "              const callees = await ctx.calleesOf(callRefs);",
        "              const prop = await ctx.valuePropagation({",
        '                propagation: "value",',
        "                from: syn,",
        "                to: [decl, ...callRefs],",
        "              });",
        "              void callers;",
        "              void callees;",
        "              if (prop.results[0]?.reachable) {",
        '                ctx.report({ at: lookedUp.location, message: "ok" });',
        "              }",
        "            }",
        "          }",
        "        }",
        "      }",
        "    }",
        "  },",
        "});",
        "",
        'export default defineConfig({ tsconfig: "tsconfig.json", additionalInputs: ["allowed-packages.json"], rules: [validRule] });',
        "",
      ].join("\n");

      const result = runConsumerTsc(root, validCode);
      assert.equal(result.ok, true, `Expected tsc to pass:\n${result.output}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("rejects mismatched ProgramRef kinds and reads of unselected projection fields at compile time", () => {
    const root = mkdtempSync(join(tmpdir(), "verule-type-contract-err-"));
    try {
      prepareExternalConsumer(root);

      const negativeCases: readonly {
        readonly name: string;
        readonly body: string;
        readonly expectedPattern: RegExp;
      }[] = [
        {
          name: "DeclarationRef passed to projectCalls",
          body: `
            declare const declRef: DeclarationRef;
            await ctx.projectCalls([declRef], { select: { location: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "SyntaxRef passed to projectCalls",
          body: `
            declare const syntaxRef: SyntaxRef;
            await ctx.projectCalls([syntaxRef], { select: { location: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "TypeRef passed to projectCalls",
          body: `
            declare const typeRef: TypeRef;
            await ctx.projectCalls([typeRef], { select: { location: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "CallRef passed to projectSignatures",
          body: `
            declare const callRef: CallRef;
            await ctx.projectSignatures([callRef], { select: { returnType: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "DeclarationRef passed to projectSignatures",
          body: `
            declare const declRef: DeclarationRef;
            await ctx.projectSignatures([declRef], { select: { returnType: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "SyntaxRef passed to projectSignatures",
          body: `
            declare const syntaxRef: SyntaxRef;
            await ctx.projectSignatures([syntaxRef], { select: { returnType: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "TypeRef passed to projectSignatures",
          body: `
            declare const typeRef: TypeRef;
            await ctx.projectSignatures([typeRef], { select: { returnType: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "CallRef passed to isAssignableTo",
          body: `
            declare const callRef: CallRef;
            declare const typeRef: TypeRef;
            await ctx.isAssignableTo([{ source: callRef, target: typeRef }]);
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "TypeRef passed to syntaxOf",
          body: `
            declare const typeRef: TypeRef;
            await ctx.syntaxOf([typeRef], { select: { location: true } });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "unselected returnType read on projectCalls result",
          body: `
            declare const callRef: CallRef;
            const [row] = await ctx.projectCalls([callRef], { select: { signature: true } });
            void row?.returnType;
          `,
          expectedPattern: /TS2339/u,
        },
        {
          name: "unselected returnType read on projectSignatures result",
          body: `
            declare const sigRef: SignatureRef;
            const [row] = await ctx.projectSignatures([sigRef], { select: { instantiatedParameterTypes: [0] } });
            void row?.returnType;
          `,
          expectedPattern: /TS2339/u,
        },
        {
          name: "unselected location read on resolveDeclarations result",
          body: `
            declare const syntaxRef: SyntaxRef;
            const [row] = await ctx.resolveDeclarations([syntaxRef], { select: { name: true } });
            void row?.location;
          `,
          expectedPattern: /TS2339/u,
        },
        {
          name: "unselected location read on syntaxOf without select",
          body: `
            declare const declRef: DeclarationRef;
            const [row] = await ctx.syntaxOf([declRef]);
            void row?.location;
          `,
          expectedPattern: /TS2339/u,
        },
        {
          name: "SyntaxRef passed to calleesOf",
          body: `
            declare const syntaxRef: SyntaxRef;
            await ctx.calleesOf([syntaxRef]);
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "CallRef passed to callersOf",
          body: `
            declare const callRef: CallRef;
            await ctx.callersOf([callRef]);
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
        {
          name: "TypeRef passed to valuePropagation",
          body: `
            declare const typeRef: TypeRef;
            declare const syntaxRef: SyntaxRef;
            await ctx.valuePropagation({ propagation: "value", from: typeRef, to: [syntaxRef] });
          `,
          expectedPattern: /TS2322|TS2345/u,
        },
      ];

      for (const testCase of negativeCases) {
        const snippet = [
          'import type { CallRef, DeclarationRef, RuleContext, SignatureRef, SyntaxRef, TypeRef } from "@verule/sdk";',
          "",
          "export async function checkContract(ctx: RuleContext): Promise<void> {",
          testCase.body,
          "}",
          "",
        ].join("\n");
        const result = runConsumerTsc(root, snippet);
        assert.equal(
          result.ok,
          false,
          `Expected tsc to reject case "${testCase.name}", but it compiled cleanly.`,
        );
        assert.match(
          result.output,
          testCase.expectedPattern,
          `Unexpected diagnostic for "${testCase.name}":\n${result.output}`,
        );
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
