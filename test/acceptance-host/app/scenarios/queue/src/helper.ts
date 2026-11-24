export function invokeSafely(fn: () => void): void {
  try {
    fn();
  } catch {
    // Handled inside helper wrapper.
  }
}
