import { orderSpec } from "./source.js";

export function useSpec(spec: unknown, overrides?: Record<string, string>) {
  return { spec, overrides };
}
export const rawConsumer = useSpec(orderSpec);
export const overriddenConsumer = useSpec(orderSpec, {
  couponCode: "defaulted",
});
