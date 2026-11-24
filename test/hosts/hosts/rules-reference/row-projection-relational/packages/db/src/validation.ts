import { createSelectSchema } from "drizzle-zod";
import { z } from "zod";

import { page, workspace } from "./schema.js";

export const selectWorkspaceSchema = createSelectSchema(workspace)
  .extend({
    plan: z.enum(["free", "pro"]).nullable().prefault("free"),
    usage: z.object({ count: z.number() }).nullish(),
  })
  .transform((v: Record<string, unknown>) => ({ ...v }));

export const selectPageSchema = createSelectSchema(page).extend({
  password: z.string().nullable().prefault(""),
});
