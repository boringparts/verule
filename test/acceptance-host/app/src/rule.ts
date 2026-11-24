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
    const priceExpressions = priceReads
      .map((read) => ({ read, expression: read.expression }))
      .filter(
        (
          entry,
        ): entry is {
          readonly read: (typeof priceReads)[number];
          readonly expression: NonNullable<
            (typeof priceReads)[number]["expression"]
          >;
        } => entry.expression !== undefined,
      );

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
        ctx.checkpoint(
          "product-query-origin",
          call.location,
          "exclude",
          () => ({
            targets: targets.resolvedTargets.map((t) => ({
              name: t.name,
              file: t.location?.file ?? null,
            })),
          }),
        );
        continue;
      }

      ctx.checkpoint("product-query-origin", call.location, "pass", () => ({
        target: productQuery.name,
        file: productQuery.location?.file ?? null,
      }));

      // Batch all candidate .price reads so unselected reads in other functions stay excluded.
      const propagation = await ctx.valuePropagation({
        propagation: "value",
        from: call.ref,
        to: priceExpressions.map((entry) => entry.expression),
      });
      const matchedFlow = propagation.results.find((flow) => flow.reachable);
      if (matchedFlow === undefined) {
        ctx.checkpoint(
          "price-validation-reachability",
          call.location,
          "exclude",
        );
        continue;
      }

      const matchedPriceRead = priceExpressions.find(
        (entry) => entry.expression.handleId === matchedFlow.to.handleId,
      );
      if (matchedPriceRead === undefined) {
        continue;
      }

      ctx.checkpoint(
        "price-validation-reachability",
        call.location,
        "pass",
        () => ({ priceAt: matchedPriceRead.read.location }),
      );

      ctx.report({
        at: call.location,
        message: "Review products loaded across the package boundary.",
        basis: [
          productQuery,
          matchedPriceRead.read,
          matchedFlow,
          {
            kind: "note",
            message:
              "Business judgment: cross-package product lookups require price review.",
            at: call.location,
          },
        ],
      });
    }
  },
});
