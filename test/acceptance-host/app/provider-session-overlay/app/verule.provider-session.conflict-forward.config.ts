import { defineConfig } from "@boringparts/verule";

import { providerSessionConflictRule } from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@acme/adapter-fixture", "@acme/adapter-fixture-complement"],
  rules: [providerSessionConflictRule],
});
