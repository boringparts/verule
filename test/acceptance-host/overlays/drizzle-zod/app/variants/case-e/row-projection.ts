import {
  extendReResolvedSchema,
  extendUnknownSchema,
  getUserWithStatusNoAge,
} from "@verule/acceptance-host-drizzle-zod-data";

export async function checkExtendUnknownOverrides() {
  const missingOnlyAge = await getUserWithStatusNoAge();
  if (missingOnlyAge === undefined) return undefined;
  return {
    unknownExtend: extendUnknownSchema.parse(missingOnlyAge),
    reResolvedExtend: extendReResolvedSchema.parse(missingOnlyAge),
  };
}
