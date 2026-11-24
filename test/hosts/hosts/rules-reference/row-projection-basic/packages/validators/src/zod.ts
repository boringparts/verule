export type ZodAnyType = {
  optional: () => ZodAnyType;
  nullish: () => ZodAnyType;
  nullable: () => ZodAnyType;
  default: (v: unknown) => ZodAnyType;
  prefault: (v: unknown) => ZodAnyType;
  catch: (v: unknown) => ZodAnyType;
  transform: (fn: (v: never) => unknown) => ZodAnyType;
  extend: (shape: Record<string, unknown>) => ZodAnyType;
  pick: (mask: Record<string, boolean>) => ZodAnyType;
  parse: (v: unknown) => unknown;
  safeParse: (v: unknown) => { success: boolean; data?: unknown };
};
declare const node: ZodAnyType;
export const z = {
  string: () => node,
  number: () => node,
  enum: (_values: readonly string[]) => node,
  object: (_shape: Record<string, unknown>) => node,
};
