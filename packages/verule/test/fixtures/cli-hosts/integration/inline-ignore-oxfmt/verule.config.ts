import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "no-legacy-register",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (!call.text.startsWith("register(")) continue;
          const arg = call.arguments?.[0];
          if (!arg) continue;
          const [argSyntax] = await ctx.syntaxOf([call.ref], {
            select: { arguments: true },
          });
          void argSyntax;
          const strings = await ctx.findSyntax({
            kinds: ["StringLiteral"],
            range: {
              file: call.location.file,
              start: call.location.start,
              end: call.location.end,
              match: "within",
            },
          });
          for (const s of strings) {
            ctx.report({
              at: s.location,
              message: `Disallowed register key ${s.text}`,
              findingKey: `reg:${s.text}`,
            });
          }
        }
      },
    }),
  ],
});
