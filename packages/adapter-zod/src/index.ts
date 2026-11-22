import {
  defineAdapter,
  defineFactProvider,
  type LibraryAdapter,
} from "@verule/sdk";

import {
  extractZodInputFieldFacts,
  extractZodOutputFieldFacts,
} from "./extractor.ts";
import {
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
} from "./facts.ts";

export {
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
  type ValidatorFieldsCondition,
  type ValidatorInputFieldInfo,
  type ValidatorInputFieldRequirement,
  type ValidatorInputFieldsFactValue,
  type ValidatorMethodName,
  type ValidatorOutputFieldInfo,
  type ValidatorOutputFieldPresence,
  type ValidatorOutputFieldsFactValue,
  type ValidatorSiteKind,
  type ValidatorSubjectKind,
} from "./facts.ts";

export type CreateZodAdapterOptions = {
  readonly id?: string;
  readonly onExtract?: (info: {
    readonly factTypeId: string;
    readonly projectId: string;
  }) => void;
};

/** Creates a Zod library adapter instance with an optional extraction observer hook. */
export function createZodAdapter(
  options: CreateZodAdapterOptions = {},
): LibraryAdapter {
  const id = options.id ?? "zod";
  return defineAdapter({
    id,
    version: "0.0.0",
    description: "Static Zod schema and validator field extractor.",
    provides: [
      defineFactProvider(ValidatorInputFieldsFact, (ctx, request) => {
        options.onExtract?.({
          factTypeId: request.factType.id,
          projectId: ctx.project.projectId,
        });
        return extractZodInputFieldFacts(ctx, request);
      }),
      defineFactProvider(ValidatorOutputFieldsFact, (ctx, request) => {
        options.onExtract?.({
          factTypeId: request.factType.id,
          projectId: ctx.project.projectId,
        });
        return extractZodOutputFieldFacts(ctx, request);
      }),
    ],
  });
}

/** Default `@verule/adapter-zod` instance (`id: "zod"`). */
export const zodAdapter: LibraryAdapter = createZodAdapter();
