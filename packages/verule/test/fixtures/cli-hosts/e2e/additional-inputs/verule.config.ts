import { join } from "node:path";

import { defineConfig, defineRule } from "@boringparts/verule";

const absAllowlist = join(import.meta.dirname, "allowed-packages.json");

export default defineConfig({
  tsconfig: "tsconfig.json",
  additionalInputs: ["./allowed-packages.json"],
  rules: [
    defineRule({
      id: "e2e-allowlist-reader",
      run: async (ctx) => {
        const parsed = JSON.parse(
          ctx.readAdditionalInput("allowed-packages.json"),
        ) as { allowed: string[] };
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (!call.text.startsWith("usePackage(")) continue;
          const m = /usePackage\("([^"]+)"\)/u.exec(call.text);
          const pkg = m?.[1];
          if (pkg !== undefined && !parsed.allowed.includes(pkg)) {
            ctx.report({
              at: call.location,
              message: `Disallowed package "${pkg}"`,
              findingKey: `pkg:${pkg}`,
              basis: [
                { kind: "source", message: `Used ${pkg}`, at: call.location },
              ],
            });
          }
        }
      },
    }),
    defineRule({
      id: "e2e-allowlist-auditor",
      run: (ctx) => {
        ctx.registerAdditionalInput(absAllowlist);
      },
    }),
  ],
});
