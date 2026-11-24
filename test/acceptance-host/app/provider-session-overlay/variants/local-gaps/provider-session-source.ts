export function defineFixtureSource(
  name: string,
  fields: Readonly<Record<string, "required" | "optional" | "defaulted">>,
) {
  return { name, fields };
}

declare function dynamicFieldSpec(): "required" | "optional" | "defaulted";

export const sessionOrderSource = defineFixtureSource("order", {
  orderId: "required",
  couponCode: dynamicFieldSpec(),
});
