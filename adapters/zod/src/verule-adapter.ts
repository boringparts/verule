import { defineAdapter, defineFactProvider } from "@verule/sdk";

import {
  ValidatorFieldFact,
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
} from "./facts.ts";

/** JavaScript query bridge loaded by the package's native adapter entry. */
const zodAdapter = defineAdapter({
  id: "zod",
  version: "0.0.0",
  description: "Static Zod schema and validator field extractor.",
  provides: [
    defineFactProvider(ValidatorInputFieldsFact, (ctx, request) =>
      ctx.extractEngineFacts({
        factTypeId: request.factType.id,
        providerId: "zod",
        reportProviderId: "zod",
        ...(request.targets !== undefined ? { targets: request.targets } : {}),
        ...(request.condition !== undefined
          ? { condition: request.condition }
          : {}),
      }),
    ),
    defineFactProvider(ValidatorOutputFieldsFact, (ctx, request) =>
      ctx.extractEngineFacts({
        factTypeId: request.factType.id,
        providerId: "zod",
        reportProviderId: "zod",
        ...(request.targets !== undefined ? { targets: request.targets } : {}),
        ...(request.condition !== undefined
          ? { condition: request.condition }
          : {}),
      }),
    ),
    defineFactProvider(ValidatorFieldFact, (ctx, request) =>
      ctx.extractEngineFacts({
        factTypeId: request.factType.id,
        providerId: "zod",
        reportProviderId: "zod",
        ...(request.targets !== undefined ? { targets: request.targets } : {}),
      }),
    ),
  ],
});

export default zodAdapter;
