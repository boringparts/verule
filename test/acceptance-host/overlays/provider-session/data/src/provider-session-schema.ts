import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const sessionItems = sqliteTable("session_items", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
});
