import {
  getUserBriefAgain,
  getUserWithStatusNoAge,
  runtimeAgeSchema,
} from "@verule/acceptance-host-drizzle-zod-data";

export async function checkRuntimeValidators() {
  const missingStatusAndAge = await getUserBriefAgain();
  const missingOnlyAge = await getUserWithStatusNoAge();
  return {
    missingStaticCol:
      missingStatusAndAge === undefined
        ? undefined
        : runtimeAgeSchema.parse(missingStatusAndAge),
    onlyUnknownCol:
      missingOnlyAge === undefined
        ? undefined
        : runtimeAgeSchema.parse(missingOnlyAge),
  };
}
