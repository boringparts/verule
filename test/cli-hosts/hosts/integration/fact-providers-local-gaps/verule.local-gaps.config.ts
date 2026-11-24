import {
  defineAdapter,
  defineConfig,
  defineFactProvider,
  defineFactType,
  defineRule,
  type Gap,
} from "@verule/sdk";

type SpecFactValue = {
  readonly fields: Readonly<Record<string, string>>;
  readonly unknownFields: readonly string[];
};

type ConsumerFactValue = SpecFactValue & {
  readonly consumerName: string;
};

const SourceFact = defineFactType<"syntax", unknown, SpecFactValue>({
  id: "cli.explain.source",
  subjectKind: "syntax",
});
const ConsumerFact = defineFactType<"syntax", unknown, ConsumerFactValue>({
  id: "cli.explain.consumer",
  subjectKind: "syntax",
});
const UnusedFact = defineFactType<"syntax", unknown, unknown>({
  id: "cli.explain.unused",
  subjectKind: "syntax",
});

const adapterA = defineAdapter({
  id: "cli-adapter-a",
  provides: [
    defineFactProvider(SourceFact, async (ctx, req) => {
      const calls = await ctx.findSyntax({
        files: ["src/source.ts"],
        kinds: ["CallExpression"],
      });
      const spec = calls.find((c) => c.text.startsWith("defineSpec("));
      const dyn = calls.find((c) => c.text.startsWith("dynamicSpec("));
      if (!spec || !dyn) return [];
      const gap: Gap = {
        kind: "unresolved-field",
        message: "Field couponCode is dynamic.",
        at: dyn.location,
      };
      return [
        {
          subject: spec.ref,
          value: {
            fields: { orderId: "required" },
            unknownFields: ["couponCode"],
          },
          gaps: [gap],
          ...(req.explain
            ? {
                explainTrace: {
                  localGaps: [
                    {
                      status: "unresolved" as const,
                      factTypeId: SourceFact.id,
                      providerId: "cli-adapter-a",
                      field: "couponCode",
                      gap,
                      subjectLocation: spec.location,
                    },
                  ],
                },
              }
            : {}),
        },
      ];
    }),
  ],
});

const adapterB = defineAdapter({
  id: "cli-adapter-b",
  provides: [
    defineFactProvider(ConsumerFact, async (ctx, req) => {
      const srcCalls = await ctx.findSyntax({
        files: ["src/source.ts"],
        kinds: ["CallExpression"],
      });
      const srcTarget = srcCalls.find((c) => c.text.startsWith("defineSpec("));
      if (!srcTarget) return [];
      const srcFacts = await ctx.facts(SourceFact, {
        targets: [srcTarget.ref],
      });
      const factA = srcFacts[0];
      if (!factA) return [];
      const calls = await ctx.findSyntax({
        files: ["src/consumer.ts"],
        kinds: ["CallExpression"],
      });
      return calls
        .filter((c) => c.text.startsWith("useSpec("))
        .map((call) => {
          const isOverridden = call.text.includes("defaulted");
          const initialGap = factA.gaps[0];
          return {
            subject: call.ref,
            value: {
              consumerName: isOverridden ? "overridden" : "raw",
              fields: isOverridden
                ? { orderId: "required", couponCode: "defaulted" }
                : { orderId: "required" },
              unknownFields: isOverridden ? [] : ["couponCode"],
            },
            evidence: [
              { kind: "source", message: "derived", at: call.location },
            ],
            gaps: isOverridden ? [] : factA.gaps,
            ...(req.explain && initialGap
              ? {
                  explainTrace: {
                    localGaps: [
                      {
                        status: isOverridden
                          ? ("resolved_by_override" as const)
                          : ("unresolved" as const),
                        factTypeId: SourceFact.id,
                        providerId: "cli-adapter-a",
                        field: "couponCode",
                        gap: initialGap,
                        subjectLocation: call.location,
                        ...(isOverridden
                          ? {
                              resolvedBy: {
                                providerId: "cli-adapter-b",
                                operation: "override",
                                conclusion: "couponCode=defaulted",
                                at: call.location,
                              },
                            }
                          : {}),
                      },
                    ],
                  },
                }
              : {}),
          };
        });
    }),
  ],
});

const unusedAdapter = defineAdapter({
  id: "cli-adapter-unused",
  provides: [defineFactProvider(UnusedFact, () => [])],
});

const couponRule = defineRule({
  id: "cli-coupon-rule",
  run: async (ctx) => {
    const facts = await ctx.facts(ConsumerFact);
    for (const fact of facts) {
      if (fact.value.unknownFields.includes("couponCode")) continue;
      if (fact.value.fields.couponCode === "defaulted") {
        const at = fact.evidence[0]?.at;
        if (!at) continue;
        ctx.report({
          at,
          message: "coupon defaulted",
          basis: [fact],
        });
      }
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [adapterA, adapterB, unusedAdapter],
  rules: [couponRule],
});
