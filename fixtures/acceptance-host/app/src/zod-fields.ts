import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";

import { userTable } from "@verule/acceptance-host-data";

declare function generatedAccountFields(): Record<string, z.ZodType>;

const dynamicFieldName: string = Math.random() > 0.5 ? "first" : "second";

export const accountSchema = z
  .object({
    id: z.number(),
    nullableName: z.string().nullable(),
    nickname: z.string().optional(),
    state: z.string().prefault("active"),
    fallback: z.string().catch("unknown"),
    ...generatedAccountFields(),
    [dynamicFieldName]: z.string(),
  })
  .transform((account) => ({ ...account }));

export const userSchema = createSelectSchema(userTable).extend({
  age: z.number().default(18),
});

export function parseZodFields(input: unknown) {
  return {
    account: accountSchema.safeParse(input),
    user: userSchema.parse(input),
  };
}
