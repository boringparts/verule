import { defineConfig } from "@boringparts/verule";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "packages/app/tsconfig.multiple-sources.json",
  adapters: ["@verule/adapter-drizzle", "@verule/adapter-zod"],
  rules: [rowProjectionSatisfiesValidatorRule],
});
