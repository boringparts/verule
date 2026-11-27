import type { BaseSQLiteDatabase } from "drizzle-orm/sqlite-core";

import type * as schema from "./schema.js";

export { eq } from "drizzle-orm";
export declare const db: BaseSQLiteDatabase<"async", unknown, typeof schema>;
