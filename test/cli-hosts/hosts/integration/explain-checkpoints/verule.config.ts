import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { defineConfig, defineRule } from "@verule/sdk";

const logPath = join(import.meta.dirname, "lazy-eval-count.txt");

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [
    defineRule({
      id: "rule-no-string-sink",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const sinks = calls.filter((c) => c.text.startsWith("sink("));
        const args = sinks
          .map((c) => c.arguments?.[0])
          .filter((arg): arg is NonNullable<typeof arg> => arg !== undefined);
        const types = await ctx.typeAt(args);
        for (const [i, ty] of types.entries()) {
          const call = sinks[i];
          if (!call) continue;
          if (ty.typeText === "string") {
            ctx.checkpoint("require-string", call, "pass", () => {
              appendFileSync(logPath, "1\n");
              return { actualType: ty.typeText };
            });
            ctx.report({
              at: call.location,
              message: "Disallowed string sink call",
              basis: [{ kind: "type", message: "Argument narrowed to string" }],
            });
          } else {
            ctx.checkpoint("require-string", call, "exclude", () => {
              appendFileSync(logPath, "1\n");
              return { actualType: ty.typeText, expected: "string" };
            });
          }
        }
      },
    }),
    defineRule({
      id: "rule-other",
      run: async (ctx) => {
        await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
      },
    }),
  ],
});
