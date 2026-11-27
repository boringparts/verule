import { z } from "zod";

export const strictUserSchema = z.object({
  id: z.number(),
  name: z.string(),
  age: z.number(),
});

export const defaultedAgeSchema = z.object({
  id: z.number(),
  name: z.string(),
  age: z.number().prefault(18),
});
