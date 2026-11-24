import { defineConfig, defineModel, defineRule } from "@verule/sdk";

export default defineConfig({
  tsconfig: "tsconfig.json",
  models: [
    defineModel({
      id: "acme-lifecycle",
      version: "1.0.0",
      instanceBehaviors: [
        {
          kind: "forwards-argument",
          match: {
            module: "@acme/lifecycle",
            container: "Disposable",
            member: "_register",
          },
          argumentIndex: 0,
        },
        {
          kind: "allocates-fresh-instance",
          match: {
            module: "@acme/lifecycle",
            container: "IMenuService",
            member: "createMenu",
          },
        },
      ],
    }),
  ],
  rules: [
    defineRule({
      id: "check-instance-cleanup-match",
      run: async (ctx) => {
        const classes = await ctx.findSyntax({
          files: ["src/app.ts"],
          kinds: ["ClassDeclaration"],
        });
        const calls = await ctx.findSyntax({
          files: ["src/app.ts"],
          kinds: ["CallExpression"],
        });
        const props = await ctx.findSyntax({
          files: ["src/app.ts"],
          kinds: ["PropertyAccessExpression"],
        });
        const varDecls = await ctx.findSyntax({
          files: ["src/app.ts"],
          kinds: ["VariableDeclaration"],
        });

        // Inspect unmodeled external call to confirm missing-instance-model gap is surfaced.
        const untrackedDecl = varDecls.find((d) =>
          d.text.startsWith("untracked ="),
        );
        if (untrackedDecl?.initializer) {
          await ctx.resolveInstances([untrackedDecl.initializer]);
        }

        for (const cls of classes) {
          const clsStart = cls.location.start;
          const clsEnd = cls.location.end;
          const releaseCall = calls.find(
            (c) =>
              c.location.start >= clsStart &&
              c.location.end <= clsEnd &&
              c.text.startsWith("release("),
          );
          const firstEnd =
            varDecls.find(
              (d) =>
                d.location.start >= clsStart &&
                d.location.end <= clsEnd &&
                d.text.startsWith("first ="),
            )?.location.end ?? 0;
          const currentRead = props.find(
            (p) =>
              p.location.start >= clsStart &&
              p.location.end <= clsEnd &&
              p.text === "this._current" &&
              p.location.start > firstEnd,
          );
          if (!releaseCall?.arguments?.[0] || !currentRead) continue;

          const [expectedRes, releasedRes] = await ctx.resolveInstances([
            currentRead.ref,
            releaseCall.arguments[0],
          ]);
          if (
            expectedRes?.instance &&
            releasedRes?.instance &&
            expectedRes.instanceKey !== releasedRes.instanceKey
          ) {
            ctx.report({
              at: releaseCall.location,
              message:
                "release() targets a different instance than this._current.",
              basis: [expectedRes, releasedRes],
            });
          }
        }
      },
    }),
  ],
});
