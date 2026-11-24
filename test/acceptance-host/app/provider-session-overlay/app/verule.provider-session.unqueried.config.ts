import { neutralProductReviewRule } from "@verule/acceptance-host-app/rule";
import { defineConfig } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [
    "@verule/adapter-fixture",
    "@verule/adapter-fixture-complement",
    "@verule/adapter-drizzle",
  ],
  rules: [neutralProductReviewRule],
});
