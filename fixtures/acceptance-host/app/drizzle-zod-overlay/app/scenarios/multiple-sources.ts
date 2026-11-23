import {
  getUserBriefAgain,
  getUserWithoutAge,
  strictUserSchema,
} from "@verule/acceptance-host-data";

export async function parseEitherUser(useFirst: boolean) {
  const candidate = useFirst
    ? await getUserBriefAgain()
    : await getUserWithoutAge();
  return candidate === undefined
    ? undefined
    : strictUserSchema.parse(candidate);
}
