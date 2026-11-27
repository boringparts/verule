import {
  createAdditionalInputRegistry as createTssaeAdditionalInputRegistry,
  createScopedAdditionalInputRegistrar as createTssaeScopedAdditionalInputRegistrar,
  type AdditionalInputEntry,
  type AdditionalInputRegistrar,
  type AdditionalInputRegistry,
  type AdditionalInputSource,
  type ScopedAdditionalInputRegistrar,
} from "tssae";

import { VeruleExecutionError, toVeruleError } from "./types.ts";

export type {
  AdditionalInputEntry,
  AdditionalInputRegistrar,
  AdditionalInputRegistry,
  AdditionalInputSource,
  ScopedAdditionalInputRegistrar,
};

/** Validates config-level `additionalInputs` paths without performing filesystem I/O. */
export function validateAdditionalInputPaths(
  paths: readonly string[] | undefined,
): readonly string[] {
  if (paths === undefined) {
    return [];
  }
  const validated: string[] = [];
  for (const rawPath of paths) {
    if (typeof rawPath !== "string" || rawPath.trim() === "") {
      throw new VeruleExecutionError(
        "INVALID_CONFIG",
        "Additional input path must be a non-empty string.",
      );
    }
    validated.push(rawPath);
  }
  return validated;
}

/**
 * Wraps `tssae`'s `createAdditionalInputRegistry` so registry validation and read
 * errors surface as `VeruleExecutionError` matching Verule's error contract.
 */
export function createAdditionalInputRegistry(options: {
  readonly cwd: string;
}): AdditionalInputRegistry {
  const inner = createTssaeAdditionalInputRegistry(options);

  return {
    cwd: inner.cwd,
    registerAdditionalInput(filePath, source) {
      try {
        return inner.registerAdditionalInput(filePath, source);
      } catch (err) {
        throw toVeruleError(err, "INVALID_CONFIG");
      }
    },
    readAdditionalInput(filePath, source) {
      try {
        return inner.readAdditionalInput(filePath, source);
      } catch (err) {
        const mapped = toVeruleError(err, "RULE_EXECUTION_ERROR");
        if (mapped.message.startsWith("Failed to read additional input ")) {
          throw new VeruleExecutionError(
            "RULE_EXECUTION_ERROR",
            mapped.message,
            {
              cause: err,
            },
          );
        }
        throw mapped;
      }
    },
    listAdditionalInputs: () => inner.listAdditionalInputs(),
    getTrackedAbsolutePaths: () => inner.getTrackedAbsolutePaths(),
    refresh: () => inner.refresh(),
    resolveAbsolutePath(filePath) {
      try {
        return inner.resolveAbsolutePath(filePath);
      } catch (err) {
        throw toVeruleError(err, "INVALID_CONFIG");
      }
    },
  };
}

/** Binds an `AdditionalInputRegistrar` to a fixed rule or summary source tag. */
export function createScopedAdditionalInputRegistrar(
  registrar: AdditionalInputRegistrar,
  source: AdditionalInputSource,
): ScopedAdditionalInputRegistrar {
  try {
    return createTssaeScopedAdditionalInputRegistrar(registrar, source);
  } catch (err) {
    throw toVeruleError(err, "INVALID_CONFIG");
  }
}
