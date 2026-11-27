export interface SessionToken {
  readonly id: string;
}

export function forwardToken<T extends SessionToken>(token: T): T {
  return token;
}

export function cloneToken<T extends SessionToken>(token: T): T {
  return { ...token };
}
