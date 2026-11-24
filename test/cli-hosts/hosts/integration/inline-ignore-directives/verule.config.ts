import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "no-danger",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (call.text.startsWith("danger(")) {
            ctx.report({ at: call.location, message: "Avoid danger()" });
          }
        }
      },
    }),
    defineRule({
      id: "no-other",
      run: () => {},
    }),
  ],
});
