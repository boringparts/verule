import { defineConfig } from "@verule/sdk";

import { neutralProductReviewRule } from "./src/rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [neutralProductReviewRule],
});
