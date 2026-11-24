import { defineConfig } from "@verule/sdk";

import { modePolicy } from "./verule.model.ts";
import { createRules } from "./verule.rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  models: [modePolicy],
  rules: [...createRules()],
});
