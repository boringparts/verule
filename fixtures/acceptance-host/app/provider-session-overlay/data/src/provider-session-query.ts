import type { SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";

import { sessionItems } from "./provider-session-schema.ts";
import * as schema from "./provider-session-schema.ts";

declare const db: SqliteRemoteDatabase<typeof schema>;

export function findSessionItem(id: string) {
  return db
    .select({ id: sessionItems.id, title: sessionItems.title })
    .from(sessionItems)
    .get();
}
