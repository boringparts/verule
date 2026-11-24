import { defineConfig } from "@verule/sdk";

import { drizzleProjectionRule } from "./src/drizzle-projection-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@verule/adapter-drizzle"],
  rules: [drizzleProjectionRule],
});
