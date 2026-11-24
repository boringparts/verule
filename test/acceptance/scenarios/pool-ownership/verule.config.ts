import {
  poolResourceOwnershipModel,
  poolResourceOwnershipRule,
} from "@verule/rules-reference";
import { defineConfig } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  models: [poolResourceOwnershipModel],
  rules: [poolResourceOwnershipRule],
});
