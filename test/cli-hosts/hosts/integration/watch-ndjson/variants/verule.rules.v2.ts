import { defineRule, type Rule } from "@verule/sdk";

export function createRules(): readonly Rule[] {
  return [
    defineRule({
      id: "disallow-mode-v2",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const c of calls) {
          if (c.text.startsWith("sink(")) {
            ctx.report({ at: c.location, message: "sink called" });
          }
        }
      },
    }),
  ];
}
