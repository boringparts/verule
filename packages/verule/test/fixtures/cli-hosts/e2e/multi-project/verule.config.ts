import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "e2e-runtime-scope",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["packages/shared/shared.ts"],
          kinds: ["CallExpression"],
        });
        for (const call of calls.filter((c) => c.text.startsWith("sink("))) {
          const arg = call.arguments?.[0];
          if (!arg) continue;
          const [ty] = await ctx.typeAt([arg]);
          if (!ty) continue;
          ctx.report({
            at: call.location,
            message: `Runtime=${ty.typeText}`,
            findingKey: "runtime-mode",
            basis: [
              {
                kind: "type",
                message: `type=${ty.typeText}`,
                at: call.location,
              },
            ],
          });
          ctx.report({
            at: call.location,
            message: "Shared sink call",
            findingKey: "shared-call",
            basis: [{ kind: "source", message: "shared", at: call.location }],
          });
        }
      },
    }),
  ],
});
