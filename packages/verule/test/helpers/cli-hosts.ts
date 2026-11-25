import { fileURLToPath } from "node:url";

import {
  type LineEnding,
  type PreparedTempHost,
  prepareTempHost,
  resolveCheckedHostDir,
  type SyntheticPackageSpec,
  withPreparedTempHost,
} from "@verule/test-hosts";

const cliHostsRootDir = fileURLToPath(
  new URL("../fixtures/cli-hosts", import.meta.url),
);
const packageRootDir = fileURLToPath(new URL("../..", import.meta.url));

export type { LineEnding, PreparedTempHost, SyntheticPackageSpec };
export {
  spawnNdjsonProcess,
  type NdjsonProcessSession,
  type NdjsonRecord,
  type SpawnNdjsonProcessOptions,
} from "./ndjson-process.ts";

export type PrepareCliTempHostOptions = {
  readonly host?: string;
  readonly hosts?: readonly string[];
  readonly files?: Readonly<Record<string, string | Uint8Array>>;
  readonly lineEnding?: LineEnding;
  readonly linkSdk?: boolean;
  readonly sdkPackageDir?: string;
  readonly packageLinks?: Readonly<Record<string, string>>;
  readonly syntheticPackages?: Readonly<Record<string, SyntheticPackageSpec>>;
  readonly tempRoot?: string;
  readonly prefix?: string;
  readonly setup?: (host: PreparedTempHost) => Promise<void> | void;
};

function resolveDefaultSdkPackageDir(): string {
  return packageRootDir;
}

/**
 * Resolves a checked CLI host directory under `test/fixtures/cli-hosts/`.
 */
export function resolveCliHostDir(hostName: string): string {
  return resolveCheckedHostDir(cliHostsRootDir, hostName);
}

/**
 * Materializes checked CLI hosts from `test/fixtures/cli-hosts/`, applies
 * overlays, links `@boringparts/verule` (workspace by default or `sdkPackageDir`),
 * and wraps `@verule/test-hosts` lifecycle and LIFO cleanup.
 */
export function prepareCliTempHost(
  options: PrepareCliTempHostOptions = {},
): Promise<PreparedTempHost> {
  const selectedHostDirs = [
    ...(options.host === undefined ? [] : [options.host]),
    ...(options.hosts ?? []),
  ].map(resolveCliHostDir);
  const packageLinks: Record<string, string> = {
    ...options.packageLinks,
  };
  if (options.linkSdk !== false) {
    packageLinks["@boringparts/verule"] =
      options.sdkPackageDir ??
      packageLinks["@boringparts/verule"] ??
      resolveDefaultSdkPackageDir();
  }

  return prepareTempHost({
    ...(selectedHostDirs.length === 0 ? {} : { hostDirs: selectedHostDirs }),
    ...(options.files === undefined ? {} : { files: options.files }),
    ...(options.lineEnding === undefined
      ? {}
      : { lineEnding: options.lineEnding }),
    packageLinks,
    ...(options.syntheticPackages === undefined
      ? {}
      : { syntheticPackages: options.syntheticPackages }),
    ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
    prefix: options.prefix ?? "verule-cli-host-",
    ...(options.setup === undefined ? {} : { setup: options.setup }),
  });
}

/**
 * Prepares a temporary CLI host, passes it to `callback`, and always disposes
 * registered resources in LIFO order while preserving any callback error.
 */
export function withCliTempHost<T>(
  options: PrepareCliTempHostOptions,
  callback: (host: PreparedTempHost) => Promise<T> | T,
): Promise<T> {
  return withPreparedTempHost(() => prepareCliTempHost(options), callback);
}
