import {
  andDefaultedSchema,
  andRequiredSchema,
  getUserWithStatusNoAge,
  modifierDefaultedSchema,
  pipeOverriddenSchema,
} from "@verule/acceptance-host-drizzle-zod-data";

export async function checkCombinatorOverrides() {
  const missingOnlyAge = await getUserWithStatusNoAge();
  if (missingOnlyAge === undefined) return undefined;
  return {
    mod: modifierDefaultedSchema.parse(missingOnlyAge),
    andDef: andDefaultedSchema.parse(missingOnlyAge),
    andReq: andRequiredSchema.parse(missingOnlyAge),
    pipe: pipeOverriddenSchema.parse(missingOnlyAge),
  };
}
