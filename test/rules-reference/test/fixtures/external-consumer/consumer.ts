import { defineConfig } from "@boringparts/verule";
import { drizzleAdapter } from "@verule/adapter-drizzle";
import { zodAdapter } from "@verule/adapter-zod";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [drizzleAdapter, zodAdapter],
  rules: [rowProjectionSatisfiesValidatorRule],
});
