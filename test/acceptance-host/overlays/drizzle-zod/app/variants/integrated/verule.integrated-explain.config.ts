import { defineConfig } from "@boringparts/verule";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "packages/app/tsconfig.json",
  rules: [rowProjectionSatisfiesValidatorRule],
});
