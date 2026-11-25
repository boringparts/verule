declare function hasApiKey(req: string): boolean;
declare function hasSession(req: string): boolean;
declare function verifyApiKey(req: string): void;
declare function verifySession(req: string): void;
declare function log(err: unknown): void;
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

export function unmodeledHandler(req: string): void {
  try {
    if (hasApiKey(req)) {
      runAction(req);
    }
  } catch (err) {
    log(err);
  }
}
