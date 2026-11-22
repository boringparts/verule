import lintConfiguration from "@verule/tooling-config/oxlint";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [lintConfiguration],
  options: { typeAware: true },
  // Turbo allows the engine as a transitive dependency of the CLI. Only the SDK imports it.
  overrides: [
    {
      files: ["packages/cli/**/*.ts"],
      rules: {
        "no-restricted-imports": [
          "error",
          { patterns: ["@verule/engine", "@verule/engine/*"] },
        ],
      },
    },
  ],
});
