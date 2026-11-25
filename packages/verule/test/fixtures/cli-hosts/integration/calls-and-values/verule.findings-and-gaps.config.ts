import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "mixed-flow-and-gap",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["src/entry.ts"],
          kinds: ["CallExpression"],
        });
        const dynCall = calls.find((c) => c.text.startsWith("cb("));
        if (!dynCall) return;
        const [dynRes] = await ctx.resolveCalls([dynCall.ref]);
        if (!dynRes?.call) return;
        await ctx.calleesOf([dynRes.call]);

        const varDecls = await ctx.findSyntax({
          files: ["src/entry.ts"],
          kinds: ["VariableDeclaration"],
        });
        const secretInit = varDecls.find((d) =>
          d.text.startsWith("secret ="),
        )?.initializer;
        const deliveredDecl = varDecls.find((d) =>
          d.text.startsWith("delivered ="),
        );
        if (!secretInit || !deliveredDecl) return;
        const [deliveredRes] = await ctx.resolveDeclarations([
          deliveredDecl.ref,
        ]);
        if (!deliveredRes?.declaration) return;

        const prop = await ctx.valuePropagation({
          propagation: "value",
          from: secretInit,
          to: [deliveredRes.declaration],
        });
        const firstResult = prop.results[0];
        if (firstResult?.reachable) {
          ctx.report({
            at: deliveredDecl.location,
            message: "Secret reached sink across TS -> JS -> TS",
            basis: [firstResult],
          });
        }
      },
    }),
  ],
});
