import { defineFactType } from "@verule/sdk";

export type FixtureComplementCondition = {
  readonly mode: "normal" | "conflict" | "targeted-conflict";
};

export type FixtureComplementValue = {
  readonly text: string;
  readonly input: string;
  readonly annotation: string;
  readonly secondaryInvocation: number;
};

export const FixtureCallSourceFact = defineFactType<
  "call",
  FixtureComplementCondition,
  FixtureComplementValue
>({
  id: "fixture.call-source",
  description:
    "Additional source annotations extracted by a separate native fixture provider.",
  subjectKind: "call",
});
