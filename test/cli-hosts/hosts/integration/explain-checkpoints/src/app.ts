function sink(value: string | number): string {
  return String(value);
}
export function handle(input: string | number): string {
  if (typeof input === "string") {
    return sink(input);
  }
  return sink(input);
}
