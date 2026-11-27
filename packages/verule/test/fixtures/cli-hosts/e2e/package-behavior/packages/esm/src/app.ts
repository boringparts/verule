import { forwardValue } from "@ws/shared-pkg";

export function run() {
  const x = { a: 1 };
  const y = forwardValue(x);
  return y;
}
