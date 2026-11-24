import {
  getUserWithStatusNoAge,
  runtimeAgeSchema,
} from "@verule/acceptance-host-drizzle-zod-data";

export async function checkOverriddenRuntimeValidator() {
  const missingOnlyAge = await getUserWithStatusNoAge();
  return {
    overridden:
      missingOnlyAge === undefined
        ? undefined
        : runtimeAgeSchema.parse(missingOnlyAge),
  };
}
