import { defineConfig } from "@verule/sdk";

import { betaProvider } from "./providers.ts";
import { requireAgeRule } from "./shared-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [betaProvider],
  rules: [requireAgeRule],
});
