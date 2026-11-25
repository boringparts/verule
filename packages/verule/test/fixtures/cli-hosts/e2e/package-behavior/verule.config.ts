import { defineConfig, defineRule, isSameInstance } from "@boringparts/verule";

const rule = defineRule({
  id: "e2e-package-behavior",
  run: async (ctx) => {
    const vars = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
    const xDecl = vars.find((v) => v.text.startsWith("x ="));
    const yDecl = vars.find((v) => v.text.startsWith("y ="));
    const callSyn = calls.find((c) => c.text.includes("adaptValue("));
    if (!xDecl?.initializer || !yDecl?.initializer || !callSyn) return;
    const [impl] = await ctx.resolveImplementations([callSyn.ref]);
    const [xInst, yInst] = await ctx.resolveInstances([
      xDecl.initializer,
      yDecl.initializer,
    ]);
    if (
      xInst?.instance &&
      yInst?.instance &&
      !isSameInstance(xInst.instance, yInst.instance)
    ) {
      ctx.report({
        at: yDecl.location,
        message: "Package implementation creates a copy",
        basis: impl ? [yInst, impl] : [yInst],
      });
    }
  },
});

export default defineConfig({
  projects: ["packages/esm/tsconfig.json", "packages/cjs/tsconfig.json"],
  rules: [rule],
});
