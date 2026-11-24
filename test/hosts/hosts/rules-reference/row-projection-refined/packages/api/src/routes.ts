import {
  defaultedAgeSchema,
  fetchUserBrief,
  unknownAgeSchema,
} from "@fixture/db";

export async function checkRefined(userId: number) {
  const brief = await fetchUserBrief(userId);
  if (!brief) return null;
  const withGap = unknownAgeSchema.parse(brief);
  const resolved = defaultedAgeSchema.parse(brief);
  return { withGap, resolved };
}
