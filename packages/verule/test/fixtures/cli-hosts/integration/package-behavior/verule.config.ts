import { defineConfig, defineRule } from "@boringparts/verule";

export default defineConfig({
  projects: [
    "packages/esm/tsconfig.json",
    "packages/cjs/tsconfig.json",
    "packages/shared-pkg/tsconfig.json",
  ],
  rules: [
    defineRule({
      id: "check-first-party-package-copy",
      run: async (ctx) => {
        const varDecls = await ctx.findSyntax({
          kinds: ["VariableDeclaration"],
        });
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const tokDecl = varDecls.find((d) => d.text.startsWith("tok"));
        const forwardedDecl = varDecls.find((d) =>
          d.text.startsWith("forwarded ="),
        );
        const outDecl = varDecls.find((d) => d.text.startsWith("out ="));
        const untrackedDecl = varDecls.find((d) =>
          d.text.startsWith("untracked ="),
        );
        const cloneCall = calls.find((c) => c.text.includes("cloneToken("));
        const extCall = calls.find((c) => c.text.includes("opaqueExternal("));
        if (!tokDecl?.initializer || !cloneCall) return;

        const [cloneImpl] = await ctx.resolveImplementations([cloneCall.ref]);
        if (cloneImpl?.status === "inconclusive") {
          ctx.recordGaps(cloneImpl.gaps);
        }
        if (extCall) {
          const [extImpl] = await ctx.resolveImplementations([extCall.ref]);
          if (extImpl && extImpl.status !== "external") {
            throw new Error(
              `Expected opaqueExternal() to resolve as external, got ${extImpl.status}`,
            );
          }
        }
        if (untrackedDecl?.initializer) {
          await ctx.resolveInstances([untrackedDecl.initializer]);
        }

        const targets = [
          tokDecl.initializer,
          ...(forwardedDecl?.initializer ? [forwardedDecl.initializer] : []),
          ...(outDecl?.initializer ? [outDecl.initializer] : []),
        ];
        const resolved = await ctx.resolveInstances(targets);
        const tokInst = resolved[0];
        const outInst = outDecl?.initializer ? resolved.at(-1) : undefined;

        if (
          tokInst?.status === "proved" &&
          outInst?.status === "proved" &&
          tokInst.instanceKey !== outInst.instanceKey &&
          outDecl
        ) {
          ctx.report({
            at: outDecl.location,
            message:
              "First-party workspace package returned a cloned copy instead of forwarding the original instance.",
            basis: cloneImpl ? [outInst, cloneImpl] : [outInst],
          });
        }
      },
    }),
  ],
});
