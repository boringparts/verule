import { defineConfig, defineFactType, defineRule } from "@boringparts/verule";

import { neutralProductReviewRule } from "./src/rule.ts";

type FixtureCallSourceValue = {
  readonly text: string;
  readonly input: string;
  readonly invocation: number;
};

const fixtureCallSourceFact = defineFactType<
  "call",
  undefined,
  FixtureCallSourceValue
>({
  id: "fixture.call-source",
  subjectKind: "call",
});

const nativeFactRule = defineRule({
  id: "native-fact",
  run: async (ctx) => {
    const facts = await ctx.facts(fixtureCallSourceFact);
    const matchingFact = facts.find(
      (fact) => fact.value.text === "getProduct(id)",
    );
    if (
      matchingFact === undefined ||
      !matchingFact.value.input.includes("host-installed-input")
    ) {
      throw new Error(
        "The installed adapter returned no current-snapshot fact.",
      );
    }

    const evidence = matchingFact.evidence[0];
    if (evidence?.at === undefined) {
      throw new Error("The installed adapter returned no source evidence.");
    }
    ctx.report({
      at: evidence.at,
      message: `Native adapter read ${matchingFact.value.text} with ${matchingFact.value.input}.`,
      basis: [matchingFact],
    });
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [neutralProductReviewRule, nativeFactRule],
  adapters: ["@acme/adapter-fixture"],
});
