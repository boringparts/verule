import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

export const EXPECTED_ACCEPTANCE_NODE_VERSION = "24.0.0";

export type ControlledNodeRuntime = {
  readonly binDir: string;
  readonly executablePath: string;
  readonly version: string;
};

const nodeExecutableName = process.platform === "win32" ? "node.exe" : "node";
const acceptanceRequire = createRequire(import.meta.url);
const verifiedExecutables = new Map<string, string>();
let sharedFallbackBinDir: string | undefined;

function resolveWorkspaceNode24Executable(): string {
  const veruleEntry = acceptanceRequire.resolve("@boringparts/verule");
  const verulePackageDir = dirname(dirname(veruleEntry));
  const candidateBin = join(
    verulePackageDir,
    "node_modules",
    ".bin",
    nodeExecutableName,
  );
  if (!existsSync(candidateBin)) {
    throw new Error(
      `Missing workspace Node ${EXPECTED_ACCEPTANCE_NODE_VERSION} binary at ${candidateBin}`,
    );
  }
  return realpathSync(candidateBin);
}

function getSharedFallbackBinDir(): string {
  if (sharedFallbackBinDir !== undefined && existsSync(sharedFallbackBinDir)) {
    return sharedFallbackBinDir;
  }
  const dir = mkdtempSync(join(tmpdir(), "verule-node24-bin-"));
  sharedFallbackBinDir = dir;
  process.once("exit", () => {
    rmSync(dir, { recursive: true, force: true });
  });
  return dir;
}

function verifyNode24Version(executablePath: string): string {
  const cached = verifiedExecutables.get(executablePath);
  if (cached !== undefined) {
    return cached;
  }
  const actualVersion = execFileSync(
    executablePath,
    ["-p", "process.versions.node"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
  if (actualVersion !== EXPECTED_ACCEPTANCE_NODE_VERSION) {
    throw new Error(
      `Expected controlled acceptance runtime Node ${EXPECTED_ACCEPTANCE_NODE_VERSION}, got ${actualVersion} (${executablePath})`,
    );
  }
  verifiedExecutables.set(executablePath, actualVersion);
  return actualVersion;
}

/**
 * Materializes the controlled Node `24.0.0` executable in an out-of-repo
 * directory so consumer package installations and isolated host runs execute
 * against Node `24.0.0` without triggering network downloads or dev-repo reads.
 */
export function ensureControlledNode24Runtime(
  targetBinDir?: string,
): ControlledNodeRuntime {
  const binDir = resolve(targetBinDir ?? getSharedFallbackBinDir());
  mkdirSync(binDir, { recursive: true });
  const executablePath = join(binDir, nodeExecutableName);
  if (!existsSync(executablePath)) {
    const sourceExecutable = resolveWorkspaceNode24Executable();
    try {
      // Hard-link to avoid copying ~100MB per host while keeping realpath outside blockedPaths.
      linkSync(sourceExecutable, executablePath);
    } catch {
      copyFileSync(sourceExecutable, executablePath);
      if (process.platform !== "win32") {
        chmodSync(executablePath, 0o755);
      }
    }
  }
  const version = verifyNode24Version(executablePath);
  return {
    binDir,
    executablePath,
    version,
  };
}

/**
 * Prepends one or more `bin` directories to `env.PATH`.
 */
export function prependBinDirsToEnvPath(
  env: Readonly<Record<string, string | undefined>>,
  binDirs: readonly string[],
): Record<string, string | undefined> {
  const prefix = binDirs.filter((dir) => dir.length > 0).join(delimiter);
  if (prefix.length === 0) {
    return { ...env };
  }
  return {
    ...env,
    PATH:
      env.PATH !== undefined && env.PATH.length > 0
        ? `${prefix}${delimiter}${env.PATH}`
        : prefix,
  };
}
