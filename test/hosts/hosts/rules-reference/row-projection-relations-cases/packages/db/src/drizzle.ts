export type Column<T = unknown> = {
  readonly _type: T;
  notNull: () => Column<T>;
  primaryKey: () => Column<T>;
  default: (v: T) => Column<T>;
};
declare const col: Column<any>;
export const integer = (_name?: string) => col;
export const text = (_name?: string) => col;
export function sqliteTable<Cols extends Record<string, unknown>>(
  _name: string,
  cols: Cols,
): Cols {
  return cols;
}
export function relations<T>(
  _table: T,
  _cb: (h: { one: any; many: any }) => Record<string, unknown>,
) {
  return {};
}
export function eq(_a: unknown, _b: unknown) {
  return {};
}
export type SelectChain = {
  from: (t: unknown) => SelectChain;
  where: (c: unknown) => SelectChain;
  get: () => Promise<Record<string, unknown> | undefined>;
};
export type RelQuery = {
  findFirst: (
    opts?: Record<string, unknown>,
  ) => Promise<Record<string, unknown> | undefined>;
};
export declare const db: {
  select: (fields?: Record<string, unknown>) => SelectChain;
  query: Record<string, RelQuery>;
};
