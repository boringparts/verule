import { db, eq } from "./drizzle.js";
import { users } from "./schema.js";

export async function fetchUserBrief(userId: number) {
  return await db
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(eq(users.id, userId))
    .get();
}

export async function fetchUserFull(userId: number) {
  return await db
    .select({ id: users.id, name: users.name, age: users.age })
    .from(users)
    .where(eq(users.id, userId))
    .get();
}
