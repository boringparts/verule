import { defineConfig } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@verule/acceptance-missing-adapter"],
});
