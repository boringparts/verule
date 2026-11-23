import { defineConfig } from "@verule/sdk";

import { neutralMemberReviewRule } from "./src/rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [neutralMemberReviewRule],
});
