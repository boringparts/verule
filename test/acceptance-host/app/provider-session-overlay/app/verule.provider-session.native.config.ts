import { defineConfig } from "@boringparts/verule";
import { neutralProductReviewRule } from "@verule/acceptance-host-app/rule";

import {
  drizzleProviderRule,
  providerSessionCacheRule,
  providerSessionFactRule,
} from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["fixture.inputs.json"],
  adapters: [
    "@acme/adapter-fixture",
    "@acme/adapter-fixture-complement",
    "@tssae/adapters/drizzle",
  ],
  rules: [
    neutralProductReviewRule,
    providerSessionFactRule,
    providerSessionCacheRule,
    drizzleProviderRule,
  ],
});
