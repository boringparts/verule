import { defineFactType } from "@verule/sdk";

export type FixtureCallSourceValue = {
  readonly text: string;
  readonly input: string;
  readonly invocation: number;
};

export const FixtureCallSourceFact = defineFactType<
  "call",
  undefined,
  FixtureCallSourceValue
>({
  id: "fixture.call-source",
  description:
    "Source text extracted by an independently built native adapter.",
  subjectKind: "call",
});
