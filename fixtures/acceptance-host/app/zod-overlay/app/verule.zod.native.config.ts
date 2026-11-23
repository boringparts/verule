import {
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
} from "@verule/adapter-zod";
import { defineConfig, defineRule } from "@verule/sdk";

import { neutralProductReviewRule } from "./src/rule.ts";

const zodFactProbe = defineRule({
  id: "zod-native-facts",
  run: async (ctx) => {
    const inputs = await ctx.facts(ValidatorInputFieldsFact, {
      condition: { scope: "calls" },
    });
    const outputs = await ctx.facts(ValidatorOutputFieldsFact, {
      condition: { scope: "calls" },
    });

    for (const input of inputs) {
      const output = outputs.find(
        (candidate) => candidate.subject.handleId === input.subject.handleId,
      );
      if (output === undefined) {
        throw new Error("The Zod adapter omitted matching output field facts.");
      }

      const [subject] = await ctx.syntaxOf([input.subject], {
        select: { location: true },
      });
      if (subject?.location === null || subject?.location === undefined) {
        throw new Error("The Zod adapter returned a call without a location.");
      }

      ctx.report({
        at: subject.location,
        message: JSON.stringify({
          input: input.value,
          output: output.value,
        }),
        evidence: [...input.evidence, ...output.evidence],
      });
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@verule/adapter-zod"],
  rules: [neutralProductReviewRule, zodFactProbe],
});
