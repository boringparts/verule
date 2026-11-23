import { getCachedProduct, type Product } from "@verule/acceptance-host-data";

export function reviewCachedProduct(
  id: string,
  invoke: (product: Product) => void,
): void {
  const product = getCachedProduct(id);
  invoke(product);
}
