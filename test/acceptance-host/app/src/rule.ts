import { defineRule } from "@verule/sdk";

export const neutralProductReviewRule = defineRule({
  id: "neutral-product-review",
  run: async (ctx) => {
    const reviewCalls = await ctx.findSyntax({
      files: ["packages/app/src/review.ts"],
      kinds: ["CallExpression"],
    });
    const resolvedCalls = await ctx.resolveCalls(
      reviewCalls.map((call) => call.ref),
      { select: { location: true } },
    );
    const callTargets = await ctx.calleesOf(
      resolvedCalls
        .map((resolved) => resolved.call)
        .filter((call) => call !== null),
    );
    const callTargetsByHandle = new Map(
      callTargets.map((result) => [result.call.handleId, result]),
    );
    const priceReads = await ctx.findSyntax({
      files: ["packages/app/src/review.ts"],
      kinds: ["PropertyAccessExpression"],
      textIncludes: [".price"],
    });

    for (const [index, resolved] of resolvedCalls.entries()) {
      const call = reviewCalls[index];
      if (call === undefined || resolved.call === null) {
        continue;
      }

      const targets = callTargetsByHandle.get(resolved.call.handleId);
      if (targets === undefined) {
        continue;
      }
      const productQuery = targets.resolvedTargets.find(
        (target) =>
          target.name === "findProduct" &&
          target.location?.file === "packages/data/src/product.ts",
      );
      if (productQuery === undefined || productQuery.location === null) {
        continue;
      }

      for (const priceRead of priceReads) {
        const productValue = priceRead.expression;
        if (!priceRead.text.endsWith(".price") || productValue === undefined) {
          continue;
        }
        // Check the imported query result against the binding read by the price validation.
        const propagation = await ctx.valuePropagation({
          propagation: "value",
          from: call.ref,
          to: [productValue],
        });
        const flow = propagation.results[0];
        if (!flow?.reachable) {
          continue;
        }

        ctx.report({
          at: call.location,
          message: "Review products loaded across the package boundary.",
          evidence: [
            {
              kind: "source",
              message: "The call resolves to the data package product query.",
              at: productQuery.location,
            },
            {
              kind: "source",
              message: "The returned product reaches its price validation.",
              at: priceRead.location,
            },
            ...flow.evidence,
          ],
        });
        break;
      }
    }
  },
});
