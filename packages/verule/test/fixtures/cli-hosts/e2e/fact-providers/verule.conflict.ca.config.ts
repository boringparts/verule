import { defineConfig } from "@boringparts/verule";

import { requireAgeRule } from "./business-rule.ts";
import { providerA, providerConflict } from "./providers.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [providerConflict, providerA],
  rules: [requireAgeRule],
});
