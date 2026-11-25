import { defineConfig, defineRule } from "@boringparts/verule";

import { alphaProvider, betaProvider } from "./providers.ts";
import { ValidatorContractFact } from "./validator-contract.ts";

const scopedRule = defineRule({
  id: "beta-only-rule",
  run: async (ctx) => {
    const items = await ctx.facts(ValidatorContractFact, {
      providerId: "beta-validator",
    });
    for (const item of items) {
      const at = item.evidence[0]?.at;
      if (!at) continue;
      ctx.report({
        at,
        message: `Scoped to [${item.providers.join(", ")}]`,
        findingKey: "scoped-beta",
        basis: [item],
      });
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [alphaProvider, betaProvider],
  rules: [scopedRule],
});
