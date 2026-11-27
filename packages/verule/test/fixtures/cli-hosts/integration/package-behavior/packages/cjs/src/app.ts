import { cloneToken, forwardToken } from "@ws/shared-pkg";

export function runCjs(): void {
  const tok = { id: "cjs" };
  const forwarded = forwardToken(tok);
  const out = cloneToken(forwarded);
  void out;
}
