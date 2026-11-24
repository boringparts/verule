import { relations } from "drizzle-orm";
import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const workspace = sqliteTable("workspace", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull(),
  name: text("name"),
});

export const page = sqliteTable("page", {
  id: integer("id").primaryKey(),
  workspaceId: integer("workspace_id").notNull(),
  slug: text("slug").notNull(),
  customDomain: text("custom_domain"),
});

export const pageRelations = relations(page, ({ one }) => ({
  workspace: one(workspace),
}));
