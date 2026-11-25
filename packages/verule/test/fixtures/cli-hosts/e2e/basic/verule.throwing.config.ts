import { defineConfig, defineRule } from "@boringparts/verule";

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
