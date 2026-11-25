import { defineConfig } from "@boringparts/verule";

import { drizzleProjectionRule } from "./src/drizzle-projection-rule.ts";
import { drizzleTableColumnsRule } from "./src/drizzle-table-columns-rule.ts";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@tssae/adapters/drizzle"],
  rules: [drizzleProjectionRule, drizzleTableColumnsRule],
});
