import { runCli } from "../../src/main.ts";

export const TEST_CLI_IDENTITY = {
  commandName: "verule",
  version: "0.0.0",
} as const;

export type CapturedCliResult = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CapturedCliJsonResult<TEnvelope = unknown> = CapturedCliResult & {
  readonly envelope: TEnvelope;
};

/**
 * Invokes `runCli` in-process and captures `stdout`, `stderr`, and exit status.
 */
export async function captureCli(
  argv: readonly string[],
  cwd?: string,
): Promise<CapturedCliResult> {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity: TEST_CLI_IDENTITY,
    argv: ["node", "verule", ...argv],
    ...(cwd !== undefined ? { cwd } : {}),
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

/**
 * Invokes `runCli` and parses the JSON envelope from `stderr` (exit 2) or `stdout`.
 */
export async function captureCliJson<TEnvelope = unknown>(
  argv: readonly string[],
  cwd?: string,
): Promise<CapturedCliJsonResult<TEnvelope>> {
  const result = await captureCli(argv, cwd);
  const raw = result.status === 2 ? result.stderr : result.stdout;
  return {
    ...result,
    envelope: JSON.parse(raw) as TEnvelope,
  };
}

/**
 * Buffers NDJSON `runCli` stream output and lets tests await matching records.
 */
export function createNdjsonStreamHarness<TRecord>() {
  const records: TRecord[] = [];
  let buffer = "";
  let stderr = "";
  let waiters: (() => void)[] = [];

  return {
    records,
    getStderr: (): string => stderr,
    write: ({
      destination,
      chunk,
    }: {
      readonly destination: "stdout" | "stderr";
      readonly chunk: string;
    }): void => {
      if (destination === "stderr") {
        stderr += chunk;
        return;
      }
      buffer += chunk;
      while (true) {
        const idx = buffer.indexOf("\n");
        if (idx === -1) break;
        const raw = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (raw.length > 0) {
          records.push(JSON.parse(raw) as TRecord);
          const pending = waiters;
          waiters = [];
          for (const wake of pending) wake();
        }
      }
    },
    waitFor: async (
      predicate: (record: TRecord) => boolean,
      timeoutMs = 10_000,
    ): Promise<TRecord> => {
      const deadline = Date.now() + timeoutMs;
      let cursor = 0;
      while (true) {
        while (cursor < records.length) {
          const item = records[cursor]!;
          cursor += 1;
          if (predicate(item)) return item;
        }
        if (Date.now() >= deadline) {
          throw new Error(
            `Timed out waiting for stream record. Records=${JSON.stringify(records)} stderr=${stderr}`,
          );
        }
        await new Promise<void>((resolveWait) => {
          const timer = setTimeout(resolveWait, 50);
          waiters.push(() => {
            clearTimeout(timer);
            resolveWait();
          });
        });
      }
    },
  };
}
