import { forwardOrClone, modeledFactory, type SessionToken } from "dual-pkg";

export function runEsm(): void {
  const tok: SessionToken = { id: "esm" };
  const out = forwardOrClone(tok);
  const mod = modeledFactory(tok);
  void [out, mod];
}
