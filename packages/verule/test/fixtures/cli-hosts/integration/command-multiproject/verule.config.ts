import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "runtime-check",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["packages/shared/shared.ts"],
          kinds: ["CallExpression"],
        });
        const sinks = calls.filter((c) => c.text.startsWith("sink("));
        for (const call of sinks) {
          const arg = call.arguments?.[0];
          if (!arg) continue;
          const [ty] = await ctx.typeAt([arg]);
          if (!ty) continue;
          ctx.report({
            at: call.location,
            message: `Runtime resolved to ${ty.typeText}`,
            findingKey: "runtime-divergent",
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
            findingKey: "shared-sink",
            basis: [
              {
                kind: "source",
                message: "Shared call site",
                at: call.location,
              },
            ],
          });
        }
      },
    }),
  ],
});
