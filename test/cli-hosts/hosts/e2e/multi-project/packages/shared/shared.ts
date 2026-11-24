import { mode } from "@runtime";

function sink(v: string): string {
  return v;
}

export const out = sink(mode);
