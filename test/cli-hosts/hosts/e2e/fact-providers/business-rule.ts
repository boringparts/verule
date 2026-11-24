import { defineRule } from "@verule/sdk";

import { InputSpecFact } from "./fact-contract.ts";

export const requireAgeRule = defineRule({
  id: "e2e-require-age",
  run: async (ctx) => {
    const specs = await ctx.facts(InputSpecFact);
    for (const spec of specs) {
      if (!spec.value.required.includes("age")) {
        const rows = await ctx.syntaxOf([spec.subject], {
          select: { location: true },
        });
        const at = rows[0]?.location ?? spec.evidence[0]?.at;
        if (!at) continue;
        ctx.report({
          at,
          message: `Missing required field "age" [${spec.providers.join(", ")}]`,
          findingKey: "missing-age",
          basis: [spec],
        });
      }
    }
  },
});
