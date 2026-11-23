import { defineConfig } from "@verule/sdk";

import { neutralProductReviewRule } from "../../src/rule.ts";
import {
  drizzleProviderRule,
  providerSessionCacheRule,
  providerSessionFactRule,
} from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["fixture.inputs.json"],
  adapters: [
    "@verule/adapter-fixture",
    "@verule/adapter-fixture-complement",
    "@verule/adapter-drizzle",
  ],
  rules: [
    neutralProductReviewRule,
    providerSessionFactRule,
    providerSessionCacheRule,
    drizzleProviderRule,
  ],
});
