import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
  watch,
  type FSWatcher,
} from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { defineConfig, openSession } from "./session.ts";
import {
  VeruleExecutionError,
  type AnalysisSession,
  type MemoryStats,
  type NormalizedVeruleConfig,
  type RecomputationScope,
  type VeruleErrorCode,
  type WatchEvent,
  type WatchProjectOptions,
} from "./types.ts";

type PendingBatch = {
  readonly paths: readonly string[];
};

function normalizeRelPath(absCwd: string, absPath: string): string {
  return relative(absCwd, absPath).replace(/\\/gu, "/");
}

function normalizeAbsPath(path: string): string {
  return resolve(path).replace(/\\/gu, "/");
}

function isIgnoredRelativePath(relPath: string): boolean {
  const parts = relPath.split("/");
  return parts.includes(".git") || parts.includes("node_modules");
}

function hashFileContent(absPath: string): string | undefined {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile()) return undefined;
    return createHash("sha256").update(readFileSync(absPath)).digest("hex");
  } catch {
    return undefined;
  }
}

function toExecutionErrorInfo(err: unknown): {
  readonly code: VeruleErrorCode;
  readonly message: string;
} {
  if (err instanceof VeruleExecutionError) {
    return { code: err.code, message: err.message };
  }
  return {
    code: "ENGINE_ERROR",
    message: err instanceof Error ? err.message : String(err),
  };
}

function initialRecomputationScope(
  session: AnalysisSession,
): RecomputationScope {
  const files = new Set<string>();
  for (const project of session.projects) {
    for (const file of project.sourceFiles) {
      files.add(file);
    }
  }
  return {
    recomputedProjects: session.projects.map((p) => p.projectId),
    reusedProjects: [],
    recomputedFiles: [...files].toSorted(),
    reusedFiles: [],
    removedFiles: [],
    invalidatedBy: ["initial"],
  };
}

function recordSessionFiles(
  absCwd: string,
  session: AnalysisSession,
  knownFileHashes: Map<string, string>,
): void {
  for (const project of session.projects) {
    const configAbs = normalizeAbsPath(resolve(absCwd, project.configFile));
    const configHash = hashFileContent(configAbs);
    if (configHash !== undefined) {
      knownFileHashes.set(configAbs, configHash);
    }
    for (const relFile of project.sourceFiles) {
      const fileAbs = normalizeAbsPath(resolve(absCwd, relFile));
      const fileHash = hashFileContent(fileAbs);
      if (fileHash !== undefined) {
        knownFileHashes.set(fileAbs, fileHash);
      }
    }
  }
}

function createAbortPromise(signal: AbortSignal | undefined): {
  readonly promise: Promise<void>;
  readonly dispose: () => void;
} {
  if (!signal) {
    return {
      promise: new Promise<void>(() => {}),
      dispose: () => {},
    };
  }
  if (signal.aborted) {
    return {
      promise: Promise.resolve(),
      dispose: () => {},
    };
  }
  let onAbort: (() => void) | undefined;
  const promise = new Promise<void>((resolvePromise) => {
    onAbort = () => resolvePromise();
    signal.addEventListener("abort", onAbort, { once: true });
  });
  return {
    promise,
    dispose: () => {
      if (onAbort) {
        signal.removeEventListener("abort", onAbort);
      }
    },
  };
}

/**
 * Watches a project directory (and any external config dependency files), updating an
 * {@link AnalysisSession} incrementally and yielding a complete report or failure record
 * after each initial check and subsequent save.
 */
export async function* watchProject(
  options: WatchProjectOptions,
): AsyncGenerator<WatchEvent, void, void> {
  const absCwd = resolve(options.cwd);
  const debounceMs = options.debounceMs ?? 50;
  const signal = options.signal;

  let sequence = 0;
  let session: AnalysisSession | undefined;
  let lastConfig: NormalizedVeruleConfig | undefined;
  const configWatchFiles = new Set<string>(
    (options.watchFiles ?? []).map((file) =>
      normalizeAbsPath(resolve(absCwd, file)),
    ),
  );
  const knownFileHashes = new Map<string, string>();
  for (const file of configWatchFiles) {
    const hash = hashFileContent(file);
    if (hash !== undefined) {
      knownFileHashes.set(file, hash);
    }
  }
  const externalWatchers = new Map<string, FSWatcher>();
  let rootWatcher: FSWatcher | undefined;

  const pendingPaths = new Set<string>();
  const batchQueue: PendingBatch[] = [];
  let debounceTimer: ReturnType<typeof setTimeout> | undefined;
  let wakeQueue: (() => void) | undefined;

  function notifyQueue(): void {
    if (wakeQueue) {
      const wake = wakeQueue;
      wakeQueue = undefined;
      wake();
    }
  }

  function flushDebounce(): void {
    debounceTimer = undefined;
    if (pendingPaths.size === 0) return;
    const paths = [...pendingPaths];
    pendingPaths.clear();
    batchQueue.push({ paths });
    notifyQueue();
  }

  function schedulePath(absPath: string): void {
    const normalized = normalizeAbsPath(absPath);
    const rel = normalizeRelPath(absCwd, normalized);
    const isExplicitWatchFile = configWatchFiles.has(normalized);
    if (!isExplicitWatchFile && isIgnoredRelativePath(rel)) {
      return;
    }

    if (existsSync(normalized)) {
      try {
        if (statSync(normalized).isDirectory()) {
          for (const entry of readdirSync(normalized)) {
            const child = normalizeAbsPath(resolve(normalized, entry));
            const childRel = normalizeRelPath(absCwd, child);
            if (!isIgnoredRelativePath(childRel) && existsSync(child)) {
              try {
                if (statSync(child).isFile()) {
                  pendingPaths.add(child);
                }
              } catch {
                // Ignore transient entries during directory scans.
              }
            }
          }
        } else {
          pendingPaths.add(normalized);
        }
      } catch {
        pendingPaths.add(normalized);
      }
    } else {
      pendingPaths.add(normalized);
    }

    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(flushDebounce, debounceMs);
  }

  function syncWatchers(): void {
    if (!rootWatcher && existsSync(absCwd)) {
      rootWatcher = watch(absCwd, { recursive: true }, (_event, filename) => {
        if (typeof filename === "string" && filename.length > 0) {
          schedulePath(resolve(absCwd, filename));
        } else {
          for (const knownPath of knownFileHashes.keys()) {
            schedulePath(knownPath);
          }
        }
      });
    }

    const absCwdNorm = normalizeAbsPath(absCwd);
    const neededDirs = new Set<string>();
    for (const filePath of configWatchFiles) {
      if (filePath !== absCwdNorm && !filePath.startsWith(`${absCwdNorm}/`)) {
        neededDirs.add(normalizeAbsPath(dirname(filePath)));
      }
    }

    for (const [dir, watcher] of externalWatchers) {
      if (!neededDirs.has(dir)) {
        watcher.close();
        externalWatchers.delete(dir);
      }
    }

    for (const dir of neededDirs) {
      if (!externalWatchers.has(dir) && existsSync(dir)) {
        const watcher = watch(dir, (_event, filename) => {
          if (typeof filename === "string" && filename.length > 0) {
            const candidate = normalizeAbsPath(resolve(dir, filename));
            if (configWatchFiles.has(candidate)) {
              schedulePath(candidate);
            }
          } else {
            for (const filePath of configWatchFiles) {
              if (normalizeAbsPath(dirname(filePath)) === dir) {
                schedulePath(filePath);
              }
            }
          }
        });
        externalWatchers.set(dir, watcher);
      }
    }
  }

  async function resolveCurrentConfig(): Promise<NormalizedVeruleConfig> {
    if (options.loadConfig) {
      const loaded = await options.loadConfig();
      if (loaded.watchFiles) {
        configWatchFiles.clear();
        for (const file of loaded.watchFiles) {
          const absFile = normalizeAbsPath(resolve(absCwd, file));
          configWatchFiles.add(absFile);
          const hash = hashFileContent(absFile);
          if (hash !== undefined) {
            knownFileHashes.set(absFile, hash);
          }
        }
      }
      return defineConfig(loaded.config);
    }
    return options.config ? defineConfig(options.config) : defineConfig({});
  }

  async function waitForNextBatch(): Promise<PendingBatch | undefined> {
    if (signal?.aborted) return undefined;
    if (batchQueue.length > 0) return batchQueue.shift();

    const abortHandle = createAbortPromise(signal);
    try {
      await Promise.race([
        new Promise<void>((resolveWait) => {
          wakeQueue = resolveWait;
        }),
        abortHandle.promise,
      ]);
    } finally {
      wakeQueue = undefined;
      abortHandle.dispose();
    }

    if (signal?.aborted) return undefined;
    return batchQueue.shift();
  }

  function classifyBatch(paths: readonly string[]): {
    readonly changed: string[];
    readonly created: string[];
    readonly deleted: string[];
    readonly touchedConfig: boolean;
  } {
    const changed: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    let touchedConfig = false;

    for (const absPath of paths) {
      const rel = normalizeRelPath(absCwd, absPath);
      const wasKnown = knownFileHashes.has(absPath);
      const nextHash = hashFileContent(absPath);

      if (nextHash !== undefined) {
        if (configWatchFiles.has(absPath)) {
          touchedConfig = true;
        }
        knownFileHashes.set(absPath, nextHash);
        if (wasKnown) {
          changed.push(rel);
        } else {
          created.push(rel);
        }
      } else if (wasKnown) {
        if (configWatchFiles.has(absPath)) {
          touchedConfig = true;
        }
        knownFileHashes.delete(absPath);
        deleted.push(rel);
      }
    }

    return { changed, created, deleted, touchedConfig };
  }

  const abortSignalListener = () => notifyQueue();
  signal?.addEventListener("abort", abortSignalListener, { once: true });

  try {
    if (signal?.aborted) return;

    syncWatchers();
    sequence += 1;
    try {
      lastConfig = await resolveCurrentConfig();
      syncWatchers();
      session = await openSession({
        cwd: absCwd,
        config: lastConfig,
        ...(options.observe !== undefined ? { observe: options.observe } : {}),
      });
      recordSessionFiles(absCwd, session, knownFileHashes);
      const report = await session.check();
      const memory: MemoryStats = session.memory;
      yield {
        kind: "report",
        sequence,
        trigger: "initial",
        snapshotId: session.snapshotId,
        report,
        recomputation: initialRecomputationScope(session),
        memory,
      };
    } catch (err) {
      syncWatchers();
      const info = toExecutionErrorInfo(err);
      yield {
        kind: "failed",
        sequence,
        trigger: "initial",
        code: info.code,
        message: info.message,
      };
    }

    while (true) {
      if (signal?.aborted) break;
      const batch = await waitForNextBatch();
      if (!batch) break;

      const classified = classifyBatch(batch.paths);
      if (
        classified.changed.length === 0 &&
        classified.created.length === 0 &&
        classified.deleted.length === 0
      ) {
        continue;
      }

      sequence += 1;
      try {
        let reloadedConfig: NormalizedVeruleConfig | undefined;
        if (classified.touchedConfig || !lastConfig) {
          reloadedConfig = await resolveCurrentConfig();
          lastConfig = reloadedConfig;
          syncWatchers();
        }

        if (!session) {
          session = await openSession({
            cwd: absCwd,
            config: lastConfig,
            ...(options.observe !== undefined
              ? { observe: options.observe }
              : {}),
          });
          recordSessionFiles(absCwd, session, knownFileHashes);
          const report = await session.check();
          yield {
            kind: "report",
            sequence,
            trigger: "change",
            snapshotId: session.snapshotId,
            report,
            recomputation: initialRecomputationScope(session),
            memory: session.memory,
          };
          continue;
        }

        const updateResult = await session.update({
          changed: classified.changed,
          created: classified.created,
          deleted: classified.deleted,
          ...(reloadedConfig !== undefined ? { config: reloadedConfig } : {}),
        });
        recordSessionFiles(absCwd, session, knownFileHashes);
        const report = await session.check();
        yield {
          kind: "report",
          sequence,
          trigger: "change",
          snapshotId: updateResult.snapshotId,
          report,
          recomputation: updateResult.recomputation,
          memory: updateResult.memory,
        };
      } catch (err) {
        syncWatchers();
        const info = toExecutionErrorInfo(err);
        yield {
          kind: "failed",
          sequence,
          trigger: "change",
          code: info.code,
          message: info.message,
        };
      }
    }
  } finally {
    signal?.removeEventListener("abort", abortSignalListener);
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    rootWatcher?.close();
    for (const watcher of externalWatchers.values()) {
      watcher.close();
    }
    externalWatchers.clear();
    if (session) {
      await session.close();
    }
  }
}
