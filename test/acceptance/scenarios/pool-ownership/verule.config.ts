import { defineConfig } from "@boringparts/verule";
import {
  poolResourceOwnershipModel,
  poolResourceOwnershipRule,
} from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "tsconfig.json",
  models: [poolResourceOwnershipModel],
  rules: [poolResourceOwnershipRule],
});
