import { adaptValue } from "@ws/shared-pkg";
import { opaqueExternal } from "ext-pkg";

export function run() {
  const x = { a: 1 };
  const y = adaptValue(x);
  const z = opaqueExternal(x);
  return { y, z };
}
