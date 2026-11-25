export type CliCommandIdentity = {
  readonly commandName: string;
  readonly version: string;
};

/**
 * Resolves the single executable command name and display version from a CLI package manifest.
 *
 * Throws if `bin` does not declare exactly one command; defaults missing `version` to `"unpublished"`.
 */
export function cliCommandIdentity(manifest: {
  readonly bin: Readonly<Record<string, string>>;
  readonly version?: string;
}): CliCommandIdentity {
  const names = Object.keys(manifest.bin);
  if (names.length !== 1) {
    throw new Error("CLI package must declare exactly one command in bin.");
  }
  return {
    commandName: names[0]!,
    version: manifest.version ?? "unpublished",
  };
}
