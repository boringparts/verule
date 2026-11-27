declare function hasApiKey(req: string): boolean;
declare function hasSession(req: string): boolean;
declare function verifyApiKey(req: string): void;
declare function verifySession(req: string): void;
declare function runAction(req: string): void;

export function jointCoveredHandler(req: string): void {
  if (hasApiKey(req)) {
    verifyApiKey(req);
  } else if (hasSession(req)) {
    verifySession(req);
  } else {
    return;
  }
  runAction(req);
}
