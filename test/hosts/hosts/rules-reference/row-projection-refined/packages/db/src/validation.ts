import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { users } from "./schema.js";

declare function runtimeAgeValidator(): z.ZodType<number>;

export const unknownAgeSchema = createSelectSchema(users, {
  age: runtimeAgeValidator(),
});

export const defaultedAgeSchema = createSelectSchema(users, {
  age: runtimeAgeValidator(),
}).extend({
  age: z.number().default(18),
});
