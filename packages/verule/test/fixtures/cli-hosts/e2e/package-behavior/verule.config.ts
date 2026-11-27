import { defineConfig, defineRule, isSameInstance } from "@boringparts/verule";

const rule = defineRule({
  id: "e2e-package-behavior",
  run: async (ctx) => {
    const vars = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
    const xDecl = vars.find((v) => v.text.startsWith("x ="));
    const yDecl = vars.find((v) => v.text.startsWith("y ="));
    const zDecl = vars.find((v) => v.text.startsWith("z ="));
    const callSyn = calls.find(
      (c) => c.text.includes("adaptValue(") || c.text.includes("forwardValue("),
    );
    if (!xDecl?.initializer || !yDecl?.initializer || !callSyn) return;
    const [impl] = await ctx.resolveImplementations([callSyn.ref]);
    if (impl?.status === "inconclusive") {
      ctx.recordGaps(impl.gaps);
    }
    if (zDecl?.initializer) {
      await ctx.resolveInstances([zDecl.initializer]);
    }
    const [xInst, yInst] = await ctx.resolveInstances([
      xDecl.initializer,
      yDecl.initializer,
    ]);
    if (
      xInst?.status === "proved" &&
      yInst?.status === "proved" &&
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
  projects: [
    "packages/esm/tsconfig.json",
    "packages/cjs/tsconfig.json",
    "packages/shared-pkg/tsconfig.json",
  ],
  rules: [rule],
});
