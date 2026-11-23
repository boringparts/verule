import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { validateAdapters, type LibraryAdapter } from "./facts.ts";
import { VeruleExecutionError } from "./types.ts";

export type NativeAdapterPackage = {
  readonly packageName: string;
  readonly libraryPath: string;
};

export type ResolvedNativeAdapterPackages = {
  readonly adapters: readonly LibraryAdapter[];
  readonly nativeAdapters: readonly NativeAdapterPackage[];
};

type PackageMetadata = {
  readonly name?: unknown;
  readonly verule?: {
    readonly native?: Readonly<Record<string, unknown>>;
  };
};

function invalidPackage(
  packageName: string,
  reason: string,
): VeruleExecutionError {
  return new VeruleExecutionError(
    "INVALID_CONFIG",
    `Failed to load configured adapter package "${packageName}": ${reason}`,
  );
}

function findPackageRoot(
  entryPath: string,
  packageName: string,
): { readonly root: string; readonly metadata: PackageMetadata } {
  let current = dirname(entryPath);
  while (true) {
    try {
      const metadata = JSON.parse(
        readFileSync(resolve(current, "package.json"), "utf8"),
      ) as PackageMetadata;
      if (metadata.name === packageName) {
        return {
          root: realpathSync.native(current),
          metadata,
        };
      }
    } catch {
      // Continue walking until the owning package manifest is found.
    }
    const parent = dirname(current);
    if (parent === current) {
      throw invalidPackage(
        packageName,
        `could not find its installed package.json above ${entryPath}`,
      );
    }
    current = parent;
  }
}

function validatePackageAdapter(
  value: unknown,
  packageName: string,
): LibraryAdapter {
  try {
    return validateAdapters([value as LibraryAdapter])[0]!;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw invalidPackage(
      packageName,
      `invalid JavaScript adapter bridge: ${detail}`,
    );
  }
}

function selectLibraryAdapter(
  moduleExports: Record<string, unknown>,
  packageName: string,
): LibraryAdapter {
  const defaultAdapter = moduleExports.default ?? moduleExports.adapter;
  if (isLibraryAdapter(defaultAdapter)) {
    return validatePackageAdapter(defaultAdapter, packageName);
  }

  const candidates = Object.values(moduleExports).filter(isLibraryAdapter);
  if (candidates.length === 1) {
    return validatePackageAdapter(candidates[0], packageName);
  }
  throw invalidPackage(
    packageName,
    'its ESM entry must export one LibraryAdapter as "default" or "adapter"',
  );
}

function isLibraryAdapter(value: unknown): value is LibraryAdapter {
  return (
    typeof value === "object" &&
    value !== null &&
    "id" in value &&
    "provides" in value &&
    Array.isArray(value.provides)
  );
}

/**
 * Resolves the package's public `./verule-adapter` export from the config directory,
 * imports that ESM bridge, and checks that its installed package ships a Linux x64 library.
 */
export async function resolveNativeAdapterPackages(
  packageNames: readonly string[],
  resolutionRoot: string,
): Promise<ResolvedNativeAdapterPackages> {
  if (packageNames.length === 0) {
    return { adapters: [], nativeAdapters: [] };
  }
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw invalidPackage(
      packageNames.join(", "),
      `prebuilt native adapters are supported on Linux x64; this host is ${process.platform}-${process.arch}`,
    );
  }

  const requireFromConfig = createRequire(
    resolve(resolutionRoot, "__verule_adapter_loader__.cjs"),
  );
  const adapters: LibraryAdapter[] = [];
  const nativeAdapters: NativeAdapterPackage[] = [];
  const packageOwnersByAdapterId = new Map<string, string>();

  for (const packageName of packageNames) {
    let entryPath: string;
    try {
      entryPath = requireFromConfig.resolve(`${packageName}/verule-adapter`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw invalidPackage(packageName, detail);
    }

    const { root, metadata } = findPackageRoot(entryPath, packageName);
    const relativeLibraryPath = metadata.verule?.native?.["linux-x64"];
    if (
      typeof relativeLibraryPath !== "string" ||
      relativeLibraryPath.trim() === ""
    ) {
      throw invalidPackage(
        packageName,
        'package.json must define "verule.native.linux-x64"',
      );
    }
    const libraryPath = resolve(root, relativeLibraryPath);
    if (!existsSync(libraryPath)) {
      throw invalidPackage(
        packageName,
        `native library is missing at ${libraryPath}`,
      );
    }

    let imported: unknown;
    try {
      imported = await import(pathToFileURL(entryPath).href);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw invalidPackage(
        packageName,
        `JavaScript ESM entry failed to load: ${detail}`,
      );
    }
    if (typeof imported !== "object" || imported === null) {
      throw invalidPackage(packageName, "JavaScript ESM entry has no exports");
    }

    const adapter = selectLibraryAdapter(
      imported as Record<string, unknown>,
      packageName,
    );
    const existingPackage = packageOwnersByAdapterId.get(adapter.id);
    if (existingPackage !== undefined) {
      throw invalidPackage(
        packageName,
        `adapter id "${adapter.id}" is already provided by package "${existingPackage}"`,
      );
    }
    packageOwnersByAdapterId.set(adapter.id, packageName);
    adapters.push(adapter);
    nativeAdapters.push({ packageName, libraryPath });
  }

  return { adapters, nativeAdapters };
}
