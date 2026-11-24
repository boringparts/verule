import { z } from "./zod.js";

export const userAgeSchema = z.object({
  id: z.number(),
  age: z.number(),
});
