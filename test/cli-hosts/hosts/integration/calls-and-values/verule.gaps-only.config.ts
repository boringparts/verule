import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "gaps-only-check",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["src/entry.ts"],
          kinds: ["CallExpression"],
        });
        const dynCall = calls.find((c) => c.text.startsWith("cb("));
        if (!dynCall) return;
        const resolved = await ctx.resolveCalls([dynCall.ref]);
        if (!resolved[0]?.call) return;
        await ctx.calleesOf([resolved[0].call]);
      },
    }),
  ],
});
