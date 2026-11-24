import { execFile, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";

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
  readonly isolation?: IsolationEvidence;
};

export type RunBareVeruleOptions = {
  readonly checkoutDir: string;
  readonly args: readonly string[];
  readonly isolated?: boolean;
  readonly pnpmStoreDir?: string;
  readonly blockedPaths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

const maxOutputBytes = 16 * 1024 * 1024;
const defaultTimeoutMs = 30_000;

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
}> {
  return new Promise((resolveResult) => {
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
        if (error === null) {
          resolveResult({ status: 0, stdout, stderr });
          return;
        }
        resolveResult({
          status: typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr: stderr.length > 0 ? stderr : error.message,
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
      candidates.add(realpathSync(topLevel));
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

async function canUseBwrap(
  blockedPaths: readonly string[],
  cwd: string,
): Promise<boolean> {
  if (process.platform !== "linux") {
    return false;
  }
  const tmpfsArgs = blockedPaths.flatMap((path) => ["--tmpfs", path]);
  const probe = await runAsyncExec(
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
  );
  return probe.status === 0;
}

function buildNodePermissionOptions(options: {
  readonly checkoutRealpath: string;
  readonly isolatedTmpDir: string;
  readonly pnpmStorePath?: string;
}): string {
  const readAllowed = new Set<string>([
    options.checkoutRealpath,
    options.isolatedTmpDir,
    dirname(process.execPath),
    dirname(realpathSync(process.execPath)),
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

  const writeAllowed = [options.checkoutRealpath, options.isolatedTmpDir];
  const flags = [
    "--permission",
    ...[...readAllowed].map((path) => `--allow-fs-read=${path}`),
    ...writeAllowed.map((path) => `--allow-fs-write=${path}`),
    "--allow-child-process",
    "--allow-worker",
  ];
  return flags.join(" ");
}

async function runControlProbe(options: {
  readonly mode: IsolationMode;
  readonly blockedPaths: readonly string[];
  readonly checkoutRealpath: string;
  readonly isolatedTmpDir: string;
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

  const command = options.mode === "bwrap" ? "bwrap" : process.execPath;
  const args =
    options.mode === "bwrap"
      ? [
          ...options.bwrapPrefixArgs,
          "--",
          process.execPath,
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

/**
 * Runs the host-installed bare `verule` command from `checkoutDir`, optionally
 * isolating filesystem reads so the inspected process cannot access the
 * development repository.
 */
export async function runBareVeruleInHost(
  options: RunBareVeruleOptions,
): Promise<BareVeruleRunResult> {
  const checkoutRealpath = realpathSync(options.checkoutDir);
  const binDir = join(checkoutRealpath, "node_modules", ".bin");
  const baseEnv = options.env ?? process.env;
  const envWithPath: Record<string, string | undefined> = {
    ...baseEnv,
    PATH: `${binDir}${delimiter}${baseEnv.PATH ?? ""}`,
  };
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;

  if (options.isolated !== true) {
    return runAsyncExec("verule", options.args, {
      cwd: checkoutRealpath,
      env: envWithPath,
      timeoutMs,
    });
  }

  const blockedPaths = [
    ...new Set(
      (options.blockedPaths ?? resolveDefaultBlockedPaths())
        .filter((path) => existsSync(path))
        .map((path) => realpathSync(path)),
    ),
  ];
  const isolatedTmpDir = realpathSync(
    mkdtempSync(join(tmpdir(), "verule-isolated-tmp-")),
  );

  try {
    const useBwrap = await canUseBwrap(blockedPaths, checkoutRealpath);
    const mode: IsolationMode = useBwrap ? "bwrap" : "node-permission";
    const bwrapPrefixArgs = useBwrap
      ? [
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
            ...(pnpmStorePath === undefined ? {} : { pnpmStorePath }),
          }),
          TMPDIR: isolatedTmpDir,
        };

    const probe = await runControlProbe({
      mode,
      blockedPaths,
      checkoutRealpath,
      isolatedTmpDir,
      env: isolatedEnv,
      bwrapPrefixArgs,
    });
    if (!probe.blocked) {
      throw new Error(
        `Dev-repo read isolation control probe failed (${mode}): ${probe.errorMessage}`,
      );
    }

    const command = useBwrap ? "bwrap" : "verule";
    const commandArgs = useBwrap
      ? [...bwrapPrefixArgs, "--", resolve(binDir, "verule"), ...options.args]
      : options.args;

    const result = await runAsyncExec(command, commandArgs, {
      cwd: checkoutRealpath,
      env: isolatedEnv,
      timeoutMs,
    });

    return {
      ...result,
      isolation: {
        mode,
        blockedPaths,
        controlProbeBlocked: probe.blocked,
        controlProbeError: probe.errorMessage,
      },
    };
  } finally {
    rmSync(isolatedTmpDir, { recursive: true, force: true });
  }
}
