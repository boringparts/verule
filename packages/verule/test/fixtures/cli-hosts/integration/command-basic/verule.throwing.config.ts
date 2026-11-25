import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "throwing-rule",
      run: () => {
        throw new Error("boom");
      },
    }),
  ],
});
