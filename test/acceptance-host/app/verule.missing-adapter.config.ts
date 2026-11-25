import { defineConfig } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: ["@verule/acceptance-missing-adapter"],
});
