import { defineConfig } from "@verule/sdk";

import { requireAgeRule } from "./business-rule.ts";
import { providerB } from "./providers.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [providerB],
  rules: [requireAgeRule],
});
