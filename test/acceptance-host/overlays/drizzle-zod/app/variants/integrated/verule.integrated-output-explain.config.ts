import { defineConfig, defineRule } from "@boringparts/verule";
import { ValidatorOutputFieldsFact } from "@tssae/adapters/zod";

const validatorOutputProbeRule = defineRule({
  id: "validator-output-fields-probe",
  run: async (ctx) => {
    const outputs = await ctx.facts(ValidatorOutputFieldsFact, {
      condition: { scope: "calls" },
    });
    for (const fact of outputs) {
      if (!fact.value.presentFields.includes("age")) {
        const calls = await ctx.syntaxOf([fact.subject], {
          select: { location: true },
        });
        const loc = calls[0]?.location;
        if (loc) {
          ctx.report({
            at: loc,
            message: `Expected output field "age" to be present on ${fact.value.schemaName ?? "schema"}.`,
            basis: [fact],
          });
        }
      }
    }
  },
});

export default defineConfig({
  tsconfig: "packages/app/tsconfig.json",
  adapters: [
    "@tssae/adapters/drizzle",
    "@tssae/adapters/zod",
    "@acme/adapter-fixture",
  ],
  rules: [validatorOutputProbeRule],
});
