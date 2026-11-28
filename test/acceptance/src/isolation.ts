import {
  type ChildProcess,
  execFile,
  execFileSync,
  spawn,
} from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  ensureControlledNode24Runtime,
  prependBinDirsToEnvPath,
} from "./node-runtime.ts";

export type IsolationMode = "bwrap" | "node-permission";

export type IsolationEvidence = {
  readonly mode: IsolationMode;
  readonly blockedPaths: readonly string[];
  readonly controlProbeBlocked: boolean;
  readonly controlProbeError: string;
};

export type BareVeruleRunResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs?: number;
  readonly timedOut?: boolean;
  readonly signal?: NodeJS.Signals | null;
  readonly isolation?: IsolationEvidence;
};

export type RunBareVeruleOptions = {
  readonly checkoutDir: string;
  readonly args: readonly string[];
  readonly isolated?: boolean;
  readonly pnpmStoreDir?: string;
  readonly runtimeBinDir?: string;
  readonly blockedPaths?: readonly string[];
  readonly sharedReadWritePaths?: readonly string[];
  readonly allowNet?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

export type RunNodeInHostOptions = RunBareVeruleOptions;

export type SpawnBareVeruleOptions = {
  readonly checkoutDir: string;
  readonly args: readonly string[];
  readonly isolated?: boolean;
  readonly pnpmStoreDir?: string;
  readonly runtimeBinDir?: string;
  readonly blockedPaths?: readonly string[];
  readonly sharedReadWritePaths?: readonly string[];
  readonly allowNet?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type SpawnedBareVerule = {
  readonly child: ChildProcess;
  readonly command: string;
  readonly args: readonly string[];
  readonly isolation?: IsolationEvidence;
  cleanup(): void;
};

const maxOutputBytes = 16 * 1024 * 1024;
const defaultTimeoutMs = 30_000;
const bwrapProbeCache = new Map<string, Promise<boolean>>();
const allowNetSupportCache = new Map<string, boolean>();

function supportsAllowNetFlag(nodeExecutablePath: string): boolean {
  const cached = allowNetSupportCache.get(nodeExecutablePath);
  if (cached !== undefined) {
    return cached;
  }
  let supported = false;
  try {
    const helpOutput = execFileSync(nodeExecutablePath, ["--help"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    supported = helpOutput.includes("--allow-net");
  } catch {
    supported = false;
  }
  allowNetSupportCache.set(nodeExecutablePath, supported);
  return supported;
}

function runAsyncExec(
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string;
    readonly env: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs: number;
  },
): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly signal: NodeJS.Signals | null;
}> {
  return new Promise((resolveResult) => {
    const startedAt = performance.now();
    execFile(
      command,
      args,
      {
        cwd: options.cwd,
        env: options.env,
        encoding: "utf8",
        timeout: options.timeoutMs,
        maxBuffer: maxOutputBytes,
      },
      (error, stdout, stderr) => {
        const durationMs = performance.now() - startedAt;
        if (error === null) {
          resolveResult({
            status: 0,
            stdout,
            stderr,
            durationMs,
            timedOut: false,
            signal: null,
          });
          return;
        }
        const timedOut =
          error.killed === true && !error.message.includes("maxBuffer");
        resolveResult({
          status: typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr: stderr.length > 0 ? stderr : error.message,
          durationMs,
          timedOut,
          signal: error.signal ?? null,
        });
      },
    );
  });
}

/**
 * Discovers development repository paths that must remain unreadable to the
 * inspected host process.
 */
export function resolveDefaultBlockedPaths(
  cwd: string = process.cwd(),
): readonly string[] {
  const candidates = new Set<string>();
  try {
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
    if (topLevel.length > 0 && existsSync(topLevel)) {
      const repoRealpath = realpathSync(topLevel);
      candidates.add(repoRealpath);
      const reposParent = dirname(repoRealpath);
      if (basename(reposParent) === "repos") {
        const workspaceRoot = dirname(reposParent);
        if (
          existsSync(join(workspaceRoot, "repos", "verule")) ||
          existsSync(join(workspaceRoot, "repos", "tssae"))
        ) {
          candidates.add(workspaceRoot);
        }
      }
    }
  } catch {
    // Ignore when invoked outside a git repository.
  }
  if (existsSync("/workspaces/verule")) {
    candidates.add(realpathSync("/workspaces/verule"));
  }
  return [...candidates];
}

function resolvePnpmStorePath(
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
  storeDir?: string,
): string | undefined {
  if (storeDir !== undefined && existsSync(storeDir)) {
    return realpathSync(storeDir);
  }
  try {
    const storePath = execFileSync("pnpm", ["store", "path"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...env },
    }).trim();
    return storePath.length > 0 && existsSync(storePath)
      ? realpathSync(storePath)
      : undefined;
  } catch {
    return undefined;
  }
}

function canUseBwrap(
  blockedPaths: readonly string[],
  cwd: string,
): Promise<boolean> {
  if (process.platform !== "linux") {
    return Promise.resolve(false);
  }
  const cacheKey = blockedPaths.join("\0");
  const cached = bwrapProbeCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }
  const tmpfsArgs = blockedPaths.flatMap((path) => ["--tmpfs", path]);
  const probePromise = runAsyncExec(
    "bwrap",
    [
      "--ro-bind",
      "/",
      "/",
      "--dev",
      "/dev",
      "--proc",
      "/proc",
      ...tmpfsArgs,
      "--",
      "true",
    ],
    { cwd, env: process.env, timeoutMs: 5_000 },
  )
    .then((probe) => probe.status === 0)
    .catch(() => false);
  bwrapProbeCache.set(cacheKey, probePromise);
  return probePromise;
}

function buildNodePermissionOptions(options: {
  readonly checkoutRealpath: string;
  readonly isolatedTmpDir: string;
  readonly runtimeBinDir: string;
  readonly nodeExecutablePath: string;
  readonly sharedReadWritePaths: readonly string[];
  readonly allowNet: boolean;
  readonly pnpmStorePath?: string;
}): string {
  const readAllowed = new Set<string>([
    options.checkoutRealpath,
    options.isolatedTmpDir,
    options.runtimeBinDir,
    ...options.sharedReadWritePaths,
    dirname(options.nodeExecutablePath),
    dirname(realpathSync(options.nodeExecutablePath)),
  ]);
  for (const systemDir of [
    "/pnpm/store",
    "/usr",
    "/lib",
    "/lib64",
    "/etc",
    "/proc",
    "/dev",
  ]) {
    if (existsSync(systemDir)) {
      readAllowed.add(systemDir);
    }
  }
  if (options.pnpmStorePath !== undefined) {
    readAllowed.add(options.pnpmStorePath);
  }

  const writeAllowed = [
    ...new Set([
      options.checkoutRealpath,
      options.isolatedTmpDir,
      ...options.sharedReadWritePaths,
    ]),
  ];
  const flags = [
    "--permission",
    ...[...readAllowed].map((path) => `--allow-fs-read=${path}`),
    ...writeAllowed.map((path) => `--allow-fs-write=${path}`),
    ...(options.allowNet && supportsAllowNetFlag(options.nodeExecutablePath)
      ? ["--allow-net"]
      : []),
    "--allow-child-process",
    "--allow-worker",
  ];
  return flags.join(" ");
}

async function runControlProbe(options: {
  readonly mode: IsolationMode;
  readonly nodeExecutablePath: string;
  readonly blockedPaths: readonly string[];
  readonly checkoutRealpath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly bwrapPrefixArgs: readonly string[];
}): Promise<{ readonly blocked: boolean; readonly errorMessage: string }> {
  const probeTarget = options.blockedPaths[0];
  if (probeTarget === undefined) {
    throw new Error(
      "At least one blocked path is required to verify dev-repo read isolation",
    );
  }
  const probeFile = join(probeTarget, "package.json");
  const probeScript =
    "const fs = require('node:fs'); fs.readFileSync(process.argv[1], 'utf8');";

  const command =
    options.mode === "bwrap" ? "bwrap" : options.nodeExecutablePath;
  const args =
    options.mode === "bwrap"
      ? [
          ...options.bwrapPrefixArgs,
          "--",
          options.nodeExecutablePath,
          "-e",
          probeScript,
          probeFile,
        ]
      : ["-e", probeScript, probeFile];

  const probe = await runAsyncExec(command, args, {
    cwd: options.checkoutRealpath,
    env: options.env,
    timeoutMs: 10_000,
  });

  if (probe.status === 0) {
    return {
      blocked: false,
      errorMessage: `Control probe unexpectedly read ${probeFile}`,
    };
  }
  if (
    options.mode === "node-permission" &&
    !probe.stderr.includes("ERR_ACCESS_DENIED")
  ) {
    return {
      blocked: false,
      errorMessage: `Control probe failed without ERR_ACCESS_DENIED: ${probe.stderr}`,
    };
  }
  return {
    blocked: true,
    errorMessage: probe.stderr.trim(),
  };
}

type PreparedBareVeruleExecution = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isolation?: IsolationEvidence;
  cleanup(): void;
};

async function prepareIsolatedHostExecution(
  options: Omit<RunBareVeruleOptions, "timeoutMs"> & {
    readonly executable: "verule" | "node";
    readonly dieWithParent?: boolean;
  },
): Promise<PreparedBareVeruleExecution> {
  const checkoutRealpath = realpathSync(options.checkoutDir);
  const binDir = join(checkoutRealpath, "node_modules", ".bin");
  const nodeRuntime = ensureControlledNode24Runtime(options.runtimeBinDir);
  const baseEnv = options.env ?? process.env;
  const envWithPath = prependBinDirsToEnvPath(baseEnv, [
    binDir,
    nodeRuntime.binDir,
  ]);

  if (options.isolated !== true) {
    return {
      command:
        options.executable === "node" ? nodeRuntime.executablePath : "verule",
      args: options.args,
      cwd: checkoutRealpath,
      env: envWithPath,
      cleanup(): void {},
    };
  }

  const blockedPaths = [
    ...new Set(
      (options.blockedPaths ?? resolveDefaultBlockedPaths())
        .filter((path) => existsSync(path))
        .map((path) => realpathSync(path)),
    ),
  ];
  const sharedReadWritePaths = [
    ...new Set(
      (options.sharedReadWritePaths ?? [])
        .filter((path) => existsSync(path))
        .map((path) => realpathSync(path)),
    ),
  ];
  const isolatedTmpDir = realpathSync(
    mkdtempSync(join(tmpdir(), "verule-isolated-tmp-")),
  );
  const cleanup = (): void => {
    rmSync(isolatedTmpDir, { recursive: true, force: true });
  };

  try {
    const useBwrap = await canUseBwrap(blockedPaths, checkoutRealpath);
    const mode: IsolationMode = useBwrap ? "bwrap" : "node-permission";
    const bwrapPrefixArgs = useBwrap
      ? [
          ...(options.dieWithParent === true ? ["--die-with-parent"] : []),
          "--ro-bind",
          "/",
          "/",
          "--dev",
          "/dev",
          "--proc",
          "/proc",
          "--bind",
          checkoutRealpath,
          checkoutRealpath,
          "--bind",
          isolatedTmpDir,
          isolatedTmpDir,
          ...sharedReadWritePaths.flatMap((path) => ["--bind", path, path]),
          ...blockedPaths.flatMap((path) => ["--tmpfs", path]),
        ]
      : [];

    const pnpmStorePath = resolvePnpmStorePath(
      checkoutRealpath,
      baseEnv,
      options.pnpmStoreDir,
    );
    const isolatedEnv: Record<string, string | undefined> = useBwrap
      ? {
          ...envWithPath,
          TMPDIR: isolatedTmpDir,
        }
      : {
          ...envWithPath,
          NODE_NO_WARNINGS: "1",
          NODE_OPTIONS: buildNodePermissionOptions({
            checkoutRealpath,
            isolatedTmpDir,
            runtimeBinDir: nodeRuntime.binDir,
            nodeExecutablePath: nodeRuntime.executablePath,
            sharedReadWritePaths,
            allowNet: options.allowNet === true,
            ...(pnpmStorePath === undefined ? {} : { pnpmStorePath }),
          }),
          TMPDIR: isolatedTmpDir,
        };

    const probe = await runControlProbe({
      mode,
      nodeExecutablePath: nodeRuntime.executablePath,
      blockedPaths,
      checkoutRealpath,
      env: isolatedEnv,
      bwrapPrefixArgs,
    });
    if (!probe.blocked) {
      throw new Error(
        `Dev-repo read isolation control probe failed (${mode}): ${probe.errorMessage}`,
      );
    }

    const hostExecutable =
      options.executable === "node"
        ? nodeRuntime.executablePath
        : useBwrap
          ? resolve(binDir, "verule")
          : "verule";
    const command = useBwrap ? "bwrap" : hostExecutable;
    const args = useBwrap
      ? [...bwrapPrefixArgs, "--", hostExecutable, ...options.args]
      : options.args;

    return {
      command,
      args,
      cwd: checkoutRealpath,
      env: isolatedEnv,
      isolation: {
        mode,
        blockedPaths,
        controlProbeBlocked: probe.blocked,
        controlProbeError: probe.errorMessage,
      },
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

async function runPreparedHostCommand(
  options: RunBareVeruleOptions & { readonly executable: "verule" | "node" },
): Promise<BareVeruleRunResult> {
  const prepared = await prepareIsolatedHostExecution(options);
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  try {
    const result = await runAsyncExec(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      timeoutMs,
    });

    return {
      ...result,
      ...(prepared.isolation === undefined
        ? {}
        : { isolation: prepared.isolation }),
    };
  } finally {
    prepared.cleanup();
  }
}

/**
 * Runs the host-installed bare `verule` command from `checkoutDir`, optionally
 * isolating filesystem reads so the inspected process cannot access the
 * development repository.
 */
export function runBareVeruleInHost(
  options: RunBareVeruleOptions,
): Promise<BareVeruleRunResult> {
  return runPreparedHostCommand({ ...options, executable: "verule" });
}

/**
 * Runs a Node `24.0.0` script or expression inside the host checkout with
 * optional dev-repo read isolation.
 */
export function runNodeInHost(
  options: RunNodeInHostOptions,
): Promise<BareVeruleRunResult> {
  return runPreparedHostCommand({ ...options, executable: "node" });
}

/**
 * Spawns a long-lived host-installed bare `verule` command (`watch` or
 * `session`) with piped `stdio` and optional dev-repo read isolation.
 */
export async function spawnBareVeruleInHost(
  options: SpawnBareVeruleOptions,
): Promise<SpawnedBareVerule> {
  const prepared = await prepareIsolatedHostExecution({
    ...options,
    executable: "verule",
    dieWithParent: true,
  });

  let child: ChildProcess;
  try {
    child = spawn(prepared.command, prepared.args, {
      cwd: prepared.cwd,
      env: prepared.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    prepared.cleanup();
    throw error;
  }

  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) {
      return;
    }
    cleaned = true;
    prepared.cleanup();
  };
  child.once("close", cleanup);
  child.once("error", cleanup);

  return {
    child,
    command: prepared.command,
    args: prepared.args,
    ...(prepared.isolation === undefined
      ? {}
      : { isolation: prepared.isolation }),
    cleanup,
  };
}
