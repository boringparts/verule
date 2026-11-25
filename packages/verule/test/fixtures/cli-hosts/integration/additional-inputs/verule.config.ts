import { resolve } from "node:path";

import { defineConfig, defineRule } from "@boringparts/verule";

const absAllowlist = resolve(import.meta.dirname, "allowed-packages.json");

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["./allowed-packages.json"],
  rules: [
    defineRule({
      id: "allowed-package-check",
      run: async (ctx) => {
        const raw = ctx.readAdditionalInput("allowed-packages.json");
        const parsed: unknown = JSON.parse(raw);
        const allowed =
          typeof parsed === "object" &&
          parsed !== null &&
          "allowed" in parsed &&
          Array.isArray(parsed.allowed)
            ? parsed.allowed.filter(
                (item): item is string => typeof item === "string",
              )
            : [];
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (!call.text.startsWith("usePackage(")) continue;
          const match = /usePackage\("([^"]+)"\)/u.exec(call.text);
          const pkg = match?.[1];
          if (pkg && !allowed.includes(pkg)) {
            ctx.report({
              at: call.location,
              message: `Disallowed package "${pkg}"`,
              findingKey: `pkg:${pkg}`,
              basis: [
                {
                  kind: "source",
                  message: `Used ${pkg}`,
                  at: call.location,
                },
              ],
            });
          }
        }
      },
    }),
    defineRule({
      id: "allowed-package-auditor",
      run: (ctx) => {
        ctx.registerAdditionalInput(absAllowlist);
      },
    }),
  ],
});
