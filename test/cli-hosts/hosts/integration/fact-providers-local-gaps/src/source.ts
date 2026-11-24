export function defineSpec(name: string, fields: Record<string, string>) {
  return { name, fields };
}
declare function dynamicSpec(): string;
export const orderSpec = defineSpec("order", {
  orderId: "required",
  couponCode: dynamicSpec(),
});
