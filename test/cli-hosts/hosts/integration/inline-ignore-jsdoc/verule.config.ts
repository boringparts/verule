import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "no-sync-export",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        for (const fn of fns) {
          if (fn.text.includes("formatDocumented")) {
            const modeParam = fn.parameters?.[0];
            if (modeParam) {
              const [paramType] = await ctx.typeAt([modeParam]);
              // Assert tsrs resolved the JSDoc @param {'alpha' | 'beta'} union type.
              if (paramType?.typeText !== '"alpha" | "beta"') {
                ctx.report({
                  at: fn.location,
                  message: `Lost JSDoc parameter type: ${paramType?.typeText ?? "none"}`,
                });
              }
            }
            ctx.report({
              at: fn.location,
              message: "Sync export disallowed",
            });
          }
        }
      },
    }),
    defineRule({
      id: "no-eval-like",
      run: async (ctx) => {
        const decls = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
        for (const decl of decls) {
          if (decl.text.startsWith("shim")) {
            ctx.report({
              at: decl.location,
              message: "shim declaration disallowed",
            });
          }
        }
      },
    }),
  ],
});
