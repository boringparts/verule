import { defineConfig, defineModel, defineRule } from "@boringparts/verule";

export default defineConfig({
  projects: ["packages/esm/tsconfig.json", "packages/cjs/tsconfig.json"],
  models: [
    defineModel({
      id: "dual-pkg-model",
      instanceBehaviors: [
        {
          kind: "forwards-argument",
          match: { module: "dual-pkg", member: "modeledFactory" },
          argumentIndex: 0,
        },
      ],
    }),
  ],
  rules: [
    defineRule({
      id: "check-conditional-package-copy",
      run: async (ctx) => {
        const varDecls = await ctx.findSyntax({
          kinds: ["VariableDeclaration"],
        });
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const tokDecl = varDecls.find((d) => d.text.startsWith("tok"));
        const outDecl = varDecls.find((d) => d.text.startsWith("out ="));
        const modDecl = varDecls.find((d) => d.text.startsWith("mod ="));
        const callSyn = calls.find((c) => c.text.includes("forwardOrClone("));
        if (!tokDecl?.initializer || !outDecl?.initializer || !callSyn) return;

        const [callProj] = await ctx.resolveCalls([callSyn.ref], {
          select: { returnType: true, signature: true },
        });
        if (!callProj?.returnType || !callProj.signature) {
          throw new Error(
            "Expected signature and return type from declaration",
          );
        }

        const [implRes] = await ctx.resolveImplementations([callSyn.ref]);
        const [tokInst, outInst] = await ctx.resolveInstances([
          tokDecl.initializer,
          outDecl.initializer,
        ]);
        if (modDecl?.initializer) {
          await ctx.resolveInstances([modDecl.initializer]);
        }

        if (
          tokInst?.instance &&
          outInst?.instance &&
          tokInst.instanceKey !== outInst.instanceKey
        ) {
          ctx.report({
            at: outDecl.location,
            message:
              "Conditional export returned a cloned copy instead of the original instance.",
            basis: implRes ? [outInst, implRes] : [outInst],
          });
        }
      },
    }),
  ],
});
