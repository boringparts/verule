import {
  defineAdapter,
  defineFactProvider,
  type LibraryAdapter,
} from "@verule/sdk";

import { FixtureCallSourceFact } from "./facts.ts";

export { FixtureCallSourceFact, type FixtureCallSourceValue } from "./facts.ts";

/** Creates the JavaScript fact-provider bridge for the native test adapter. */
export function createFixtureAdapter(
  id = "third-party-fixture",
): LibraryAdapter {
  return defineAdapter({
    id,
    version: "1.0.0",
    description:
      "Independent native adapter fixture used to verify the public Rust API.",
    provides: [
      defineFactProvider(FixtureCallSourceFact, (ctx, request) =>
        ctx.extractEngineFacts({
          factTypeId: request.factType.id,
          providerId: "third-party-fixture",
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

/** Default bridge loaded when the package name is listed in `defineConfig`. */
export const fixtureAdapter = createFixtureAdapter();

export default fixtureAdapter;
