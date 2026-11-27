import { defineConfig } from "@boringparts/verule";
import { poolResourceOwnershipRule } from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [poolResourceOwnershipRule],
});
