import { getCachedMember, type Member } from "@verule/acceptance-host-data";

export function reviewCachedMember(
  id: string,
  invoke: (member: Member) => void,
): void {
  const member = getCachedMember(id);
  invoke(member);
}
