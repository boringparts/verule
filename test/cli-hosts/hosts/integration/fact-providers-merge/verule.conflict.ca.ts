import { defineConfig } from "@verule/sdk";

import { conflictC, partA } from "./providers.ts";
import { requireAgeRule } from "./shared-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [conflictC, partA],
  rules: [requireAgeRule],
});
