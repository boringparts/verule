import { exampleModels, exampleRules } from "@verule/examples";
import { defineConfig } from "@verule/sdk";
export default defineConfig({
  tsconfig: "./tsconfig.json",
  rules: exampleRules,
  models: exampleModels,
});
