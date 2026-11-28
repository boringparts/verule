import { existsSync, realpathSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  VeruleExecutionError,
  defineConfig,
  type NormalizedVeruleConfig,
} from "./index.ts";

const DEFAULT_CONFIG_CANDIDATES = [
  "verule.config.ts",
  "verule.config.mts",
  "verule.config.mjs",
  "verule.config.js",
] as const;

// Property-typed view avoids `unbound-method` while preserving the exact function
// reference for restoration (whereas `.bind(process)` would allocate a wrapper).
const processEmitWarningHost: { emitWarning: typeof process.emitWarning } =
  process;

let nextReloadGeneration = 1;
let activeConfigImports = 0;
let savedEmitWarning: typeof process.emitWarning | undefined;

function isTypeStrippingWarning(
  warning: string | Error,
  typeOrOptions?: unknown,
): boolean {
  const warningName =
    typeof typeOrOptions === "string"
      ? typeOrOptions
      : typeof typeOrOptions === "object" &&
          typeOrOptions !== null &&
          "type" in typeOrOptions
        ? typeOrOptions.type
        : typeof warning === "object"
          ? warning.name
          : undefined;
  const warningMessage =
    typeof warning === "string" ? warning : warning.message;
  return (
    warningName === "ExperimentalWarning" &&
    warningMessage.includes("Type Stripping")
  );
}

// Node 24.0.0 emits `ExperimentalWarning: Type Stripping` to stderr on the first
// `.ts` import, which corrupts CLI JSON envelopes and NDJSON streams. We suppress
// only that warning across dynamic config imports using an active-import refcount
// so overlapping loads share one hook and restore the exact original handler on exit.
const suppressTypeStrippingWarning: typeof process.emitWarning = function (
  warning,
  ...args
) {
  if (isTypeStrippingWarning(warning, args[0])) {
    return;
  }
  if (savedEmitWarning !== undefined) {
    Reflect.apply(savedEmitWarning, process, [warning, ...args]);
  }
};

export type LoadedProjectConfig = {
  readonly configPath: string;
  readonly config: NormalizedVeruleConfig;
  readonly watchFiles: readonly string[];
};

export function resolveConfigPath(
  cwd: string,
  explicitConfig?: string,
): string {
  if (explicitConfig !== undefined) {
    const resolved = resolve(cwd, explicitConfig);
    if (!existsSync(resolved)) {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        `Configuration file not found: ${resolved}`,
      );
    }
    return resolved;
  }

  for (const candidate of DEFAULT_CONFIG_CANDIDATES) {
    const resolved = resolve(cwd, candidate);
    if (existsSync(resolved)) {
      return resolved;
    }
  }

  throw new VeruleExecutionError(
    "INVALID_CONFIG",
    `No Verule configuration file found in ${cwd}.`,
  );
}

function isLocalImportSpecifier(specifier: string): boolean {
  return (
    specifier.startsWith("./") ||
    specifier.startsWith("../") ||
    specifier.startsWith("/") ||
    specifier.startsWith("file://")
  );
}

function hasPreserveSymlinksFlag(): boolean {
  if (process.execArgv.includes("--preserve-symlinks")) {
    return true;
  }
  const nodeOptions = process.env.NODE_OPTIONS?.trim();
  if (!nodeOptions) {
    return false;
  }
  return nodeOptions.split(/\s+/u).includes("--preserve-symlinks");
}

function stripUrlQuery(url: string): {
  readonly baseUrl: string;
  readonly query: string;
} {
  const queryIndex = url.indexOf("?");
  return queryIndex === -1
    ? { baseUrl: url, query: "" }
    : { baseUrl: url.slice(0, queryIndex), query: url.slice(queryIndex) };
}

function trackNonNodeModulesFileUrl(
  trackedFiles: Set<string>,
  fileUrl: string,
  requireExisting = false,
): void {
  if (!fileUrl.startsWith("file://") || fileUrl.includes("/node_modules/")) {
    return;
  }
  try {
    const filePath = fileURLToPath(fileUrl);
    if (!requireExisting || existsSync(filePath)) {
      trackedFiles.add(filePath);
    }
  } catch {
    // Ignore non-file paths.
  }
}

/**
 * Dynamically imports a Verule configuration file with ESM cache-busting for the config
 * and its local relative module graph, returning the validated config and dependency paths.
 */
export async function loadProjectConfigWithDependencies(
  cwd: string,
  explicitConfig?: string,
): Promise<LoadedProjectConfig> {
  const configPath = resolveConfigPath(cwd, explicitConfig);
  const configUrl = pathToFileURL(configPath).href;
  const reloadToken = String(nextReloadGeneration++);
  const reloadMarker = `verule-reload=${reloadToken}`;
  const trackedFiles = new Set<string>([configPath]);

  const preserveSymlinks = hasPreserveSymlinksFlag();
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (!resolved.url.startsWith("file://")) {
        return resolved;
      }
      const { baseUrl: rawUrl, query: existingQuery } = stripUrlQuery(
        resolved.url,
      );
      // In Node 24.0.0, `nextResolve` from a symlinked `cli.js` entry can return
      // an unresolved symlink path, preventing pnpm's isolated `node_modules` from
      // resolving transitive dependencies such as `tssae`. Canonicalize `file://`
      // URLs via `realpathSync` unless `--preserve-symlinks` is explicitly active.
      let canonicalUrl = rawUrl;
      if (!preserveSymlinks) {
        try {
          canonicalUrl = pathToFileURL(
            realpathSync(fileURLToPath(rawUrl)),
          ).href;
        } catch {
          // Keep original URL if the target cannot be realpathed.
        }
      }
      const fromReloadedGraph =
        typeof context.parentURL === "string" &&
        context.parentURL.includes(reloadMarker);
      if (fromReloadedGraph && isLocalImportSpecifier(specifier)) {
        // Track both the unresolved local path (for symlink retargeting) and
        // canonical realpath (for target edits) outside `node_modules` so
        // `verule watch` reloads on either change.
        try {
          const { baseUrl: unresolvedUrl } = stripUrlQuery(
            new URL(specifier, context.parentURL).href,
          );
          trackNonNodeModulesFileUrl(trackedFiles, unresolvedUrl, true);
        } catch {
          // Ignore malformed specifiers.
        }
        trackNonNodeModulesFileUrl(trackedFiles, rawUrl);
        if (!canonicalUrl.includes("/node_modules/")) {
          trackNonNodeModulesFileUrl(trackedFiles, canonicalUrl);
          return {
            ...resolved,
            url: `${canonicalUrl}?${reloadMarker}`,
          };
        }
      }
      const restoredUrl = `${canonicalUrl}${existingQuery}`;
      return restoredUrl === resolved.url
        ? resolved
        : { ...resolved, url: restoredUrl };
    },
  });

  let loaded: unknown;
  if (activeConfigImports === 0) {
    savedEmitWarning = processEmitWarningHost.emitWarning;
    processEmitWarningHost.emitWarning = suppressTypeStrippingWarning;
  }
  activeConfigImports += 1;
  try {
    loaded = await import(`${configUrl}?${reloadMarker}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Failed to load Verule configuration "${configPath}": ${message}`,
      { cause: err },
    );
  } finally {
    activeConfigImports -= 1;
    if (
      activeConfigImports === 0 &&
      savedEmitWarning !== undefined &&
      processEmitWarningHost.emitWarning === suppressTypeStrippingWarning
    ) {
      processEmitWarningHost.emitWarning = savedEmitWarning;
      savedEmitWarning = undefined;
    }
    hook.deregister();
  }

  if (typeof loaded !== "object" || loaded === null || !("default" in loaded)) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Verule configuration "${configPath}" must export a default configuration object.`,
    );
  }

  const rawDefault = (loaded as { readonly default: unknown }).default;
  if (typeof rawDefault !== "object" || rawDefault === null) {
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Default export of "${configPath}" must be a configuration object.`,
    );
  }

  return {
    configPath,
    config: defineConfig(rawDefault),
    watchFiles: [...trackedFiles],
  };
}

/** Dynamically imports and validates a project configuration file. */
export async function loadProjectConfig(
  cwd: string,
  explicitConfig?: string,
): Promise<NormalizedVeruleConfig> {
  const loaded = await loadProjectConfigWithDependencies(cwd, explicitConfig);
  return loaded.config;
}
