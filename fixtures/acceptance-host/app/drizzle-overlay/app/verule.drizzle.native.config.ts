import { defineConfig } from "@verule/sdk";

import { drizzleProjectionRule } from "./src/drizzle-projection-rule.ts";
import { neutralProductReviewRule } from "./src/rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@verule/adapter-drizzle"],
  rules: [neutralProductReviewRule, drizzleProjectionRule],
});
