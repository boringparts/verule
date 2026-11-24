import { integer, sqliteTable, text } from "./drizzle.js";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  name: text("name").notNull(),
  age: integer("age").notNull(),
});
