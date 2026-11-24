import { defineFactType, defineRule } from "@verule/sdk";

type ProviderSessionCondition = {
  readonly mode: "normal" | "conflict";
};

type ProviderSessionValue = {
  readonly text?: string;
  readonly input?: string;
  readonly invocation?: number;
  readonly annotation?: string;
  readonly secondaryInvocation?: number;
};

export let lastComplementInvocation: number | undefined;

export const providerSessionFact = defineFactType<
  "call",
  ProviderSessionCondition,
  ProviderSessionValue
>({
  id: "fixture.call-source",
  subjectKind: "call",
  merge: (existing, incoming) => {
    if (
      existing.value.input !== undefined &&
      incoming.value.input !== undefined &&
      existing.value.input !== incoming.value.input
    ) {
      return {
        ok: false,
        conflict: {
          message: "Native fixture providers disagree about the input value.",
          existingConclusion: `input=${existing.value.input}`,
          incomingConclusion: `input=${incoming.value.input}`,
          existingEvidence: existing.evidence,
          incomingEvidence: incoming.evidence,
        },
      };
    }

    return {
      ok: true,
      value: { ...existing.value, ...incoming.value },
    };
  },
});

type DrizzleProjectionValue = {
  readonly queryKind: string;
  readonly tableName?: string;
  readonly projectedColumns: readonly string[];
  readonly hasDynamicColumns: boolean;
};

const drizzleProjectionFact = defineFactType<
  "syntax" | "call" | "declaration",
  { readonly library: "drizzle" },
  DrizzleProjectionValue
>({
  id: "verule.query.row-projection",
  subjectKind: ["syntax", "call", "declaration"],
});

export const providerSessionFactRule = defineRule({
  id: "provider-session-facts",
  run: async (ctx) => {
    const policy = ctx.readAdditionalInput("fixture.inputs.json");
    const facts = await ctx.facts(providerSessionFact, {
      condition: { mode: "normal" },
    });
    const fact = facts.find((candidate) =>
      candidate.value.text?.startsWith("getProduct("),
    );
    if (fact === undefined || fact.value.input !== policy) {
      throw new Error(
        "The fixture providers did not return the current input.",
      );
    }
    lastComplementInvocation = fact.value.secondaryInvocation;
    const input = JSON.parse(fact.value.input) as unknown;
    if (typeof input !== "string") {
      throw new Error("The fixture providers returned a non-string input.");
    }

    const at = fact.evidence.find((item) => item.at !== undefined)?.at;
    if (at === undefined) {
      throw new Error("The fixture providers returned no source evidence.");
    }
    ctx.report({
      at,
      findingKey: "provider-session-fact",
      message: JSON.stringify({
        text: fact.value.text,
        input,
        annotation: fact.value.annotation,
      }),
      evidence: fact.evidence,
    });
  },
});

export const providerSessionCacheRule = defineRule({
  id: "provider-session-cache",
  run: async (ctx) => {
    ctx.registerAdditionalInput("./fixture.inputs.json");
    await ctx.facts(providerSessionFact, { condition: { mode: "normal" } });
  },
});

export const providerSessionFilteredRule = defineRule({
  id: "provider-session-filtered",
  run: async (ctx) => {
    const facts = await ctx.facts(providerSessionFact, {
      condition: { mode: "normal" },
      providerId: "third-party-fixture-complement",
    });
    const fact = facts.find((candidate) =>
      candidate.value.text?.startsWith("getProduct("),
    );
    if (fact === undefined) {
      throw new Error("The selected native provider returned no fixture fact.");
    }
    const at = fact.evidence.find((item) => item.at !== undefined)?.at;
    if (at === undefined) {
      throw new Error("The selected native provider returned no evidence.");
    }
    ctx.report({
      at,
      findingKey: "provider-session-filtered-fact",
      message: JSON.stringify({
        text: fact.value.text,
        input: fact.value.input,
        annotation: fact.value.annotation,
      }),
      evidence: fact.evidence,
    });
  },
});

export const providerSessionConflictRule = defineRule({
  id: "provider-session-conflict",
  run: async (ctx) => {
    await ctx.facts(providerSessionFact, { condition: { mode: "conflict" } });
  },
});

export const drizzleProviderRule = defineRule({
  id: "provider-session-drizzle",
  run: async (ctx) => {
    const facts = await ctx.facts(drizzleProjectionFact, {
      condition: { library: "drizzle" },
    });
    const fact = facts.find((candidate) =>
      candidate.value.projectedColumns.includes("title"),
    );
    if (fact === undefined) {
      throw new Error(
        "The Drizzle provider returned no projected title column.",
      );
    }
    const at = fact.evidence.find((item) => item.at !== undefined)?.at;
    if (at === undefined) {
      throw new Error("The Drizzle provider returned no source evidence.");
    }
    ctx.report({
      at,
      findingKey: "provider-session-drizzle-fact",
      message: JSON.stringify(fact.value),
      evidence: fact.evidence,
    });
  },
});

type DerivedConsumerValue = {
  readonly consumerName: string;
  readonly sourceName: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly requiredFields: readonly string[];
  readonly optionalFields: readonly string[];
  readonly defaultedFields: readonly string[];
  readonly unknownFields: readonly string[];
  readonly hasDynamicFields: boolean;
  readonly sourceProviders: readonly string[];
};

const derivedConsumerFact = defineFactType<
  "syntax" | "call" | "declaration",
  undefined,
  DerivedConsumerValue
>({
  id: "fixture.derived-consumer",
  subjectKind: ["syntax", "call", "declaration"],
});

export const derivedConsumerCompositionRule = defineRule({
  id: "provider-session-composition",
  run: async (ctx) => {
    const facts = await ctx.facts(derivedConsumerFact);
    const fact = facts.find(
      (candidate) =>
        candidate.value.sourceName === "order" &&
        candidate.value.consumerName === "sessionOrderConsumer",
    );
    if (fact === undefined) {
      throw new Error(
        "The consumer fact provider did not return a derived consumer fact for sessionOrderConsumer.",
      );
    }
    const at = fact.evidence.find((item) =>
      item.message.includes('Fixture consumer "sessionOrderConsumer"'),
    )?.at;
    if (at === undefined) {
      throw new Error("The consumer fact returned no subject evidence.");
    }
    ctx.report({
      at,
      findingKey: "provider-session-composition-fact",
      message: JSON.stringify(fact.value),
      basis: [fact],
    });
  },
});

export const derivedConsumerCacheRule = defineRule({
  id: "provider-session-composition-cache",
  run: async (ctx) => {
    const facts = await ctx.facts(derivedConsumerFact);
    if (facts.length === 0) {
      throw new Error("Expected cached derived consumer facts.");
    }
  },
});

export const derivedConsumerIndependentFieldRule = defineRule({
  id: "provider-session-independent-field",
  run: async (ctx) => {
    const facts = await ctx.facts(derivedConsumerFact);
    for (const fact of facts) {
      if (fact.value.fields.orderId !== "required") {
        continue;
      }
      const at = fact.evidence.find((item) =>
        item.message.includes(`Fixture consumer "${fact.value.consumerName}"`),
      )?.at;
      if (at === undefined) {
        continue;
      }
      ctx.report({
        at,
        findingKey: `independent-order-id-${fact.value.consumerName}`,
        message: `${fact.value.consumerName}: orderId is required`,
        basis: [fact],
      });
    }
  },
});

export const derivedConsumerCouponCheckRule = defineRule({
  id: "provider-session-coupon-check",
  run: async (ctx) => {
    const facts = await ctx.facts(derivedConsumerFact);
    for (const fact of facts) {
      if (fact.value.unknownFields.includes("couponCode")) {
        continue;
      }
      if (fact.value.fields.couponCode === "defaulted") {
        const at = fact.evidence.find((item) =>
          item.message.includes(
            `Fixture consumer "${fact.value.consumerName}"`,
          ),
        )?.at;
        if (at === undefined) {
          continue;
        }
        ctx.report({
          at,
          findingKey: `coupon-defaulted-${fact.value.consumerName}`,
          message: `${fact.value.consumerName}: couponCode defaulted`,
          basis: [fact],
        });
      }
    }
  },
});
