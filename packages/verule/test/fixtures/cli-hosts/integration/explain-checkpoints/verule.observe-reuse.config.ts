import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "rule-first",
      run: async (ctx) => {
        await ctx.findSyntax({ kinds: ["CallExpression"] });
      },
    }),
    defineRule({
      id: "rule-second",
      run: async (ctx) => {
        await ctx.findSyntax({ kinds: ["CallExpression"] });
      },
    }),
  ],
});
