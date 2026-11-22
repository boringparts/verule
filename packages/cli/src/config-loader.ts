import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  VeruleExecutionError,
  defineConfig,
  type NormalizedVeruleConfig,
} from "@verule/sdk";

const DEFAULT_CONFIG_CANDIDATES = [
  "verule.config.ts",
  "verule.config.mts",
  "verule.config.mjs",
  "verule.config.js",
] as const;

let nextReloadGeneration = 1;

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

  const hook = registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      const fromReloadedGraph =
        typeof context.parentURL === "string" &&
        context.parentURL.includes(reloadMarker);
      if (
        fromReloadedGraph &&
        isLocalImportSpecifier(specifier) &&
        resolved.url.startsWith("file://") &&
        !resolved.url.includes("/node_modules/")
      ) {
        const cleanUrl = resolved.url.split("?")[0]!;
        try {
          trackedFiles.add(fileURLToPath(cleanUrl));
        } catch {
          // Ignore non-file paths.
        }
        return {
          ...resolved,
          url: `${cleanUrl}?${reloadMarker}`,
        };
      }
      return resolved;
    },
  });

  let loaded: unknown;
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
