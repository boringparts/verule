import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import type { PackedArtifact } from "./artifacts.ts";
import { DEFAULT_DIRECT_VERULE_PACKAGES } from "./host-install.ts";
import { resolveDefaultBlockedPaths } from "./isolation.ts";

export type HostResolutionAudit = {
  readonly checkoutRealpath: string;
  readonly cliPackagePath: string;
  readonly cliVersion: string;
  readonly sdkResolvedPath: string;
  readonly engineModulePath: string;
  readonly engineBinaryPath: string;
  readonly engineBinarySha256: string;
  readonly resolvedDirectPackages: Readonly<Record<string, string>>;
  readonly auditedSymlinkCount: number;
  readonly workspaceSymlinkCount: number;
  readonly storeSymlinkCount: number;
};

export type VerifyHostResolutionOptions = {
  readonly checkoutDir: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly directPackages?: readonly string[];
  readonly blockedPaths?: readonly string[];
  readonly allowedStorePaths?: readonly string[];
};

function isInsideDirectory(
  candidatePath: string,
  directoryPath: string,
): boolean {
  return (
    candidatePath === directoryPath ||
    candidatePath.startsWith(directoryPath + sep)
  );
}

function collectAllowedStorePaths(
  checkoutDir: string,
  extraPaths: readonly string[] = [],
): readonly string[] {
  const paths = new Set<string>(extraPaths.map((item) => resolve(item)));
  if (existsSync("/pnpm/store")) {
    paths.add(realpathSync("/pnpm/store"));
  }
  try {
    const storePath = execFileSync("pnpm", ["store", "path"], {
      cwd: checkoutDir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (storePath.length > 0 && existsSync(storePath)) {
      paths.add(realpathSync(storePath));
    }
  } catch {
    // Ignore when pnpm store path is unavailable.
  }
  return [...paths];
}

function auditNodeModulesSymlinks(options: {
  readonly checkoutRealpath: string;
  readonly blockedPaths: readonly string[];
  readonly allowedStorePaths: readonly string[];
}): {
  readonly auditedSymlinkCount: number;
  readonly workspaceSymlinkCount: number;
  readonly storeSymlinkCount: number;
} {
  let auditedSymlinkCount = 0;
  let workspaceSymlinkCount = 0;
  let storeSymlinkCount = 0;

  function scanNodeModulesDir(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        auditedSymlinkCount += 1;
        let targetPath: string;
        try {
          targetPath = realpathSync(entryPath);
        } catch {
          targetPath = resolve(dirname(entryPath), readlinkSync(entryPath));
        }

        for (const blockedPath of options.blockedPaths) {
          if (isInsideDirectory(targetPath, blockedPath)) {
            throw new Error(
              `Symlink in host node_modules points into development repository: ${entryPath} -> ${targetPath}`,
            );
          }
        }

        if (isInsideDirectory(targetPath, options.checkoutRealpath)) {
          workspaceSymlinkCount += 1;
        } else if (
          options.allowedStorePaths.some((storePath) =>
            isInsideDirectory(targetPath, storePath),
          )
        ) {
          storeSymlinkCount += 1;
        } else {
          throw new Error(
            `Symlink in host node_modules resolves outside host checkout and package store: ${entryPath} -> ${targetPath}`,
          );
        }
      } else if (entry.isDirectory()) {
        scanNodeModulesDir(entryPath);
      }
    }
  }

  function findNodeModulesDirs(dir: string): void {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === ".git") {
        continue;
      }
      const entryPath = join(dir, entry.name);
      if (entry.name === "node_modules") {
        scanNodeModulesDir(entryPath);
      } else {
        findNodeModulesDirs(entryPath);
      }
    }
  }

  findNodeModulesDirs(options.checkoutRealpath);

  return {
    auditedSymlinkCount,
    workspaceSymlinkCount,
    storeSymlinkCount,
  };
}

/**
 * Verifies that `@verule/cli`, `@verule/sdk`, the transitive `@verule/engine`
 * binary, and any optional direct packages resolve inside the host checkout's
 * `node_modules` tree with matching artifact digests and zero symlinks back to
 * the development repository.
 */
export async function verifyHostArtifactResolution(
  options: VerifyHostResolutionOptions,
): Promise<HostResolutionAudit> {
  const checkoutRealpath = realpathSync(options.checkoutDir);
  const blockedPaths = (options.blockedPaths ?? resolveDefaultBlockedPaths())
    .filter((path) => existsSync(path))
    .map((path) => realpathSync(path));
  const allowedStorePaths = collectAllowedStorePaths(
    checkoutRealpath,
    options.allowedStorePaths,
  );

  const symlinkAudit = auditNodeModulesSymlinks({
    checkoutRealpath,
    blockedPaths,
    allowedStorePaths,
  });

  const hostRequire = createRequire(join(checkoutRealpath, "package.json"));
  const cliPackagePath = realpathSync(
    hostRequire.resolve("@verule/cli/package.json"),
  );
  if (!isInsideDirectory(cliPackagePath, checkoutRealpath)) {
    throw new Error(
      `Resolved @verule/cli/package.json outside host checkout: ${cliPackagePath}`,
    );
  }
  const cliManifestRaw: unknown = JSON.parse(
    readFileSync(cliPackagePath, "utf8"),
  );
  const cliVersion =
    typeof cliManifestRaw === "object" &&
    cliManifestRaw !== null &&
    "version" in cliManifestRaw &&
    typeof cliManifestRaw.version === "string"
      ? cliManifestRaw.version
      : "";
  if (cliVersion.length === 0) {
    throw new Error(`Missing version in ${cliPackagePath}`);
  }
  const packedCli = options.artifacts.find(
    (artifact) => artifact.name === "@verule/cli",
  );
  if (packedCli !== undefined && cliVersion !== packedCli.version) {
    throw new Error(
      `Resolved @verule/cli version ${cliVersion} does not match packed artifact version ${packedCli.version}`,
    );
  }

  const sdkResolvedPath = realpathSync(hostRequire.resolve("@verule/sdk"));
  if (!isInsideDirectory(sdkResolvedPath, checkoutRealpath)) {
    throw new Error(
      `Resolved @verule/sdk outside host checkout: ${sdkResolvedPath}`,
    );
  }

  const directPackages =
    options.directPackages ?? DEFAULT_DIRECT_VERULE_PACKAGES;
  const resolvedDirectPackages: Record<string, string> = {};
  for (const packageName of directPackages) {
    let resolvedPath: string;
    try {
      resolvedPath = realpathSync(hostRequire.resolve(packageName));
    } catch {
      resolvedPath = realpathSync(
        hostRequire.resolve(`${packageName}/package.json`),
      );
    }
    if (!isInsideDirectory(resolvedPath, checkoutRealpath)) {
      throw new Error(
        `Resolved direct package ${packageName} outside host checkout: ${resolvedPath}`,
      );
    }
    resolvedDirectPackages[packageName] = resolvedPath;
  }

  const sdkRequire = createRequire(sdkResolvedPath);
  const engineModulePath = realpathSync(
    sdkRequire.resolve("@verule/engine/binary"),
  );
  if (!isInsideDirectory(engineModulePath, checkoutRealpath)) {
    throw new Error(
      `Resolved @verule/engine/binary outside host checkout: ${engineModulePath}`,
    );
  }

  const engineModule: unknown = await import(
    pathToFileURL(engineModulePath).href
  );
  const rawEngineBinaryPath =
    typeof engineModule === "object" &&
    engineModule !== null &&
    "engineExecutablePath" in engineModule &&
    typeof engineModule.engineExecutablePath === "string"
      ? engineModule.engineExecutablePath
      : undefined;
  if (rawEngineBinaryPath === undefined) {
    throw new Error(
      `Missing engineExecutablePath export in ${engineModulePath}`,
    );
  }
  const engineBinaryPath = realpathSync(rawEngineBinaryPath);
  if (!isInsideDirectory(engineBinaryPath, checkoutRealpath)) {
    throw new Error(
      `Resolved verule-engine binary outside host checkout: ${engineBinaryPath}`,
    );
  }

  const engineBinarySha256 = createHash("sha256")
    .update(readFileSync(engineBinaryPath))
    .digest("hex");
  const packedEngine = options.artifacts.find(
    (artifact) => artifact.name === "@verule/engine",
  );
  if (
    packedEngine?.binarySha256 !== undefined &&
    engineBinarySha256 !== packedEngine.binarySha256
  ) {
    throw new Error(
      `Host verule-engine SHA-256 ${engineBinarySha256} does not match packed artifact ${packedEngine.binarySha256}`,
    );
  }

  return {
    checkoutRealpath,
    cliPackagePath,
    cliVersion,
    sdkResolvedPath,
    engineModulePath,
    engineBinaryPath,
    engineBinarySha256,
    resolvedDirectPackages,
    ...symlinkAudit,
  };
}
