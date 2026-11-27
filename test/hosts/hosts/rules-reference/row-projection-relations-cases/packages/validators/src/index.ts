import { z } from "zod";

export const pageSlugSchema = z.object({
  slug: z.string(),
});
export const dynSchema = z.object({
  id: z.number(),
  slug: z.string(),
});
