import {
  findProduct as getProduct,
  getCachedProduct,
  type Product,
} from "@verule/acceptance-host-data";

function findProduct(id: string): Product {
  return { id, name: `Local product ${id}`, price: 1 };
}

export function reviewProduct(
  id: string,
  invoke: (product: Product) => void,
): void {
  const product = getProduct(id);
  if (product.price <= 0 || product.id !== id) {
    invoke(product);
  }
}

export function reviewLocalProduct(
  id: string,
  invoke: (product: Product) => void,
): void {
  const product = findProduct(id);
  if (product.price <= 0) {
    invoke(product);
  }
}

export function reviewCachedProduct(
  id: string,
  invoke: (product: Product) => void,
): void {
  const product = getCachedProduct(id);
  invoke(product);
}

export function keepLegacyProduct(invoke: (product: Product) => void): void {
  // verule-ignore-next-code-line neutral-product-review -- Keep this legacy lookup covered during migration.
  const product = getProduct("legacy");
  if (product.price <= 0) {
    invoke(product);
  }
}
