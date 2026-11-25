import { forwardBridge } from "./bridge.js";

function makeOrigin(): string {
  return "origin";
}

export function main(useDyn: boolean, cb: (x: string) => string): string {
  const origin = makeOrigin();
  const out = forwardBridge("alpha", origin);
  if (useDyn) return cb(origin);
  return out;
}
