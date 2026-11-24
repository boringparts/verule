export function validate(
  raw: string,
): { ok: true; data: string } | { ok: false } {
  const trimmed = raw.trim();
  return trimmed ? { ok: true, data: trimmed } : { ok: false };
}

export function sink(_v: string): void {}

export function badRoute(raw: string): void {
  const parsed = validate(raw);
  if (!parsed.ok) return;
  sink(raw);
}

export function goodRoute(raw: string): void {
  const parsed = validate(raw);
  if (!parsed.ok) return;
  sink(parsed.data);
}
