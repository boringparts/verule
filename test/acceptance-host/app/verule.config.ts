import { defineConfig } from "@boringparts/verule";

import { neutralProductReviewRule } from "./src/rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [neutralProductReviewRule],
});
