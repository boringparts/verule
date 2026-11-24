import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "fail-rule",
      run: () => {
        throw new Error("boom");
      },
    }),
  ],
});
