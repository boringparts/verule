import { defineConfig, defineRule } from "@verule/sdk";

const rule = defineRule({
  id: "host-mixed-ts-js-flow",
  run: async (ctx) => {
    const calls = await ctx.findSyntax({
      files: ["src/entry.ts"],
      kinds: ["CallExpression"],
    });
    const forwardCall = calls.find((c) => c.text.startsWith("forwardBridge("));
    const dynCall = calls.find((c) => c.text.startsWith("cb("));
    if (forwardCall && dynCall) {
      const resolved = await ctx.resolveCalls([forwardCall.ref, dynCall.ref], {
        select: { instantiatedParameterTypes: [0] },
      });
      if (
        resolved[0]?.instantiatedParameterTypes[0]?.type.typeText !==
        '"alpha" | "beta"'
      ) {
        throw new Error("Expected JSDoc union type from bridge.js");
      }
      if (resolved[1]?.call) {
        await ctx.calleesOf([resolved[1].call]);
      }
    }
    const varDecls = await ctx.findSyntax({
      files: ["src/entry.ts"],
      kinds: ["VariableDeclaration"],
    });
    const originInit = varDecls.find((d) =>
      d.text.startsWith("origin ="),
    )?.initializer;
    const outDecl = varDecls.find((d) => d.text.startsWith("out ="));
    if (originInit && outDecl) {
      const [outRes] = await ctx.resolveDeclarations([outDecl.ref]);
      if (outRes?.declaration) {
        const prop = await ctx.valuePropagation({
          propagation: "value",
          from: originInit,
          to: [outRes.declaration],
        });
        if (prop.results[0]?.reachable) {
          ctx.report({
            at: outDecl.location,
            message: "Origin propagates through JS bridge to TS sink",
            basis: [prop.results[0]],
          });
        }
      }
    }
  },
});

export default defineConfig({ tsconfig: "tsconfig.json", rules: [rule] });
