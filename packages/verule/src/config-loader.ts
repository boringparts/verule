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

// Node 24.0.0 emits ExperimentalWarning to stderr on the first .ts import,
// which corrupts structured `--output json` / `ndjson` CLI output.
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

  const preserveSymlinks = process.execArgv.includes("--preserve-symlinks");
  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      if (!resolved.url.startsWith("file://")) {
        return resolved;
      }
      const queryIndex = resolved.url.indexOf("?");
      const rawUrl =
        queryIndex === -1 ? resolved.url : resolved.url.slice(0, queryIndex);
      const existingQuery =
        queryIndex === -1 ? "" : resolved.url.slice(queryIndex);
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
      if (
        fromReloadedGraph &&
        isLocalImportSpecifier(specifier) &&
        !canonicalUrl.includes("/node_modules/")
      ) {
        try {
          trackedFiles.add(fileURLToPath(canonicalUrl));
        } catch {
          // Ignore non-file paths.
        }
        return {
          ...resolved,
          url: `${canonicalUrl}?${reloadMarker}`,
        };
      }
      const restoredUrl = `${canonicalUrl}${existingQuery}`;
      return restoredUrl === resolved.url
        ? resolved
        : { ...resolved, url: restoredUrl };
    },
  });

  let loaded: unknown;
  if (activeConfigImports === 0) {
    savedEmitWarning = process.emitWarning.bind(process);
    process.emitWarning = suppressTypeStrippingWarning;
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
      process.emitWarning === suppressTypeStrippingWarning
    ) {
      process.emitWarning = savedEmitWarning;
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
