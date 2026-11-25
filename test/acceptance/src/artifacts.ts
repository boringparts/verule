import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const maxTarBufferBytes = 64 * 1024 * 1024;

export const CORE_VERULE_PACKAGES: readonly string[] = [
  "tssae",
  "@boringparts/verule",
];

export type PackedArtifact = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly sha1: string;
  readonly integrity: string;
  readonly manifest: Record<string, unknown>;
  readonly binarySha256?: string;
};

export type PackedArtifactBundle = {
  readonly packDir: string;
  readonly artifacts: readonly PackedArtifact[];
  dispose(): void;
};

export type PackWorkspaceArtifactsOptions = {
  readonly additionalPackages?: readonly string[];
  readonly packDir?: string;
  readonly fromPackDir?: string;
  readonly cwd?: string;
};

type PnpmPackJson = {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
};

type PrepackedEntry = {
  readonly tarballPath: string;
  readonly expectedIntegrity?: string;
};

export function parsePackOutput(stdout: string): PnpmPackJson {
  const parsed: unknown = JSON.parse(stdout);
  const item = Array.isArray(parsed) ? parsed[0] : parsed;
  if (
    typeof item !== "object" ||
    item === null ||
    !("name" in item) ||
    !("version" in item) ||
    !("filename" in item) ||
    typeof item.name !== "string" ||
    typeof item.version !== "string" ||
    typeof item.filename !== "string"
  ) {
    throw new Error(`Unexpected pack --json output: ${stdout}`);
  }
  return {
    name: item.name,
    version: item.version,
    filename: item.filename,
  };
}

async function readTarEntry(
  tarballPath: string,
  entryPath: string,
): Promise<Buffer> {
  const { stdout } = await execFileAsync(
    "tar",
    ["-xOf", tarballPath, entryPath],
    { encoding: "buffer", maxBuffer: maxTarBufferBytes },
  );
  return stdout;
}

export async function inspectTarballArtifact(
  tarballPath: string,
  expectedIntegrity?: string,
): Promise<PackedArtifact> {
  const bytes = readFileSync(tarballPath);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sha1 = createHash("sha1").update(bytes).digest("hex");
  const sha512Integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;

  if (expectedIntegrity !== undefined) {
    const sha256Integrity = `sha256-${createHash("sha256").update(bytes).digest("base64")}`;
    if (
      expectedIntegrity !== sha256Integrity &&
      expectedIntegrity !== sha512Integrity
    ) {
      throw new Error(
        `Integrity mismatch for pre-packed tarball ${tarballPath}: expected ${expectedIntegrity}`,
      );
    }
  }

  const manifestRaw = await readTarEntry(tarballPath, "package/package.json");
  const manifestParsed: unknown = JSON.parse(manifestRaw.toString("utf8"));
  if (
    typeof manifestParsed !== "object" ||
    manifestParsed === null ||
    Array.isArray(manifestParsed)
  ) {
    throw new Error(`Invalid package.json inside ${tarballPath}`);
  }
  const manifest = Object.fromEntries(Object.entries(manifestParsed));
  const name = manifest.name;
  const version = manifest.version;
  if (typeof name !== "string" || typeof version !== "string") {
    throw new Error(
      `Missing name or version in package/package.json inside ${tarballPath}`,
    );
  }

  let binarySha256: string | undefined;
  if (name === "tssae") {
    const executableName =
      process.platform === "win32" ? "tssae-engine.exe" : "tssae-engine";
    const binaryBytes = await readTarEntry(
      tarballPath,
      `package/dist/bin/${executableName}`,
    );
    binarySha256 = createHash("sha256").update(binaryBytes).digest("hex");
  }

  return {
    name,
    version,
    filename: tarballPath,
    size: bytes.length,
    sha256,
    sha1,
    integrity: sha512Integrity,
    manifest,
    ...(binarySha256 === undefined ? {} : { binarySha256 }),
  };
}

async function discoverPrepackedTarballs(
  packDir: string,
): Promise<ReadonlyMap<string, PrepackedEntry>> {
  const entries = new Map<string, PrepackedEntry>();
  const planPath = join(packDir, "publish-plan.json");

  if (existsSync(planPath)) {
    const parsed: unknown = JSON.parse(readFileSync(planPath, "utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !("plan" in parsed) ||
      !Array.isArray(parsed.plan)
    ) {
      throw new Error(`Invalid publish-plan.json at ${planPath}`);
    }
    for (const group of parsed.plan) {
      if (!Array.isArray(group)) continue;
      for (const item of group) {
        if (
          typeof item !== "object" ||
          item === null ||
          item.kind !== "publish" ||
          typeof item.name !== "string"
        ) {
          continue;
        }
        const tarball = (item as { readonly tarball?: unknown }).tarball;
        if (
          typeof tarball === "object" &&
          tarball !== null &&
          "path" in tarball &&
          typeof tarball.path === "string"
        ) {
          const tarballPath = resolve(packDir, tarball.path);
          const expectedIntegrity =
            "integrity" in tarball && typeof tarball.integrity === "string"
              ? tarball.integrity
              : undefined;
          entries.set(item.name, {
            tarballPath,
            ...(expectedIntegrity === undefined ? {} : { expectedIntegrity }),
          });
        }
      }
    }
  }

  for (const dir of [join(packDir, "packages"), packDir]) {
    if (!existsSync(dir)) continue;
    for (const dirent of readdirSync(dir, { withFileTypes: true })) {
      if (!dirent.isFile() || !dirent.name.endsWith(".tgz")) continue;
      const tarballPath = join(dir, dirent.name);
      const manifestRaw = await readTarEntry(
        tarballPath,
        "package/package.json",
      );
      const manifestParsed = JSON.parse(manifestRaw.toString("utf8")) as {
        readonly name?: unknown;
      };
      if (
        typeof manifestParsed.name === "string" &&
        !entries.has(manifestParsed.name)
      ) {
        entries.set(manifestParsed.name, { tarballPath });
      }
    }
  }

  return entries;
}

/**
 * Resolves the actually installed `version` of `packageName` from `cwd` or the
 * acceptance package's own dependency graph so upstream tarballs are never
 * pinned to a stale hardcoded version.
 */
export function resolveInstalledPackageVersion(
  packageName: string,
  cwd: string = process.cwd(),
): string {
  const candidateManifests = [
    join(resolve(cwd), "package.json"),
    join(resolve(cwd), "packages", "verule", "package.json"),
  ];
  const resolvers = [
    ...candidateManifests
      .filter((manifestPath) => existsSync(manifestPath))
      .map((manifestPath) => createRequire(manifestPath)),
    createRequire(import.meta.url),
  ];
  for (const resolver of resolvers) {
    try {
      const pkgJsonPath = resolver.resolve(`${packageName}/package.json`);
      const parsed: unknown = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
      if (
        typeof parsed === "object" &&
        parsed !== null &&
        "version" in parsed &&
        typeof parsed.version === "string" &&
        parsed.version.length > 0
      ) {
        return parsed.version;
      }
    } catch {
      // Try next resolution root.
    }
  }
  throw new Error(
    `Could not resolve installed version for package "${packageName}" from ${cwd}.`,
  );
}

type WorkspacePackageMeta = {
  readonly private: boolean;
};

async function discoverWorkspacePackages(
  cwd: string,
): Promise<ReadonlyMap<string, WorkspacePackageMeta>> {
  const { stdout } = await execFileAsync(
    "pnpm",
    ["m", "ls", "--json", "--depth=-1"],
    { cwd, encoding: "utf8", maxBuffer: maxTarBufferBytes },
  );
  const parsed: unknown = JSON.parse(stdout);
  const packages = new Map<string, WorkspacePackageMeta>();
  if (Array.isArray(parsed)) {
    for (const entry of parsed) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        "name" in entry &&
        typeof entry.name === "string"
      ) {
        packages.set(entry.name, {
          private: "private" in entry && entry.private === true,
        });
      }
    }
  }
  return packages;
}

/**
 * Resolves pre-packed candidate `.tgz` tarballs from `fromPackDir` /
 * `VERULE_ACCEPTANCE_PACK_DIR` (and `TSSAE_ACCEPTANCE_PACK_DIR` for upstream
 * TSSAE packages), or packs workspace packages with `pnpm pack` and upstream
 * packages from `TSSAE_ACCEPTANCE_PACK_DIR` or npm into a separate fallback
 * directory without mutating `VERULE_ACCEPTANCE_PACK_DIR`.
 */
export async function packWorkspaceArtifacts(
  options: PackWorkspaceArtifactsOptions = {},
): Promise<PackedArtifactBundle> {
  const packages = [
    ...new Set([
      ...CORE_VERULE_PACKAGES,
      ...(options.additionalPackages ?? []),
    ]),
  ];

  const envTssaePackDir = process.env.TSSAE_ACCEPTANCE_PACK_DIR?.trim();
  const tssaePrepacked =
    envTssaePackDir !== undefined && envTssaePackDir.length > 0
      ? await discoverPrepackedTarballs(resolve(envTssaePackDir))
      : undefined;

  const envPackDir = process.env.VERULE_ACCEPTANCE_PACK_DIR?.trim();
  const explicitFromPackDir =
    options.fromPackDir ??
    (envPackDir !== undefined && envPackDir.length > 0
      ? envPackDir
      : undefined);

  let resolvedFromPackDir: string | undefined;
  let discovered: ReadonlyMap<string, PrepackedEntry> | undefined;
  if (explicitFromPackDir !== undefined) {
    resolvedFromPackDir = resolve(explicitFromPackDir);
    if (!existsSync(resolvedFromPackDir)) {
      throw new Error(
        `Pre-packed artifact directory does not exist: ${resolvedFromPackDir}`,
      );
    }
    discovered = await discoverPrepackedTarballs(resolvedFromPackDir);
  }

  const cwd = options.cwd ?? process.cwd();
  const ownsFallbackPackDir = options.packDir === undefined;
  let fallbackPackDir: string | undefined =
    resolvedFromPackDir === undefined
      ? (options.packDir ?? mkdtempSync(join(tmpdir(), "verule-artifacts-")))
      : options.packDir;
  const ensureFallbackPackDir = (): string => {
    fallbackPackDir ??= mkdtempSync(
      join(tmpdir(), "verule-artifacts-fallback-"),
    );
    return fallbackPackDir;
  };

  const artifacts: PackedArtifact[] = [];
  let workspacePackages: ReadonlyMap<string, WorkspacePackageMeta> | undefined;
  try {
    for (const pkg of packages) {
      const prepackedFromVerule = discovered?.get(pkg);
      if (prepackedFromVerule !== undefined) {
        if (!existsSync(prepackedFromVerule.tarballPath)) {
          throw new Error(
            `Pre-packed tarball for ${pkg} missing on disk: ${prepackedFromVerule.tarballPath}`,
          );
        }
        artifacts.push(
          await inspectTarballArtifact(
            prepackedFromVerule.tarballPath,
            prepackedFromVerule.expectedIntegrity,
          ),
        );
        continue;
      }

      workspacePackages ??= await discoverWorkspacePackages(cwd);
      const workspaceMeta = workspacePackages.get(pkg);
      if (workspaceMeta !== undefined) {
        if (resolvedFromPackDir !== undefined && !workspaceMeta.private) {
          throw new Error(
            `Pre-packed tarball for publishable workspace package ${pkg} not found in ${resolvedFromPackDir}`,
          );
        }
        const destDir = ensureFallbackPackDir();
        const { stdout } = await execFileAsync(
          "pnpm",
          ["--filter", pkg, "pack", "--pack-destination", destDir, "--json"],
          { cwd, encoding: "utf8", maxBuffer: maxTarBufferBytes },
        );
        const packed = parsePackOutput(stdout);
        const artifact = await inspectTarballArtifact(packed.filename);
        if (
          artifact.name !== packed.name ||
          artifact.version !== packed.version
        ) {
          throw new Error(
            `Packed tarball ${packed.filename} metadata (${artifact.name}@${artifact.version}) mismatches pnpm pack output (${packed.name}@${packed.version})`,
          );
        }
        artifacts.push(artifact);
        continue;
      }

      const prepackedUpstream = tssaePrepacked?.get(pkg);
      if (prepackedUpstream !== undefined) {
        if (!existsSync(prepackedUpstream.tarballPath)) {
          throw new Error(
            `Pre-packed tarball for ${pkg} missing on disk: ${prepackedUpstream.tarballPath}`,
          );
        }
        artifacts.push(
          await inspectTarballArtifact(
            prepackedUpstream.tarballPath,
            prepackedUpstream.expectedIntegrity,
          ),
        );
        continue;
      }

      const resolvedVersion = resolveInstalledPackageVersion(pkg, cwd);
      const destDir = ensureFallbackPackDir();
      const { stdout } = await execFileAsync(
        "npm",
        [
          "pack",
          `${pkg}@${resolvedVersion}`,
          "--pack-destination",
          destDir,
          "--json",
        ],
        { cwd, encoding: "utf8", maxBuffer: maxTarBufferBytes },
      );
      const packed = parsePackOutput(stdout);
      artifacts.push(
        await inspectTarballArtifact(join(destDir, packed.filename)),
      );
    }
  } catch (error) {
    if (ownsFallbackPackDir && fallbackPackDir !== undefined) {
      rmSync(fallbackPackDir, { recursive: true, force: true });
    }
    throw error;
  }

  const bundlePackDir = resolvedFromPackDir ?? ensureFallbackPackDir();
  return {
    packDir: bundlePackDir,
    artifacts,
    dispose(): void {
      // Only remove our own temporary fallback directory; never delete VERULE_ACCEPTANCE_PACK_DIR.
      if (ownsFallbackPackDir && fallbackPackDir !== undefined) {
        rmSync(fallbackPackDir, { recursive: true, force: true });
      }
    },
  };
}
