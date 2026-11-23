import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { createSelectSchema } from "drizzle-orm/zod";
import { z } from "zod";

export const users = sqliteTable("users", {
  id: integer("id").primaryKey(),
  fullName: text("full_name").notNull(),
  age: integer("age").notNull(),
  status: text("status").notNull(),
});

export const strictUserSchema = createSelectSchema(users);
export const userSchema = strictUserSchema.extend({
  age: z.number().default(18),
});
