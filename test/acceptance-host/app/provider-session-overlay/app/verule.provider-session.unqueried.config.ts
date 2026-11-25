import { defineConfig } from "@boringparts/verule";
import { neutralProductReviewRule } from "@verule/acceptance-host-app/rule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [
    "@verule/adapter-fixture",
    "@verule/adapter-fixture-complement",
    "@verule/adapter-drizzle",
  ],
  rules: [neutralProductReviewRule],
});
