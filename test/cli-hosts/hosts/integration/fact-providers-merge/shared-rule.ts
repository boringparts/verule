import { defineRule } from "@verule/sdk";

import { ValidatorContractFact } from "./validator-contract.ts";

export const requireAgeRule = defineRule({
  id: "require-age-validator",
  run: async (ctx) => {
    const facts = await ctx.facts(ValidatorContractFact);
    for (const fact of facts) {
      if (!fact.value.requiredFields.includes("age")) {
        const rows = await ctx.syntaxOf([fact.subject], {
          select: { location: true },
        });
        const at = rows[0]?.location ?? fact.evidence[0]?.at;
        if (!at) continue;
        ctx.report({
          at,
          message: `Validator "${fact.value.schemaName ?? "unknown"}" is missing required field "age" [${fact.providers.join(", ")}]`,
          findingKey: "missing-age",
          basis: [fact],
        });
      }
    }
  },
});
