import {
  defineAdapter,
  defineFactProvider,
  type FactContribution,
} from "@verule/sdk";

import {
  ValidatorContractFact,
  type ValidatorContractValue,
} from "./validator-contract.ts";

export const alphaProvider = defineAdapter({
  id: "alpha-validator",
  provides: [
    defineFactProvider(ValidatorContractFact, async (ctx) => {
      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
      const out: FactContribution<"call", ValidatorContractValue>[] = [];
      for (const [idx, call] of calls.entries()) {
        if (!call.text.startsWith("parseWithAlpha(")) continue;
        const callRef = resolved[idx]?.call;
        if (!callRef) continue;
        out.push({
          subject: callRef,
          value: {
            schemaName: "alphaSchema",
            fields: { id: { requirement: "required" } },
            requiredFields: ["id"],
            hasDynamicFields: false,
          },
          evidence: [
            {
              kind: "source",
              message: "alpha-validator extracted alphaSchema",
              at: call.location,
            },
          ],
        });
      }
      return out;
    }),
  ],
});

export const betaProvider = defineAdapter({
  id: "beta-validator",
  provides: [
    defineFactProvider(ValidatorContractFact, async (ctx) => {
      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
      const out: FactContribution<"call", ValidatorContractValue>[] = [];
      for (const [idx, call] of calls.entries()) {
        if (!call.text.startsWith("parseWithBeta(")) continue;
        const callRef = resolved[idx]?.call;
        if (!callRef) continue;
        out.push({
          subject: callRef,
          value: {
            schemaName: "betaSchema",
            fields: { email: { requirement: "required" } },
            requiredFields: ["email"],
            hasDynamicFields: false,
          },
          evidence: [
            {
              kind: "source",
              message: "beta-validator extracted betaSchema",
              at: call.location,
            },
          ],
        });
      }
      return out;
    }),
  ],
});
