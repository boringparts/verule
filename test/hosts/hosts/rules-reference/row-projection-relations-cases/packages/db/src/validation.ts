import { createSelectSchema } from "drizzle-zod";

import { page, workspace } from "./schema.js";

export const selectWorkspaceSchema = createSelectSchema(workspace);
export const selectPageSchema = createSelectSchema(page);
