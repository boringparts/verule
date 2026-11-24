import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "clean-check",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["src/entry.ts"],
          kinds: ["CallExpression"],
        });
        const forwardCall = calls.find((c) =>
          c.text.startsWith("forwardBridge("),
        );
        if (!forwardCall) return;
        const resolved = await ctx.resolveCalls([forwardCall.ref]);
        if (!resolved[0]?.call) return;
        await ctx.calleesOf([resolved[0].call]);
      },
    }),
  ],
});
