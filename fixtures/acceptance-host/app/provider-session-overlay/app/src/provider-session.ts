import { findProduct as getProduct } from "@verule/acceptance-host-data";

export function inspectProduct(id: string) {
  return getProduct(id);
}
