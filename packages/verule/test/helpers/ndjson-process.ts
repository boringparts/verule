import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable, Writable } from "node:stream";

export type NdjsonRecord = Record<string, unknown>;

export type SpawnNdjsonProcessOptions = {
  readonly command?: string;
  readonly cwd: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly defaultTimeoutMs?: number;
};

export type NdjsonProcessSession = {
  readonly records: readonly NdjsonRecord[];
  waitForRecord(
    predicate: (item: NdjsonRecord) => boolean,
    options?: { readonly timeoutMs?: number },
  ): Promise<NdjsonRecord>;
  stopWithSigint(): Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
    readonly stderr: string;
  }>;
  dispose(): void;
  [Symbol.dispose](): void;
};

const defaultRecordTimeoutMs = 10_000;

/**
 * Spawns a child process that emits newline-delimited JSON records on stdout.
 * Pending `waitForRecord` calls reject immediately if the child exits before
 * emitting a matching record instead of hanging until timeout.
 */
export function spawnNdjsonProcess(
  entry: string,
  args: readonly string[],
  cwdOrOptions: string | SpawnNdjsonProcessOptions,
): NdjsonProcessSession {
  const options: SpawnNdjsonProcessOptions =
    typeof cwdOrOptions === "string" ? { cwd: cwdOrOptions } : cwdOrOptions;
  const command = options.command ?? process.execPath;
  const defaultTimeoutMs = options.defaultTimeoutMs ?? defaultRecordTimeoutMs;

  const child: ChildProcessByStdio<Writable, Readable, Readable> = spawn(
    command,
    [entry, ...args],
    {
      cwd: options.cwd,
      ...(options.env === undefined ? {} : { env: options.env }),
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const records: NdjsonRecord[] = [];
  const waiters = new Set<() => void>();
  let stderr = "";
  let buffer = "";
  let stdoutEnded = false;
  let stderrEnded = false;
  let spawnError: Error | undefined;
  let exitState:
    | { readonly code: number | null; readonly signal: NodeJS.Signals | null }
    | undefined;
  let exitGraceTimer: NodeJS.Timeout | undefined;

  const notifyWaiters = (): void => {
    for (const wake of Array.from(waiters)) {
      wake();
    }
  };

  const pushLine = (line: string): void => {
    try {
      const parsed: unknown = JSON.parse(line);
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        !Array.isArray(parsed)
      ) {
        records.push(parsed as NdjsonRecord);
      } else {
        records.push({ kind: "unparsed", raw: line });
      }
    } catch {
      records.push({ kind: "unparsed", raw: line });
    }
  };

  const drainStdoutLines = (): void => {
    while (true) {
      const idx = buffer.indexOf("\n");
      if (idx === -1) {
        return;
      }
      const line = buffer.slice(0, idx).trim();
      buffer = buffer.slice(idx + 1);
      if (line.length > 0) {
        pushLine(line);
      }
    }
  };

  const flushRemainder = (): void => {
    const remainder = buffer.trim();
    buffer = "";
    if (remainder.length > 0) {
      pushLine(remainder);
    }
  };

  const closePromise = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolveClose) => {
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      drainStdoutLines();
      notifyWaiters();
    });
    child.stdout.once("end", () => {
      stdoutEnded = true;
      flushRemainder();
      notifyWaiters();
    });

    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.stderr.once("end", () => {
      stderrEnded = true;
      notifyWaiters();
    });

    child.once("error", (error) => {
      spawnError = error;
      notifyWaiters();
      if (exitState === undefined) {
        exitState = { code: null, signal: null };
      }
      resolveClose(exitState);
    });

    child.once("exit", (code, signal) => {
      exitState = { code, signal };
      if (stdoutEnded && stderrEnded) {
        notifyWaiters();
      } else {
        exitGraceTimer = setTimeout(() => {
          exitGraceTimer = undefined;
          notifyWaiters();
        }, 50);
        exitGraceTimer.unref();
      }
    });

    child.once("close", (code, signal) => {
      stdoutEnded = true;
      stderrEnded = true;
      if (exitGraceTimer !== undefined) {
        clearTimeout(exitGraceTimer);
        exitGraceTimer = undefined;
      }
      flushRemainder();
      if (exitState === undefined) {
        exitState = { code, signal };
      }
      notifyWaiters();
      resolveClose(exitState);
    });
  });

  const dispose = (): void => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
    }
  };

  return {
    records,
    async waitForRecord(predicate, waitOptions = {}) {
      const timeoutMs = waitOptions.timeoutMs ?? defaultTimeoutMs;
      const deadline = Date.now() + timeoutMs;
      let cursor = 0;

      while (true) {
        while (cursor < records.length) {
          const item = records[cursor]!;
          cursor += 1;
          if (predicate(item)) {
            return item;
          }
        }

        if (spawnError !== undefined) {
          throw new Error(
            `NDJSON process failed before matching record: ${spawnError.message}. Records=${JSON.stringify(records)} stderr=${stderr}`,
          );
        }

        if (
          exitState !== undefined &&
          ((stdoutEnded && stderrEnded) || exitGraceTimer === undefined)
        ) {
          throw new Error(
            `NDJSON process exited early (code=${String(exitState.code)}, signal=${String(exitState.signal)}) before matching record. Records=${JSON.stringify(records)} stderr=${stderr}`,
          );
        }

        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new Error(
            `Timed out waiting for NDJSON record after ${String(timeoutMs)}ms. Records=${JSON.stringify(records)} stderr=${stderr}`,
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
            waiters.delete(finish);
            resolveWait();
          };
          const timer = setTimeout(finish, Math.min(100, remainingMs));
          waiters.add(finish);
        });
      }
    },
    async stopWithSigint() {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGINT");
      }
      const result = await closePromise;
      return { ...result, stderr };
    },
    dispose,
    [Symbol.dispose]: dispose,
  };
}
