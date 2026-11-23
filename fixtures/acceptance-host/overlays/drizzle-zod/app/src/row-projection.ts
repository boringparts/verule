import {
  getCompleteUser,
  getCompleteUserAgain,
  getDynamicUser,
  getUserBrief,
  userSchema,
} from "@verule/acceptance-host-drizzle-zod-data";

export async function checkUserRows() {
  const complete = await getCompleteUser();
  const completeAgain = await getCompleteUserAgain();
  const brief = await getUserBrief();
  const dynamic = await getDynamicUser();

  return {
    complete: complete === undefined ? undefined : userSchema.parse(complete),
    completeAgain:
      completeAgain === undefined ? undefined : userSchema.parse(completeAgain),
    defaulted: brief === undefined ? undefined : userSchema.parse(brief),
    dynamic: dynamic === undefined ? undefined : userSchema.parse(dynamic),
  };
}
