import { sessionOrderSource } from "./provider-session-source.ts";

export function consumeFixtureSource(
  source: unknown,
  overrides?: Readonly<Record<string, "required" | "optional" | "defaulted">>,
): {
  readonly source: unknown;
  readonly overrides:
    | Readonly<Record<string, "required" | "optional" | "defaulted">>
    | undefined;
} {
  return { source, overrides };
}

export const sessionOrderConsumer = consumeFixtureSource(sessionOrderSource, {
  couponCode: "defaulted",
});
