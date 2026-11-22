import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { resolveHostCacheDir, resolveHostRepositoryUrl } from "./hosts.ts";
import type {
  HostCheckoutOutcome,
  HostId,
  PreparationFailure,
  PreparationStage,
} from "./types.ts";

export type PrepareHostCheckoutOptions = {
  readonly hostId: HostId;
  readonly sha: string;
  readonly repositoryUrl?: string;
  readonly cacheDir?: string;
  readonly retryDelaysMs?: readonly number[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly onFetchAttempt?: (attempt: number) => void;
};

type ExecResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

const defaultRetryDelaysMs = [1000, 3000];
const maxGitBufferBytes = 32 * 1024 * 1024;

function runGit(
  args: readonly string[],
  cwd?: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<ExecResult> {
  return new Promise((resolveResult) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: maxGitBufferBytes,
        env: {
          ...env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveResult({ status: 0, stdout, stderr });
          return;
        }
        const status = typeof error.code === "number" ? error.code : 1;
        resolveResult({
          status,
          stdout,
          stderr: stderr.length > 0 ? stderr : error.message,
        });
      },
    );
  });
}

function makeFailure(
  stage: PreparationStage,
  hostId: HostId,
  sha: string,
  message: string,
  details?: {
    readonly command?: string;
    readonly exitCode?: number;
    readonly stderr?: string;
  },
): PreparationFailure {
  return {
    status: "preparation-failed",
    stage,
    hostId,
    sha,
    message,
    ...details,
  };
}

async function ensureBareCacheHasCommit(options: {
  readonly bareRepoDir: string;
  readonly hostId: HostId;
  readonly sha: string;
  readonly repositoryUrl: string;
  readonly retryDelaysMs: readonly number[];
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly onFetchAttempt?: (attempt: number) => void;
}): Promise<PreparationFailure | undefined> {
  const { bareRepoDir, hostId, sha, repositoryUrl, retryDelaysMs, env } =
    options;

  mkdirSync(bareRepoDir, { recursive: true });
  if (!existsSync(join(bareRepoDir, "HEAD"))) {
    const init = await runGit(
      ["init", "--bare", "--quiet", bareRepoDir],
      undefined,
      env,
    );
    if (init.status !== 0) {
      return makeFailure(
        "git-fetch",
        hostId,
        sha,
        `Failed to initialize bare cache repository for ${hostId}`,
        {
          command: `git init --bare --quiet ${bareRepoDir}`,
          exitCode: init.status,
          stderr: init.stderr.trim(),
        },
      );
    }
    await runGit(
      ["-C", bareRepoDir, "config", "uploadpack.allowAnySHA1InWant", "true"],
      undefined,
      env,
    );
  }

  const cached = await runGit(
    ["-C", bareRepoDir, "cat-file", "-e", `${sha}^{commit}`],
    undefined,
    env,
  );
  if (cached.status === 0) {
    const refCheck = await runGit(
      [
        "-C",
        bareRepoDir,
        "show-ref",
        "--verify",
        "--quiet",
        `refs/verule/${sha}`,
      ],
      undefined,
      env,
    );
    if (refCheck.status !== 0) {
      await runGit(
        ["-C", bareRepoDir, "update-ref", `refs/verule/${sha}`, sha],
        undefined,
        env,
      );
    }
    return undefined;
  }

  const maxAttempts = retryDelaysMs.length + 1;
  let lastFetch: ExecResult = { status: 1, stdout: "", stderr: "" };
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    options.onFetchAttempt?.(attempt);
    lastFetch = await runGit(
      ["-C", bareRepoDir, "fetch", "--quiet", "--depth=1", repositoryUrl, sha],
      undefined,
      env,
    );
    if (lastFetch.status === 0) {
      const refUpdate = await runGit(
        ["-C", bareRepoDir, "update-ref", `refs/verule/${sha}`, "FETCH_HEAD"],
        undefined,
        env,
      );
      if (refUpdate.status !== 0) {
        return makeFailure(
          "git-fetch",
          hostId,
          sha,
          `Failed to pin fetched commit ${sha} in bare cache for ${hostId}`,
          {
            command: `git -C ${bareRepoDir} update-ref refs/verule/${sha} FETCH_HEAD`,
            exitCode: refUpdate.status,
            stderr: refUpdate.stderr.trim(),
          },
        );
      }
      return undefined;
    }

    const backoffMs = retryDelaysMs[attempt - 1];
    if (backoffMs !== undefined && backoffMs > 0) {
      await delay(backoffMs);
    }
  }

  return makeFailure(
    "git-fetch",
    hostId,
    sha,
    `Failed to fetch ${hostId} commit ${sha} from ${repositoryUrl} after ${String(maxAttempts)} attempt(s)`,
    {
      command: `git -C ${bareRepoDir} fetch --quiet --depth=1 ${repositoryUrl} ${sha}`,
      exitCode: lastFetch.status,
      stderr: lastFetch.stderr.trim(),
    },
  );
}

/**
 * Fetches a pinned upstream commit into an out-of-repo bare git cache with
 * `GIT_TERMINAL_PROMPT=0` and exponential backoff retries, then checks out a
 * fresh clean working tree in `os.tmpdir()`.
 */
export async function prepareHostCheckout(
  options: PrepareHostCheckoutOptions,
): Promise<HostCheckoutOutcome> {
  const env = options.env ?? process.env;
  const repositoryUrl =
    options.repositoryUrl ?? resolveHostRepositoryUrl(options.hostId, env);
  const cacheDir = options.cacheDir ?? resolveHostCacheDir(env);
  const bareRepoDir = join(cacheDir, `${options.hostId}.git`);
  const retryDelaysMs = options.retryDelaysMs ?? defaultRetryDelaysMs;

  const fetchFailure = await ensureBareCacheHasCommit({
    bareRepoDir,
    hostId: options.hostId,
    sha: options.sha,
    repositoryUrl,
    retryDelaysMs,
    env,
    ...(options.onFetchAttempt === undefined
      ? {}
      : { onFetchAttempt: options.onFetchAttempt }),
  });
  if (fetchFailure !== undefined) {
    return fetchFailure;
  }

  const checkoutDir = mkdtempSync(
    join(tmpdir(), `verule-host-${options.hostId}-`),
  );
  const cleanup = (): void => {
    rmSync(checkoutDir, { recursive: true, force: true });
  };

  try {
    const init = await runGit(["init", "--quiet", checkoutDir], undefined, env);
    if (init.status !== 0) {
      cleanup();
      return makeFailure(
        "git-checkout",
        options.hostId,
        options.sha,
        `Failed to initialize temporary checkout for ${options.hostId}`,
        {
          command: `git init --quiet ${checkoutDir}`,
          exitCode: init.status,
          stderr: init.stderr.trim(),
        },
      );
    }

    const localFetch = await runGit(
      [
        "-C",
        checkoutDir,
        "fetch",
        "--quiet",
        "--depth=1",
        bareRepoDir,
        `refs/verule/${options.sha}`,
      ],
      undefined,
      env,
    );
    if (localFetch.status !== 0) {
      cleanup();
      return makeFailure(
        "git-checkout",
        options.hostId,
        options.sha,
        `Failed to load cached commit ${options.sha} for ${options.hostId}`,
        {
          command: `git -C ${checkoutDir} fetch --quiet --depth=1 ${bareRepoDir} refs/verule/${options.sha}`,
          exitCode: localFetch.status,
          stderr: localFetch.stderr.trim(),
        },
      );
    }

    const checkout = await runGit(
      ["-C", checkoutDir, "checkout", "--quiet", "--detach", "FETCH_HEAD"],
      undefined,
      env,
    );
    if (checkout.status !== 0) {
      cleanup();
      return makeFailure(
        "git-checkout",
        options.hostId,
        options.sha,
        `Failed to check out ${options.sha} for ${options.hostId}`,
        {
          command: `git -C ${checkoutDir} checkout --quiet --detach FETCH_HEAD`,
          exitCode: checkout.status,
          stderr: checkout.stderr.trim(),
        },
      );
    }

    const head = await runGit(
      ["-C", checkoutDir, "rev-parse", "HEAD"],
      undefined,
      env,
    );
    const actualSha = head.stdout.trim();
    if (head.status !== 0 || actualSha !== options.sha) {
      cleanup();
      return makeFailure(
        "git-checkout",
        options.hostId,
        options.sha,
        `Checked-out HEAD ${actualSha || "<unknown>"} did not match expected ${options.sha}`,
        {
          command: `git -C ${checkoutDir} rev-parse HEAD`,
          exitCode: head.status,
          stderr: head.stderr.trim(),
        },
      );
    }

    const status = await runGit(
      ["-C", checkoutDir, "status", "--porcelain"],
      undefined,
      env,
    );
    if (status.status !== 0 || status.stdout.trim().length > 0) {
      cleanup();
      return makeFailure(
        "git-checkout",
        options.hostId,
        options.sha,
        `Temporary checkout for ${options.hostId} at ${options.sha} is not clean`,
        {
          command: `git -C ${checkoutDir} status --porcelain`,
          exitCode: status.status,
          stderr: status.stderr.trim(),
        },
      );
    }

    return {
      status: "ready",
      hostId: options.hostId,
      sha: options.sha,
      checkoutDir,
      cleanup,
    };
  } catch (error) {
    cleanup();
    return makeFailure(
      "git-checkout",
      options.hostId,
      options.sha,
      error instanceof Error ? error.message : String(error),
    );
  }
}
