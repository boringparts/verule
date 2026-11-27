export function forwardValue<T extends object>(x: T): T {
  return x;
}

export function adaptValue<T extends object>(x: T): T {
  return { ...x };
}
