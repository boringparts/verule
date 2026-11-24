import { defineConfig } from "@verule/sdk";

import { requireAgeRule } from "./business-rule.ts";
import { providerA } from "./providers.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [providerA],
  rules: [requireAgeRule],
});
