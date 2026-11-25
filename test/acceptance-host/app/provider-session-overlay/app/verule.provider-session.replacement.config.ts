import { defineConfig } from "@boringparts/verule";

import { providerSessionFactRule } from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["fixture.inputs.json"],
  adapters: ["@acme/adapter-fixture-complement", "@tssae/adapters/drizzle"],
  rules: [providerSessionFactRule],
});
