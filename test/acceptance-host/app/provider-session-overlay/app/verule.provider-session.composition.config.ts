import { defineConfig } from "@verule/sdk";

import {
  derivedConsumerCacheRule,
  derivedConsumerCompositionRule,
} from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [
    "@verule/adapter-fixture",
    "@verule/adapter-fixture-complement",
    "@verule/adapter-drizzle",
  ],
  rules: [derivedConsumerCompositionRule, derivedConsumerCacheRule],
});
