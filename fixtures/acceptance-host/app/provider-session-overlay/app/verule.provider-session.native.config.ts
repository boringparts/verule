import { neutralProductReviewRule } from "@verule/acceptance-host-app/rule";
import { defineConfig } from "@verule/sdk";

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
