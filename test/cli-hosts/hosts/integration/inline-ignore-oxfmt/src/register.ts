declare function register(name: string): string;

export const list = [
  // verule-ignore-next-code-line no-legacy-register -- Old host id.
  register("old"),
  register("new"),
];
