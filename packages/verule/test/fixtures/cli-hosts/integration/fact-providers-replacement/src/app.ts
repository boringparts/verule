declare function parseWithAlpha(input: unknown): unknown;
declare function parseWithBeta(input: unknown): unknown;
export function submitAlpha(input: unknown) {
  return parseWithAlpha(input);
}
export function submitBeta(input: unknown) {
  return parseWithBeta(input);
}
