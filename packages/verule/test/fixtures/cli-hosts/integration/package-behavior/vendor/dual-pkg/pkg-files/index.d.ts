export interface SessionToken {
  readonly id: string;
}
export declare function forwardOrClone<T extends SessionToken>(token: T): T;
export declare function modeledFactory<T extends SessionToken>(token: T): T;
