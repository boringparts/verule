import { defineRule } from "@verule/sdk";

export const neutralMemberReviewRule = defineRule({
  id: "neutral-member-review",
  run: async (ctx) => {
    const declarations = await ctx.findSyntax({
      files: ["packages/data/src/member.ts"],
      kinds: ["FunctionDeclaration"],
    });
    const getMemberDeclaration = declarations.find((declaration) =>
      declaration.text.startsWith("export function getMember("),
    );
    const calls = await ctx.findSyntax({
      files: ["packages/app/src/review.ts"],
      kinds: ["CallExpression"],
    });
    const memberCalls = calls.filter((call) =>
      call.text.startsWith("getMember("),
    );

    for (const call of memberCalls) {
      ctx.report({
        at: call.location,
        message: "Review values loaded across the package boundary.",
        ...(getMemberDeclaration === undefined
          ? {}
          : {
              evidence: [
                {
                  kind: "source" as const,
                  message: "The value is loaded by the data package.",
                  at: getMemberDeclaration.location,
                },
              ],
            }),
      });
    }

    const dynamicCall = calls.find((call) => call.text.startsWith("invoke("));
    if (dynamicCall !== undefined) {
      const [resolved] = await ctx.resolveCalls([dynamicCall.ref]);
      if (resolved?.call !== null && resolved?.call !== undefined) {
        await ctx.calleesOf([resolved.call]);
      }
    }
  },
});
