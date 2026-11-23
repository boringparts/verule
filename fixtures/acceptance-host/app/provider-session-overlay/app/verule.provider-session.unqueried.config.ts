import { defineConfig } from "@verule/sdk";

import { neutralProductReviewRule } from "../../src/rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [
    "@verule/adapter-fixture",
    "@verule/adapter-fixture-complement",
    "@verule/adapter-drizzle",
  ],
  rules: [neutralProductReviewRule],
});
