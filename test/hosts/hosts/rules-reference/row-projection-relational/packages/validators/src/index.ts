import { z } from "zod";

export const userAgeSchema = z.object({
  id: z.number(),
  age: z.number(),
});
