export function defineFixtureSource(
  name: string,
  fields: Readonly<Record<string, "required" | "optional" | "defaulted">>,
): {
  readonly name: string;
  readonly fields: Readonly<
    Record<string, "required" | "optional" | "defaulted">
  >;
} {
  return { name, fields };
}

export const sessionOrderSource = defineFixtureSource("order", {
  orderId: "required",
  couponCode: "optional",
});
