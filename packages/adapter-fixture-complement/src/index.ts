import {
  defineAdapter,
  defineFactProvider,
  type LibraryAdapter,
} from "@verule/sdk";

import { FixtureCallSourceFact } from "./facts.ts";

export {
  FixtureCallSourceFact,
  type FixtureComplementCondition,
  type FixtureComplementValue,
} from "./facts.ts";

/** Creates the JavaScript bridge for the independent complementary Rust adapter. */
export function createFixtureComplementAdapter(
  id = "third-party-fixture-complement",
): LibraryAdapter {
  return defineAdapter({
    id,
    version: "1.0.0",
    description:
      "Independent native provider that adds source annotations to fixture call facts.",
    provides: [
      defineFactProvider(FixtureCallSourceFact, (ctx, request) =>
        ctx.extractEngineFacts({
          factTypeId: request.factType.id,
          providerId: "third-party-fixture-complement",
          reportProviderId: id,
          ...(request.targets !== undefined
            ? { targets: request.targets }
            : {}),
          ...(request.condition !== undefined
            ? { condition: request.condition }
            : {}),
        }),
      ),
    ],
  });
}

/** Default bridge selected when the package is listed in `defineConfig.adapters`. */
export const fixtureComplementAdapter = createFixtureComplementAdapter();

export default fixtureComplementAdapter;
