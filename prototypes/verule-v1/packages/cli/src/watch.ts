import { randomUUID } from "node:crypto";
import {
  existsSync,
  readdirSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Worker } from "node:worker_threads";

import type { AnalysisResult, Inputs, Request, Round } from "./analysis.ts";

const skippedDirectories = new Set([".git", "node_modules", ".turbo"]);
const sourceFile = /\.(?:[cm]?[jt]sx?|json)$/iu;
const inside = (root: string, file: string) => {
  const name = relative(root, file);
  return name !== ".." && !name.startsWith(`..${sep}`) && !name.startsWith(sep);
};

class Changes {
  private readonly directories = new Map<string, FSWatcher>();
  private explicit = new Set<string>();
  private root = "";
  private readonly pending = new Set<string>();
  private wake?: () => void;
  private error?: Error;

  private register(directory: string, recursive: boolean) {
    if (this.directories.has(directory)) return;
    const watcher = watch(directory, (_, name) => {
      if (name === null) {
        this.pending.add(directory);
      } else {
        const file = join(directory, name);
        const isTracked = this.explicit.has(file);
        const inProject = inside(this.root, file);
        if (skippedDirectories.has(name) && !isTracked) return;
        try {
          if (
            inProject &&
            statSync(file, { throwIfNoEntry: false })?.isDirectory()
          ) {
            this.register(file, true);
          } else if (
            !isTracked &&
            !this.directories.has(file) &&
            !(inProject && sourceFile.test(name))
          ) {
            // If an imported path is missing, its nearest existing ancestor is watched.
            if (![...this.explicit].some((tracked) => inside(file, tracked)))
              return;
          }
          if (!existsSync(file) && this.directories.has(file)) this.drop(file);
        } catch (error) {
          this.error =
            error instanceof Error ? error : new Error(String(error));
        }
        this.pending.add(file);
      }
      this.wake?.();
    });
    watcher.on("error", (error) => {
      this.error = error;
      this.wake?.();
    });
    this.directories.set(directory, watcher);
    if (recursive) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (entry.isDirectory() && !skippedDirectories.has(entry.name)) {
          this.register(join(directory, entry.name), true);
        }
      }
    }
  }

  private drop(directory: string) {
    for (const [path, watcher] of this.directories) {
      if (inside(directory, path)) {
        watcher.close();
        this.directories.delete(path);
      }
    }
  }

  configure(configFile: string, inputs?: Inputs) {
    this.explicit = new Set([
      configFile,
      ...(inputs?.configFiles ?? []),
      ...(inputs?.sources ?? []),
    ]);
    if (inputs?.tsconfig) this.explicit.add(inputs.tsconfig);
    const newRoot = dirname(inputs?.tsconfig ?? configFile);
    if (newRoot !== this.root) {
      for (const watcher of this.directories.values()) watcher.close();
      this.directories.clear();
      this.root = newRoot;
      if (existsSync(newRoot)) this.register(newRoot, true);
    }
    const extra = new Set<string>();
    for (const file of this.explicit) {
      if (inside(this.root, file) && this.directories.has(dirname(file)))
        continue;
      let directory = dirname(file);
      while (!existsSync(directory) && dirname(directory) !== directory)
        directory = dirname(directory);
      extra.add(directory);
      this.register(directory, false);
    }
    for (const [directory, watcher] of this.directories) {
      if (!inside(this.root, directory) && !extra.has(directory)) {
        watcher.close();
        this.directories.delete(directory);
      }
    }
  }

  get busy() {
    if (this.error) throw this.error;
    return this.pending.size > 0;
  }

  async next(signal: AbortSignal) {
    if (!signal.aborted && !this.busy) {
      const { promise, resolve: done } = Promise.withResolvers<void>();
      const wake = () => done();
      this.wake = wake;
      signal.addEventListener("abort", wake, { once: true });
      try {
        await promise;
      } finally {
        signal.removeEventListener("abort", wake);
      }
    }
    if (signal.aborted) return [];
    // Editors can replace a file through a rename followed by one or more writes.
    await delay(20);
    if (this.error) throw this.error;
    const files = [...this.pending];
    this.pending.clear();
    return files;
  }

  close() {
    for (const watcher of this.directories.values()) watcher.close();
    this.directories.clear();
  }
}

class AnalysisWorker {
  private readonly worker = new Worker(
    new URL(
      import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
      import.meta.url,
    ),
  );
  private readonly exited: Promise<void>;
  private stopped = false;
  private failure?: Error;

  constructor() {
    this.worker.on("error", (error: Error) => {
      this.failure = error;
    });
    this.exited = new Promise((done) => {
      this.worker.once("exit", () => {
        this.stopped = true;
        done();
      });
    });
  }

  async check(request: Request) {
    if (this.stopped)
      throw this.failure ?? new Error("Analysis worker stopped.");
    const {
      promise,
      resolve: receive,
      reject,
    } = Promise.withResolvers<AnalysisResult>();
    const stopped = () =>
      reject(this.failure ?? new Error("Analysis worker stopped."));
    this.worker.once("message", receive);
    this.worker.once("exit", stopped);
    try {
      this.worker.postMessage(request);
      return await promise;
    } finally {
      this.worker.off("message", receive);
      this.worker.off("exit", stopped);
    }
  }

  async close() {
    if (!this.stopped) this.worker.postMessage("close");
    await this.exited;
  }
}

export async function* watchProject(
  configFile: string,
  signal: AbortSignal,
): AsyncGenerator<Round> {
  const changes = new Changes();
  let worker: AnalysisWorker | undefined;
  let changedFiles: string[] = [];
  const sessionId = randomUUID();
  let version = 0;
  try {
    changes.configure(configFile);
    while (!signal.aborted) {
      worker ??= new AnalysisWorker();
      const result = await worker.check({
        configFile,
        version: `${sessionId}/${++version}`,
        changedFiles,
      });
      changes.configure(configFile, result);
      if (!signal.aborted && !changes.busy) yield result.round;
      changedFiles = await changes.next(signal);
      const configFiles = new Set([
        configFile,
        ...result.configFiles,
        ...(result.tsconfig ? [result.tsconfig] : []),
      ]);
      if (
        "failure" in result.round ||
        changedFiles.some(
          (file) =>
            configFiles.has(file) ||
            !sourceFile.test(file) ||
            file.endsWith(".json"),
        )
      ) {
        await worker.close();
        worker = undefined;
        changedFiles = [];
      }
    }
  } finally {
    changes.close();
    await worker?.close();
  }
}
