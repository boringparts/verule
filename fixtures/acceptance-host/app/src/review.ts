import {
  getCachedMember,
  getMember,
  type Member,
} from "@verule/acceptance-host-data";

export function reviewMember(
  id: string,
  invoke: (member: Member) => void,
): void {
  const member = getMember(id);
  invoke(member);
}

export function reviewCachedMember(
  id: string,
  invoke: (member: Member) => void,
): void {
  const member = getCachedMember(id);
  invoke(member);
}

export function keepLegacyMember(invoke: (member: Member) => void): void {
  // verule-ignore-next-code-line neutral-member-review -- Keep this legacy lookup covered during migration.
  const member = getMember("legacy");
  invoke(member);
}
