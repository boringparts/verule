import { defineConfig } from "oxlint";

// TypeScript enforces erasable syntax, including enums and parameter properties.
export default defineConfig({
  categories: { correctness: "error", suspicious: "warn" },
});
