import { defineConfig } from "@verule/sdk";

import { alphaProvider } from "./providers.ts";
import { requireAgeRule } from "./shared-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [alphaProvider],
  rules: [requireAgeRule],
});
