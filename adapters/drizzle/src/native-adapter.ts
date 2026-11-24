import {
  defineAdapter,
  defineFactProvider,
  type LibraryAdapter,
} from "@verule/sdk";

import { DrizzleTableColumnsFact, QueryRowProjectionFact } from "./facts.ts";

/** Bridges public Drizzle table and query facts to the Rust adapter loaded from this package. */
export const drizzleAdapter: LibraryAdapter = defineAdapter({
  id: "drizzle",
  version: "0.0.0",
  description:
    "Rust Drizzle ORM table column and query row projection extractor.",
  provides: [
    defineFactProvider(QueryRowProjectionFact, (context, request) =>
      context.extractEngineFacts({
        factTypeId: request.factType.id,
        providerId: "drizzle",
        ...(request.targets !== undefined ? { targets: request.targets } : {}),
        ...(request.condition !== undefined
          ? { condition: request.condition }
          : {}),
      }),
    ),
    defineFactProvider(DrizzleTableColumnsFact, (context, request) =>
      context.extractEngineFacts({
        factTypeId: request.factType.id,
        providerId: "drizzle",
        ...(request.targets !== undefined ? { targets: request.targets } : {}),
        ...(request.condition !== undefined
          ? { condition: request.condition }
          : {}),
      }),
    ),
  ],
});

export default drizzleAdapter;
