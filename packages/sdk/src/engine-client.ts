import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";

import { engineExecutablePath } from "@verule/engine/binary";

import { VeruleExecutionError, type VeruleErrorCode } from "./types.ts";

type RpcResponse =
  | {
      readonly id: number;
      readonly ok: true;
      readonly result: unknown;
    }
  | {
      readonly id: number;
      readonly ok: false;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };

type PendingCall = {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
};

function mapEngineErrorCode(code: string): VeruleErrorCode {
  switch (code) {
    case "PROJECT_LOAD_ERROR":
    case "STALE_REFERENCE":
    case "CROSS_PROJECT_REFERENCE":
    case "STALE_SNAPSHOT":
      return code;
    default:
      return "ENGINE_ERROR";
  }
}

/** Manages a single `verule-engine serve --stdio` subprocess over NDJSON RPC. */
export class EngineClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #lines: ReadlineInterface;
  readonly #pending = new Map<number, PendingCall>();
  readonly #stderrChunks: string[] = [];
  #nextId = 1;
  #closed = false;

  constructor() {
    this.#child = spawn(engineExecutablePath, ["serve", "--stdio"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.#lines = createInterface({
      input: this.#child.stdout,
      crlfDelay: Infinity,
    });

    this.#child.stderr.setEncoding("utf8");
    this.#child.stderr.on("data", (chunk: string) => {
      this.#stderrChunks.push(chunk);
    });

    this.#lines.on("line", (line) => {
      if (line.trim() === "") return;
      let parsed: RpcResponse;
      try {
        parsed = JSON.parse(line) as RpcResponse;
      } catch (err) {
        this.#failAll(
          new VeruleExecutionError(
            "ENGINE_ERROR",
            `Malformed engine response: ${String(err)}`,
          ),
        );
        return;
      }

      const call = this.#pending.get(parsed.id);
      if (!call) return;
      this.#pending.delete(parsed.id);

      if (parsed.ok) {
        call.resolve(parsed.result);
      } else {
        call.reject(
          new VeruleExecutionError(
            mapEngineErrorCode(parsed.error.code),
            parsed.error.message,
          ),
        );
      }
    });

    this.#child.on("error", (err) => {
      this.#failAll(
        new VeruleExecutionError(
          "ENGINE_ERROR",
          `Failed to start analysis engine: ${err.message}`,
          {
            cause: err,
          },
        ),
      );
    });

    this.#child.on("exit", (code, signal) => {
      if (!this.#closed || this.#pending.size > 0) {
        const stderrText = this.#stderrChunks.join("").trim();
        const detail = stderrText !== "" ? `: ${stderrText}` : "";
        this.#failAll(
          new VeruleExecutionError(
            "ENGINE_ERROR",
            `Analysis engine exited unexpectedly (code=${String(code)}, signal=${String(signal)})${detail}`,
          ),
        );
      }
    });
  }

  #failAll(error: VeruleExecutionError): void {
    for (const pending of this.#pending.values()) {
      pending.reject(error);
    }
    this.#pending.clear();
  }

  request<T>(method: string, params: Record<string, unknown>): Promise<T> {
    if (this.#closed) {
      return Promise.reject(
        new VeruleExecutionError(
          "SESSION_CLOSED",
          "Analysis engine session is closed.",
        ),
      );
    }

    const id = this.#nextId++;
    const line = `${JSON.stringify({ id, method, params })}\n`;

    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
      });

      this.#child.stdin.write(line, "utf8", (err) => {
        if (err) {
          this.#pending.delete(id);
          reject(
            new VeruleExecutionError(
              "ENGINE_ERROR",
              `Failed to write request to analysis engine: ${err.message}`,
              { cause: err },
            ),
          );
        }
      });
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#lines.close();

    if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.#child.kill("SIGKILL");
        resolve();
      }, 3_000);
      timer.unref();

      this.#child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      this.#child.stdin.end();
    });
  }
}
