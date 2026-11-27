declare function hasApiKey(req: string): boolean;
declare function hasSession(req: string): boolean;
declare function verifyApiKey(req: string): void;
declare function verifySession(req: string): void;
declare function audit(req: string): void;
declare function runAction(req: string): void;

export function bypassHandler(req: string): void {
  if (hasApiKey(req)) {
    audit(req);
  }
  runAction(req);
}

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

export function unreachableHandler(req: string): void {
  if (hasApiKey(req)) {
    verifyApiKey(req);
  }
  return;
  // oxlint-disable-next-line no-unreachable
  runAction(req);
}
