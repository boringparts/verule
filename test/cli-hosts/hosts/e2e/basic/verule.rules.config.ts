import { defineConfig, defineRule } from "@verule/sdk";

const narrowedStringRule = defineRule({
  id: "host-narrowed-string",
  run: async (ctx) => {
    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
    const sinks = calls.filter((c) => c.text.startsWith("sink("));
    const targets = sinks
      .map((c) => c.arguments?.[1])
      .filter((x) => x !== undefined);
    if (targets.length === 0) return;
    const types = await ctx.typeAt(targets);
    for (const [i, ty] of types.entries()) {
      if (ty.typeText === "string") {
        ctx.report({
          at: sinks[i]!.location,
          message: "sink() received narrowed string",
          findingKey: "narrowed-string",
          basis: [
            {
              kind: "type",
              message: `Narrowed type: ${ty.typeText}`,
              at: sinks[i]!.location,
            },
          ],
        });
      }
    }
  },
});

const fastModeRule = defineRule({
  id: "host-fast-mode",
  run: async (ctx) => {
    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
    const sinks = calls.filter((c) => c.text.startsWith("sink("));
    const targets = sinks
      .map((c) => c.arguments?.[0])
      .filter((x) => x !== undefined);
    if (targets.length === 0) return;
    const types = await ctx.typeAt(targets);
    for (const [i, ty] of types.entries()) {
      if (ty.isLiteral && ty.literalValue === "fast") {
        ctx.report({
          at: sinks[i]!.location,
          message: "sink() called in fast mode",
          findingKey: "fast-mode",
          basis: [
            {
              kind: "type",
              message: `Literal mode: ${ty.typeText}`,
              at: sinks[i]!.location,
            },
          ],
        });
      }
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [narrowedStringRule, fastModeRule],
});
