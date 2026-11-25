declare function parseInput(schema: unknown, payload: unknown): unknown;

const userSchema = {};

export function handle(payload: unknown): unknown {
  return parseInput(userSchema, payload);
}
