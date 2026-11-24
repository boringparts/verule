import dual = require("dual-pkg");

export function runCjs(): void {
  const tok = { id: "cjs" };
  const out = dual.forwardOrClone(tok);
  void out;
}
