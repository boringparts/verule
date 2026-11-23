export type Member = {
  readonly id: string;
  readonly displayName: string;
};

export function getMember(id: string): Member {
  return { id, displayName: id };
}

export function getCachedMember(id: string): Member {
  return { id, displayName: id };
}
