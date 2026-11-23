export type Product = {
  readonly id: string;
  readonly name: string;
  readonly price: number;
};

export function findProduct(id: string): Product {
  return { id, name: `Product ${id}`, price: 29.95 };
}

export function getCachedProduct(id: string): Product {
  return { id, name: `Cached product ${id}`, price: 29.95 };
}
