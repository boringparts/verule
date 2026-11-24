import { adaptValue } from "dual-pkg";

export function run() {
  const x = { a: 1 };
  const y = adaptValue(x);
  return y;
}
