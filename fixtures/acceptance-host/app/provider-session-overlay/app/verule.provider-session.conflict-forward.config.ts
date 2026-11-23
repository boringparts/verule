import { defineConfig } from "@verule/sdk";

import { providerSessionConflictRule } from "./src/provider-session-rules.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@verule/adapter-fixture", "@verule/adapter-fixture-complement"],
  rules: [providerSessionConflictRule],
});
