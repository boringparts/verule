import { defineConfig, defineRule } from "@boringparts/verule";
import { drizzleZodValidator } from "@tssae/drizzle";

const validatorOutputProbeRule = defineRule({
  id: "validator-output-fields-probe",
  run: async (ctx) => {
    const outputs = await drizzleZodValidator.extractOutputFields(ctx, {
      scope: "calls",
    });
    for (const result of outputs) {
      if (!result.presentFields.includes("age")) {
        const calls = await ctx.syntaxOf([result.target], {
          select: { location: true },
        });
        const loc = calls[0]?.location;
        if (loc) {
          ctx.report({
            at: loc,
            message: `Expected output field "age" to be present on ${result.schemaName ?? "schema"}.`,
            basis: [result],
          });
        }
      }
    }
  },
});

export default defineConfig({
  tsconfig: "packages/app/tsconfig.json",
  rules: [validatorOutputProbeRule],
});
