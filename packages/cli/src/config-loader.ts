import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

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

/** Dynamically imports and validates a project configuration file. */
export async function loadProjectConfig(
  cwd: string,
  explicitConfig?: string,
): Promise<NormalizedVeruleConfig> {
  const configPath = resolveConfigPath(cwd, explicitConfig);
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(configPath).href);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new VeruleExecutionError(
      "INVALID_CONFIG",
      `Failed to load Verule configuration "${configPath}": ${message}`,
      { cause: err },
    );
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

  return defineConfig(rawDefault);
}
