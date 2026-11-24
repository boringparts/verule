import { defineRule, type Rule } from "@verule/sdk";

export function createRules(): readonly Rule[] {
  return [
    defineRule({
      id: "disallow-mode",
      run: async (ctx) => {
        const model = ctx.getModel("mode-policy");
        const rawForbidden = model?.facts?.disallowedMode;
        const forbidden =
          typeof rawForbidden === "string" ? rawForbidden : "fast";
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const sinks = calls.filter((c) => c.text.startsWith("sink("));
        const args = sinks
          .map((c) => c.arguments?.[0])
          .filter((arg): arg is NonNullable<typeof arg> => arg !== undefined);
        if (args.length === 0) return;
        const types = await ctx.typeAt(args);
        for (const [i, ty] of types.entries()) {
          const sinkCall = sinks[i];
          if (ty.isLiteral && ty.literalValue === forbidden && sinkCall) {
            ctx.report({
              at: sinkCall.location,
              message: `Disallowed mode ${forbidden} (v${model?.version ?? "0"})`,
              findingKey: `mode:${forbidden}`,
              basis: [
                {
                  kind: "type",
                  message: `Narrowed to ${ty.typeText}`,
                  at: sinkCall.location,
                },
              ],
            });
          }
        }
      },
    }),
  ];
}
