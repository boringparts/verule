import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  copyDirectory,
  type LineEnding,
  linkNodeModulesPackage,
  type PreparedTempHost,
  prepareTempHost,
  resolveCheckedHostDir,
  type SyntheticPackageSpec,
  withPreparedTempHost,
  writeHostFiles,
  writeSyntheticPackage,
} from "@verule/test-hosts";

const cliHostsRootDir = fileURLToPath(new URL("../hosts", import.meta.url));
const require = createRequire(import.meta.url);

export type { LineEnding, PreparedTempHost, SyntheticPackageSpec };

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

function resolvePackageRootDir(entryFilePath: string): string {
  let currentDir = dirname(entryFilePath);
  while (true) {
    if (existsSync(join(currentDir, "package.json"))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not locate package.json above ${entryFilePath}`);
    }
    currentDir = parentDir;
  }
}

function resolveDefaultSdkPackageDir(): string {
  return resolvePackageRootDir(require.resolve("@verule/sdk"));
}

/**
 * Resolves a checked CLI host directory under `@verule/cli-hosts/hosts/`.
 */
export function resolveCliHostDir(hostName: string): string {
  return resolveCheckedHostDir(cliHostsRootDir, hostName);
}

/**
 * Materializes checked CLI hosts from `@verule/cli-hosts/hosts/`, applies
 * overlays, links `@verule/sdk` (workspace by default or `sdkPackageDir`),
 * and wraps `@verule/test-hosts` lifecycle and LIFO cleanup.
 */
export function prepareCliTempHost(
  options: PrepareCliTempHostOptions = {},
): Promise<PreparedTempHost> {
  const selectedHosts = [
    ...(options.host === undefined ? [] : [options.host]),
    ...(options.hosts ?? []),
  ];
  const packageLinks: Record<string, string> = {
    ...options.packageLinks,
  };
  if (options.linkSdk !== false) {
    packageLinks["@verule/sdk"] =
      options.sdkPackageDir ??
      packageLinks["@verule/sdk"] ??
      resolveDefaultSdkPackageDir();
  }

  return prepareTempHost({
    ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
    prefix: options.prefix ?? "verule-cli-host-",
    setup: async (host) => {
      for (const hostName of selectedHosts) {
        copyDirectory(
          resolveCliHostDir(hostName),
          host.rootDir,
          options.lineEnding === undefined
            ? {}
            : { lineEnding: options.lineEnding },
        );
      }

      if (options.files !== undefined) {
        writeHostFiles(host.rootDir, options.files, options.lineEnding);
      }

      for (const [packageName, targetDir] of Object.entries(packageLinks)) {
        linkNodeModulesPackage(host.rootDir, packageName, targetDir);
      }

      for (const [packageName, spec] of Object.entries(
        options.syntheticPackages ?? {},
      )) {
        writeSyntheticPackage(
          host.rootDir,
          packageName,
          spec,
          options.lineEnding,
        );
      }

      if (options.setup !== undefined) {
        await options.setup(host);
      }
    },
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
