import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import type { CheckReport, ProjectSummary } from "@boringparts/verule";

import {
  type IsolationEvidence,
  releaseChildProcessHandles,
  runBareVeruleInHost,
  signalChildProcessGroup,
  spawnBareVeruleInHost,
  type SpawnedBareVerule,
} from "./isolation.ts";

export type WatchRecomputationScope = {
  readonly recomputedProjects: readonly string[];
  readonly reusedProjects: readonly string[];
  readonly recomputedFiles: readonly string[];
  readonly reusedFiles: readonly string[];
  readonly removedFiles: readonly string[];
  readonly invalidatedBy: readonly string[];
};

export type WatchMemoryStats = {
  readonly hostRssBytes: number;
  readonly engineRssBytes?: number;
};

export type WatchReportRecord = CheckReport & {
  readonly sequence: number;
  readonly trigger: "initial" | "change";
  readonly snapshotId: number;
  readonly recomputation: WatchRecomputationScope;
  readonly memory: WatchMemoryStats;
};

export type WatchFailureRecord = {
  readonly reportVersion: string;
  readonly sequence: number;
  readonly trigger: "initial" | "change";
  readonly code: string;
  readonly message: string;
  readonly conflict?: unknown;
};

export type WatchStreamEvent =
  | { readonly variant: "report"; readonly data: WatchReportRecord }
  | { readonly variant: "failed"; readonly data: WatchFailureRecord };

export type SessionReadyRecord = {
  readonly reportVersion: string;
  readonly endpoint: string;
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
};

export type CliCheckResult = {
  readonly status: number;
  readonly variant: "clean" | "findings";
  readonly report: CheckReport;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs?: number;
  readonly isolation?: IsolationEvidence;
};

export type ProcessExitSummary = {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stderr: string;
  readonly records: readonly NdjsonEnvelope[];
};

export type NdjsonEnvelope = {
  readonly kind?: string;
  readonly variant?: string;
  readonly data?: unknown;
  readonly [key: string]: unknown;
};

const defaultStreamTimeoutMs = 90_000;
const defaultShutdownTimeoutMs = 5_000;

function extractStructuredFailureMessage(stderr: string): string | undefined {
  for (const line of stderr.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) {
      continue;
    }
    try {
      const parsed = JSON.parse(trimmed) as NdjsonEnvelope;
      if (
        parsed.kind === "failure" &&
        typeof parsed.data === "object" &&
        parsed.data !== null
      ) {
        const data = parsed.data as {
          readonly code?: unknown;
          readonly message?: unknown;
        };
        const code = typeof data.code === "string" ? data.code : "ERROR";
        const message =
          typeof data.message === "string" ? data.message : trimmed;
        return `[${code}] ${message}`;
      }
    } catch {
      // Fall back to raw stderr text.
    }
  }
  return undefined;
}

/**
 * Parses a JSON envelope printed by `verule check --output json` and rejects
 * unexpected execution failures (exit status other than 0 or 1).
 */
export function parseCheckJsonResult(result: {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs?: number;
  readonly isolation?: IsolationEvidence;
}): CliCheckResult {
  if (result.status !== 0 && result.status !== 1) {
    const structured = extractStructuredFailureMessage(
      `${result.stdout}\n${result.stderr}`,
    );
    const detail =
      structured ??
      (result.stderr.trim() || result.stdout.trim() || "no output");
    throw new Error(
      `verule check exited with status ${String(result.status)}: ${detail}`,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `Failed to parse verule check JSON output (status ${String(result.status)}): ${
        error instanceof Error ? error.message : String(error)
      }\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      { cause: error },
    );
  }

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    parsed.kind !== "data" ||
    !("variant" in parsed) ||
    (parsed.variant !== "clean" && parsed.variant !== "findings") ||
    !("data" in parsed) ||
    typeof parsed.data !== "object" ||
    parsed.data === null
  ) {
    throw new Error(`Unexpected verule check JSON envelope: ${result.stdout}`);
  }

  return {
    status: result.status,
    variant: parsed.variant,
    report: parsed.data as CheckReport,
    stdout: result.stdout,
    stderr: result.stderr,
    ...(result.durationMs === undefined
      ? {}
      : { durationMs: result.durationMs }),
    ...(result.isolation === undefined ? {} : { isolation: result.isolation }),
  };
}

class NdjsonProcessController {
  readonly #spawned: SpawnedBareVerule;
  readonly #commandLabel: string;
  readonly #records: NdjsonEnvelope[] = [];
  readonly #waiters = new Set<() => void>();
  readonly #onCleanup: (() => void) | undefined;
  #stdoutBuffer = "";
  #stderr = "";
  #stdoutEnded = false;
  #stderrEnded = false;
  #exitState:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  #spawnError: Error | undefined;
  #exitGraceTimer: NodeJS.Timeout | undefined;
  #closePromise: Promise<ProcessExitSummary> | undefined;

  constructor(
    spawned: SpawnedBareVerule,
    commandLabel: string,
    onCleanup?: () => void,
  ) {
    this.#spawned = spawned;
    this.#commandLabel = commandLabel;
    this.#onCleanup = onCleanup;

    const child = spawned.child;
    if (child.stdout !== null) {
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        this.#stdoutBuffer += chunk;
        this.#drainStdoutLines();
        this.#notifyWaiters();
      });
      child.stdout.once("end", () => {
        this.#stdoutEnded = true;
        this.#flushRemainder();
        this.#notifyWaiters();
      });
    } else {
      this.#stdoutEnded = true;
    }

    if (child.stderr !== null) {
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        this.#stderr += chunk;
      });
      child.stderr.once("end", () => {
        this.#stderrEnded = true;
        this.#notifyWaiters();
      });
    } else {
      this.#stderrEnded = true;
    }

    child.once("error", (error) => {
      this.#spawnError = error;
      this.#notifyWaiters();
    });

    child.once("exit", (code, signal) => {
      this.#exitState = { code, signal };
      if (this.#stdoutEnded && this.#stderrEnded) {
        this.#notifyWaiters();
      } else {
        // Wake shortly after exit even if a descendant kept an fd open.
        this.#exitGraceTimer = setTimeout(() => {
          this.#exitGraceTimer = undefined;
          this.#notifyWaiters();
        }, 50);
        this.#exitGraceTimer.unref();
      }
    });

    child.once("close", () => {
      this.#stdoutEnded = true;
      this.#stderrEnded = true;
      if (this.#exitGraceTimer !== undefined) {
        clearTimeout(this.#exitGraceTimer);
        this.#exitGraceTimer = undefined;
      }
      this.#flushRemainder();
      this.#notifyWaiters();
    });
  }

  get isolation(): IsolationEvidence | undefined {
    return this.#spawned.isolation;
  }

  #drainStdoutLines(): void {
    while (true) {
      const newlineIndex = this.#stdoutBuffer.indexOf("\n");
      if (newlineIndex === -1) {
        return;
      }
      const line = this.#stdoutBuffer.slice(0, newlineIndex).trim();
      this.#stdoutBuffer = this.#stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        this.#pushLine(line);
      }
    }
  }

  #flushRemainder(): void {
    const remainder = this.#stdoutBuffer.trim();
    this.#stdoutBuffer = "";
    if (remainder.length > 0) {
      this.#pushLine(remainder);
    }
  }

  #pushLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as NdjsonEnvelope;
      this.#records.push(parsed);
    } catch {
      this.#records.push({ kind: "unparsed", raw: line });
    }
  }

  #notifyWaiters(): void {
    for (const wake of Array.from(this.#waiters)) {
      wake();
    }
  }

  #formatDiagnostics(): string {
    const structuredFailure = extractStructuredFailureMessage(this.#stderr);
    const stderrSummary =
      structuredFailure ?? (this.#stderr.trim() || "<empty>");
    return `stderr=${stderrSummary} records=${JSON.stringify(this.#records)}`;
  }

  async waitForRecordFrom(
    startIndex: number,
    predicate: (record: NdjsonEnvelope) => boolean,
    options: { readonly timeoutMs?: number; readonly label: string },
  ): Promise<{ readonly record: NdjsonEnvelope; readonly nextIndex: number }> {
    const timeoutMs = options.timeoutMs ?? defaultStreamTimeoutMs;
    const deadline = Date.now() + timeoutMs;
    let cursor = startIndex;

    while (true) {
      while (cursor < this.#records.length) {
        const candidate = this.#records[cursor]!;
        cursor += 1;
        if (predicate(candidate)) {
          return { record: candidate, nextIndex: cursor };
        }
      }

      if (this.#spawnError !== undefined) {
        throw new Error(
          `${this.#commandLabel} failed before ${options.label}: ${this.#spawnError.message}; ${this.#formatDiagnostics()}`,
        );
      }

      if (
        this.#exitState !== undefined &&
        ((this.#stdoutEnded && this.#stderrEnded) ||
          this.#exitGraceTimer === undefined)
      ) {
        throw new Error(
          `${this.#commandLabel} exited early (code=${String(this.#exitState.code)}, signal=${String(this.#exitState.signal)}) while waiting for ${options.label}; ${this.#formatDiagnostics()}`,
        );
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new Error(
          `Timed out waiting for ${options.label} after ${String(timeoutMs)}ms (${this.#commandLabel}); ${this.#formatDiagnostics()}`,
        );
      }

      await new Promise<void>((resolveWait) => {
        let settled = false;
        const finish = (): void => {
          if (settled) {
            return;
          }
          settled = true;
          clearTimeout(timer);
          this.#waiters.delete(finish);
          resolveWait();
        };
        const timer = setTimeout(finish, remainingMs);
        this.#waiters.add(finish);
      });
    }
  }

  close(
    timeoutMs: number = defaultShutdownTimeoutMs,
  ): Promise<ProcessExitSummary> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }

    this.#closePromise = this.#performClose(timeoutMs);
    return this.#closePromise;
  }

  async #performClose(timeoutMs: number): Promise<ProcessExitSummary> {
    const child = this.#spawned.child;
    try {
      if (this.#exitState === undefined && this.#spawnError === undefined) {
        try {
          child.stdin?.end();
        } catch {
          // Ignore closed stdin pipe.
        }
        // Only signal the direct child for graceful shutdown so verule can close
        // tssae-engine cleanly instead of killing the engine socket mid-shutdown;
        // escalate to process-group SIGKILL if the group does not exit in time.
        try {
          child.kill("SIGINT");
        } catch {
          // Ignore if child already exited.
        }

        const exitedCleanly = await this.#waitForExit(timeoutMs);
        if (!exitedCleanly) {
          signalChildProcessGroup(child, "SIGKILL");
          await this.#waitForExit(2_000);
        }
      } else if (
        this.#spawnError === undefined &&
        (!this.#stdoutEnded || !this.#stderrEnded)
      ) {
        const drained = await this.#waitForExit(200);
        if (!drained) {
          signalChildProcessGroup(child, "SIGKILL");
          await this.#waitForExit(2_000);
        }
      }
    } finally {
      if (this.#exitGraceTimer !== undefined) {
        clearTimeout(this.#exitGraceTimer);
        this.#exitGraceTimer = undefined;
      }
      releaseChildProcessHandles(child);
      this.#spawned.cleanup();
      this.#onCleanup?.();
    }

    return {
      code: this.#exitState?.code ?? null,
      signal: this.#exitState?.signal ?? null,
      stderr: this.#stderr,
      records: [...this.#records],
    };
  }

  #waitForExit(timeoutMs: number): Promise<boolean> {
    if (
      (this.#exitState !== undefined &&
        this.#stdoutEnded &&
        this.#stderrEnded) ||
      this.#spawnError !== undefined
    ) {
      return Promise.resolve(true);
    }

    return new Promise<boolean>((resolveExit) => {
      let settled = false;
      const onClose = (): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        this.#spawned.child.off("close", onClose);
        resolveExit(true);
      };
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        this.#spawned.child.off("close", onClose);
        resolveExit(false);
      }, timeoutMs);
      this.#spawned.child.once("close", onClose);
    });
  }
}

export type AcceptanceWatchSession = {
  readonly isolation?: IsolationEvidence;
  nextEvent(options?: {
    readonly timeoutMs?: number;
  }): Promise<WatchStreamEvent>;
  nextReport(options?: {
    readonly timeoutMs?: number;
  }): Promise<WatchReportRecord>;
  close(options?: { readonly timeoutMs?: number }): Promise<ProcessExitSummary>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type StartWatchProcessOptions = {
  readonly checkoutDir: string;
  readonly config?: string;
  readonly isolated?: boolean;
  readonly pnpmStoreDir?: string;
  readonly runtimeBinDir?: string;
  readonly blockedPaths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly defaultTimeoutMs?: number;
};

/**
 * Starts `verule watch --output ndjson` in the host checkout and exposes a
 * sequential event/report stream with immediate early-exit detection.
 */
export async function startWatchProcess(
  options: StartWatchProcessOptions,
): Promise<AcceptanceWatchSession> {
  const args = [
    "watch",
    ...(options.config === undefined ? [] : ["--config", options.config]),
    "--output",
    "ndjson",
  ];
  const spawned = await spawnBareVeruleInHost({
    checkoutDir: options.checkoutDir,
    args,
    isolated: options.isolated ?? true,
    ...(options.pnpmStoreDir === undefined
      ? {}
      : { pnpmStoreDir: options.pnpmStoreDir }),
    ...(options.runtimeBinDir === undefined
      ? {}
      : { runtimeBinDir: options.runtimeBinDir }),
    ...(options.blockedPaths === undefined
      ? {}
      : { blockedPaths: options.blockedPaths }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const controller = new NdjsonProcessController(
    spawned,
    `verule ${args.join(" ")}`,
  );
  let cursor = 0;

  async function nextEvent(waitOptions?: {
    readonly timeoutMs?: number;
  }): Promise<WatchStreamEvent> {
    const timeoutMs =
      waitOptions?.timeoutMs ??
      options.defaultTimeoutMs ??
      defaultStreamTimeoutMs;
    const { record, nextIndex } = await controller.waitForRecordFrom(
      cursor,
      (candidate) =>
        candidate.kind === "record" &&
        (candidate.variant === "report" || candidate.variant === "failed"),
      { timeoutMs, label: "watch report" },
    );
    cursor = nextIndex;
    if (record.variant === "failed") {
      return {
        variant: "failed",
        data: record.data as WatchFailureRecord,
      };
    }
    return {
      variant: "report",
      data: record.data as WatchReportRecord,
    };
  }

  return {
    ...(controller.isolation === undefined
      ? {}
      : { isolation: controller.isolation }),
    nextEvent,
    async nextReport(waitOptions): Promise<WatchReportRecord> {
      const event = await nextEvent(waitOptions);
      if (event.variant === "failed") {
        throw new Error(
          `verule watch round #${String(event.data.sequence)} failed [${event.data.code}]: ${event.data.message}`,
        );
      }
      return event.data;
    },
    close(closeOptions): Promise<ProcessExitSummary> {
      return controller.close(closeOptions?.timeoutMs);
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await controller.close();
    },
  };
}

export type SessionCheckOptions = {
  readonly rule?: string;
  readonly at?: string;
  readonly observe?: "summary" | "detail";
  readonly isolated?: boolean;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type AcceptanceSharedSession = {
  readonly endpoint: string;
  readonly snapshotId: number;
  readonly projects: readonly ProjectSummary[];
  readonly isolation?: IsolationEvidence;
  check(options?: SessionCheckOptions): Promise<CliCheckResult>;
  runCheckCli(options?: SessionCheckOptions): Promise<{
    readonly status: number;
    readonly stdout: string;
    readonly stderr: string;
    readonly isolation?: IsolationEvidence;
  }>;
  close(options?: { readonly timeoutMs?: number }): Promise<ProcessExitSummary>;
  [Symbol.asyncDispose](): Promise<void>;
};

export type StartSharedSessionProcessOptions = {
  readonly checkoutDir: string;
  readonly socketPath: string;
  readonly config?: string;
  readonly isolated?: boolean;
  readonly pnpmStoreDir?: string;
  readonly runtimeBinDir?: string;
  readonly blockedPaths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly timeoutMs?: number;
};

/**
 * Starts `verule session --socket <socketPath> --output ndjson`, waits for
 * readiness (or fails immediately on early exit), and serves isolated
 * `verule check --session <endpoint>` calls.
 */
export async function startSharedSessionProcess(
  options: StartSharedSessionProcessOptions,
): Promise<AcceptanceSharedSession> {
  const socketDir = dirname(options.socketPath);
  const args = [
    "session",
    ...(options.config === undefined ? [] : ["--config", options.config]),
    "--socket",
    options.socketPath,
    "--output",
    "ndjson",
  ];
  const spawned = await spawnBareVeruleInHost({
    checkoutDir: options.checkoutDir,
    args,
    isolated: options.isolated ?? true,
    sharedReadWritePaths: [socketDir],
    allowNet: true,
    ...(options.pnpmStoreDir === undefined
      ? {}
      : { pnpmStoreDir: options.pnpmStoreDir }),
    ...(options.runtimeBinDir === undefined
      ? {}
      : { runtimeBinDir: options.runtimeBinDir }),
    ...(options.blockedPaths === undefined
      ? {}
      : { blockedPaths: options.blockedPaths }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });

  const removeLeftoverSocket = (): void => {
    if (existsSync(options.socketPath)) {
      rmSync(options.socketPath, { force: true });
    }
  };
  const controller = new NdjsonProcessController(
    spawned,
    `verule ${args.join(" ")}`,
    removeLeftoverSocket,
  );

  let readyRecord: SessionReadyRecord;
  try {
    const { record } = await controller.waitForRecordFrom(
      0,
      (candidate) =>
        candidate.kind === "record" && candidate.variant === "ready",
      {
        timeoutMs: options.timeoutMs ?? defaultStreamTimeoutMs,
        label: "shared session ready",
      },
    );
    readyRecord = record.data as SessionReadyRecord;
  } catch (error) {
    await controller.close();
    throw error;
  }

  async function runCheckCli(checkOptions: SessionCheckOptions = {}) {
    const checkArgs = [
      "check",
      "--session",
      readyRecord.endpoint,
      ...(checkOptions.rule === undefined ? [] : ["--rule", checkOptions.rule]),
      ...(checkOptions.at === undefined ? [] : ["--at", checkOptions.at]),
      ...(checkOptions.observe === undefined
        ? []
        : ["--observe", checkOptions.observe]),
      "--output",
      "json",
    ];
    return runBareVeruleInHost({
      checkoutDir: options.checkoutDir,
      args: checkArgs,
      isolated: checkOptions.isolated ?? options.isolated ?? true,
      sharedReadWritePaths: [dirname(readyRecord.endpoint)],
      allowNet: true,
      ...(options.pnpmStoreDir === undefined
        ? {}
        : { pnpmStoreDir: options.pnpmStoreDir }),
      ...(options.runtimeBinDir === undefined
        ? {}
        : { runtimeBinDir: options.runtimeBinDir }),
      ...(options.blockedPaths === undefined
        ? {}
        : { blockedPaths: options.blockedPaths }),
      ...(checkOptions.timeoutMs === undefined
        ? {}
        : { timeoutMs: checkOptions.timeoutMs }),
      ...((checkOptions.env ?? options.env) === undefined
        ? {}
        : { env: checkOptions.env ?? options.env }),
    });
  }

  return {
    endpoint: readyRecord.endpoint,
    snapshotId: readyRecord.snapshotId,
    projects: readyRecord.projects,
    ...(controller.isolation === undefined
      ? {}
      : { isolation: controller.isolation }),
    async check(checkOptions): Promise<CliCheckResult> {
      const outcome = await runCheckCli(checkOptions);
      return parseCheckJsonResult(outcome);
    },
    runCheckCli,
    close(closeOptions): Promise<ProcessExitSummary> {
      return controller.close(closeOptions?.timeoutMs);
    },
    async [Symbol.asyncDispose](): Promise<void> {
      await controller.close();
    },
  };
}
