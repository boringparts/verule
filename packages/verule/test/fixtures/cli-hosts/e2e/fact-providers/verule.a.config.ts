import { defineConfig } from "@boringparts/verule";

import { requireAgeRule } from "./business-rule.ts";
import { providerA } from "./providers.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [providerA],
  rules: [requireAgeRule],
});
