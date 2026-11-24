import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "rule-with-optional-detail",
      run: async (ctx) => {
        const decls = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
        for (const decl of decls) {
          ctx.checkpoint("checked-decl", decl.location, "pass", () => ({
            present: true,
            optionalName: undefined,
          }));
        }
      },
    }),
  ],
});
