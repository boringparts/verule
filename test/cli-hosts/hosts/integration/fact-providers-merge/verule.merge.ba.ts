import { defineConfig } from "@verule/sdk";

import { partA, partB } from "./providers.ts";
import { requireAgeRule } from "./shared-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [partB, partA],
  rules: [requireAgeRule],
});
