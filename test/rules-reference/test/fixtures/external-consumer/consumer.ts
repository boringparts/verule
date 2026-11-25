import { defineConfig } from "@boringparts/verule";
import { drizzleAdapter } from "@tssae/adapters/drizzle";
import { zodAdapter } from "@tssae/adapters/zod";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [drizzleAdapter, zodAdapter],
  rules: [rowProjectionSatisfiesValidatorRule],
});
