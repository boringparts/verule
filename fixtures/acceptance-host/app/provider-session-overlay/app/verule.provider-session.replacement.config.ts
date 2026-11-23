import { defineConfig } from "@verule/sdk";

import { providerSessionFactRule } from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["fixture.inputs.json"],
  adapters: ["@verule/adapter-fixture-complement", "@verule/adapter-drizzle"],
  rules: [providerSessionFactRule],
});
