import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, defineRule } from "@boringparts/verule";

const markerPath = join(import.meta.dirname, "checkpoint-detail-marker.txt");

const explainableRule = defineRule({
  id: "host-explainable-string",
  run: async (ctx) => {
    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
    const sinks = calls.filter((c) => c.text.startsWith("sink("));
    const targets = sinks
      .map((c) => c.arguments?.[1])
      .filter((x) => x !== undefined);
    if (targets.length === 0) return;
    const types = await ctx.typeAt(targets);
    for (const [i, ty] of types.entries()) {
      const call = sinks[i]!;
      if (ty.typeText === "string") {
        ctx.checkpoint("require-string-arg", call, "pass", () => {
          appendFileSync(markerPath, "eval\n");
          return { actualType: ty.typeText };
        });
        ctx.report({
          at: call.location,
          message: "sink() received narrowed string",
          findingKey: "narrowed-string",
        });
      } else {
        ctx.checkpoint("require-string-arg", call, "exclude", () => {
          appendFileSync(markerPath, "eval\n");
          return { actualType: ty.typeText, expected: "string" };
        });
      }
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [explainableRule],
});
