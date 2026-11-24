import dual = require("dual-pkg");

export function run() {
  const x = { a: 1 };
  const y = dual.adaptValue(x);
  return y;
}
