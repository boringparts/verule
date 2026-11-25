import { forwardBridge } from "./bridge.js";

function makeSecret(): string {
  return "secret";
}

export function execute(
  useDynamic: boolean,
  cb: (v: string) => string,
): string {
  const secret = makeSecret();
  const delivered = forwardBridge("alpha", secret);
  if (useDynamic) {
    return cb(secret);
  }
  return delivered;
}
