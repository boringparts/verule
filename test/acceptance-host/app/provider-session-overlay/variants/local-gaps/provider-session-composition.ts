import { sessionOrderSource } from "./provider-session-source.ts";

export function consumeFixtureSource(
  source: unknown,
  overrides?: Readonly<Record<string, "required" | "optional" | "defaulted">>,
) {
  return { source, overrides };
}

export function unrelatedHelper(value: string): string {
  return value;
}

export const rawOrderConsumer = consumeFixtureSource(sessionOrderSource);

export const sessionOrderConsumer = consumeFixtureSource(sessionOrderSource, {
  couponCode: "defaulted",
});

export const unrelatedCall = unrelatedHelper("keep");
