import {
  defineAdapter,
  defineFactProvider,
  type LibraryAdapter,
} from "@verule/sdk";

import { extractDrizzleRowProjectionFacts } from "./extractor.ts";
import { QueryRowProjectionFact } from "./facts.ts";

export {
  QueryRowProjectionFact,
  buildQueryRowProjectionValue,
  type QueryRowCardinality,
  type QueryRowColumnInfo,
  type QueryRowColumnKind,
  type QueryRowKind,
  type QueryRowNestedRelationInfo,
  type QueryRowProjectionCondition,
  type QueryRowProjectionFactValue,
  type QueryRowSubjectKind,
} from "./facts.ts";

export type CreateDrizzleAdapterOptions = {
  readonly id?: string;
  readonly onExtract?: (info: {
    readonly factTypeId: string;
    readonly projectId: string;
  }) => void;
};

export type CreateRustDrizzleAdapterOptions = {
  readonly id?: string;
  readonly onExtract?: (info: {
    readonly factTypeId: string;
    readonly projectId: string;
  }) => void;
};

/** Creates a Drizzle ORM library adapter instance with an optional extraction observer hook. */
export function createDrizzleAdapter(
  options: CreateDrizzleAdapterOptions = {},
): LibraryAdapter {
  const id = options.id ?? "drizzle";
  return defineAdapter({
    id,
    version: "0.0.0",
    description: "Static Drizzle ORM query row projection extractor.",
    provides: [
      defineFactProvider(QueryRowProjectionFact, (ctx, request) => {
        options.onExtract?.({
          factTypeId: request.factType.id,
          projectId: ctx.project.projectId,
        });
        return extractDrizzleRowProjectionFacts(ctx, request);
      }),
    ],
  });
}

/**
 * Creates an engine-internal Rust Drizzle ORM library adapter (`id: "drizzle-rust"`)
 * implementing the same {@link QueryRowProjectionFact} contract on the active engine snapshot.
 */
export function createRustDrizzleAdapter(
  options: CreateRustDrizzleAdapterOptions = {},
): LibraryAdapter {
  const id = options.id ?? "drizzle-rust";
  return defineAdapter({
    id,
    version: "0.0.0",
    description:
      "Engine-internal Rust static Drizzle ORM query row projection extractor.",
    provides: [
      defineFactProvider(QueryRowProjectionFact, (ctx, request) => {
        options.onExtract?.({
          factTypeId: request.factType.id,
          projectId: ctx.project.projectId,
        });
        return ctx.extractEngineFacts({
          factTypeId: request.factType.id,
          providerId: "drizzle-rust",
          reportProviderId: id,
          ...(request.targets !== undefined
            ? { targets: request.targets }
            : {}),
          ...(request.condition !== undefined
            ? { condition: request.condition }
            : {}),
        });
      }),
    ],
  });
}

/** Default `@verule/adapter-drizzle` TS instance (`id: "drizzle"`). */
export const drizzleAdapter: LibraryAdapter = createDrizzleAdapter();

/** Engine-internal `@verule/adapter-drizzle` Rust instance (`id: "drizzle-rust"`). */
export const rustDrizzleAdapter: LibraryAdapter = createRustDrizzleAdapter();
