import { defineConfig } from "@boringparts/verule";

import { requireAgeRule } from "./business-rule.ts";
import { providerA, providerB } from "./providers.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [providerA, providerB],
  rules: [requireAgeRule],
});
