import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "escalate-dynamic-gap",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["src/entry.ts"],
          kinds: ["CallExpression"],
        });
        const dynCall = calls.find((c) => c.text.startsWith("cb("));
        if (!dynCall) return;
        const [dynRes] = await ctx.resolveCalls([dynCall.ref]);
        if (!dynRes?.call) return;
        const [calleeRes] = await ctx.calleesOf([dynRes.call]);
        if (!calleeRes) return;
        for (const gap of calleeRes.gaps) {
          ctx.report({
            at: gap.at ?? dynCall.location,
            message: `Escalated dynamic gap: ${gap.message}`,
            basis: [
              {
                kind: "note",
                message: gap.kind,
                ...(gap.at ? { at: gap.at } : {}),
              },
            ],
          });
        }
      },
    }),
  ],
});
