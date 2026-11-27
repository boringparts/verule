import { defineConfig } from "@boringparts/verule";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [rowProjectionSatisfiesValidatorRule],
});
