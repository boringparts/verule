import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";
import { defineConfig } from "@verule/sdk";

export default defineConfig({
  tsconfig: "packages/app/tsconfig.json",
  adapters: ["@verule/adapter-drizzle", "@verule/adapter-zod"],
  rules: [rowProjectionSatisfiesValidatorRule],
});
