import { defineConfig } from "@boringparts/verule";

import { modePolicy } from "./verule.policy.ts";
import { createRules } from "./verule.rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [...createRules(modePolicy)],
});
