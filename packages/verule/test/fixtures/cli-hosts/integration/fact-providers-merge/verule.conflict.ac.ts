import { defineConfig } from "@boringparts/verule";

import { conflictC, partA } from "./providers.ts";
import { requireAgeRule } from "./shared-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [partA, conflictC],
  rules: [requireAgeRule],
});
