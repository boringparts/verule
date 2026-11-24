import { fetchUserBrief, fetchUserFull } from "@fixture/db";
import { defaultedAgeSchema, strictUserSchema } from "@fixture/validators";

export async function handleRequests(userId: number, externalPayload: unknown) {
  const brief = await fetchUserBrief(userId);
  const full = await fetchUserFull(userId);

  // (a) Missing age -> MUST report here with evidence to packages/db and packages/validators
  const invalid = brief ? strictUserSchema.parse(brief) : null;
  // (b) Complete row -> MUST pass
  const valid = full ? strictUserSchema.parse(full) : null;
  // (c) Defaulted/prefaulted age -> MUST pass
  const defaulted = brief ? defaultedAgeSchema.parse(brief) : null;
  // Unrelated input not originating from Drizzle query -> MUST NOT report
  const unrelated = strictUserSchema.parse(externalPayload);

  return { invalid, valid, defaulted, unrelated };
}
