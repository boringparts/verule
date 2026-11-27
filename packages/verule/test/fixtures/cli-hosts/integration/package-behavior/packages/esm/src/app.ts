import { cloneToken, forwardToken, type SessionToken } from "@ws/shared-pkg";
import { opaqueExternal } from "ext-pkg";

export function runEsm(): void {
  const tok: SessionToken = { id: "esm" };
  const forwarded = forwardToken(tok);
  const cloned = cloneToken(tok);
  const untracked = opaqueExternal(tok);
  void [forwarded, cloned, untracked];
}
