declare function danger(tag: string): void;

export function execute(): void {
  // verule-ignore-next-code-line no-danger -- Approved legacy entry.
  danger("ok");
}
