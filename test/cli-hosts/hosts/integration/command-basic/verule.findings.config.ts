import { defineConfig, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "no-narrowed-string",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const sinks = calls.filter((c) => c.text.startsWith("sink("));
        const args = sinks
          .map((c) => c.arguments?.[0])
          .filter((arg): arg is NonNullable<typeof arg> => arg !== undefined);
        const types = await ctx.typeAt(args);
        for (const [i, ty] of types.entries()) {
          const sinkCall = sinks[i];
          if (ty.typeText === "string" && sinkCall) {
            ctx.report({
              at: sinkCall.location,
              message: "Disallowed string call",
              basis: [{ kind: "type", message: "Argument narrowed to string" }],
            });
          }
        }
      },
    }),
  ],
});
