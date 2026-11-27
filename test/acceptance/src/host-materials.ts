import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AcceptanceHostOverlay = "drizzle-zod" | "queue";

export type AcceptanceHostMaterialSource =
  | "app"
  | "data"
  | "drizzle-zod-app"
  | "drizzle-zod-data";

const baseAppPackage = "@verule/acceptance-host-app";
const baseDataPackage = "@verule/acceptance-host-data";

const overlayPackages: Record<
  Exclude<AcceptanceHostOverlay, "queue">,
  { readonly app: string; readonly data: string }
> = {
  "drizzle-zod": {
    app: "@verule/acceptance-host-drizzle-zod-app",
    data: "@verule/acceptance-host-drizzle-zod-data",
  },
};

const materialPackages: Record<AcceptanceHostMaterialSource, string> = {
  app: baseAppPackage,
  data: baseDataPackage,
  "drizzle-zod-app": overlayPackages["drizzle-zod"].app,
  "drizzle-zod-data": overlayPackages["drizzle-zod"].data,
};

function resolveHostMaterial(
  packageName: string,
  relativePath: string,
): string {
  return fileURLToPath(
    import.meta.resolve(packageName + "/host-materials/" + relativePath),
  );
}

function readHostMaterials(packageName: string): readonly string[] {
  const entryPath = fileURLToPath(
    import.meta.resolve(packageName + "/host-materials"),
  );
  const descriptor = JSON.parse(readFileSync(entryPath, "utf8")) as {
    readonly type?: unknown;
    readonly version?: unknown;
    readonly files?: unknown;
  };
  if (
    descriptor.type !== "verule-acceptance-host-materials" ||
    descriptor.version !== 1 ||
    !Array.isArray(descriptor.files) ||
    !descriptor.files.every((file) => typeof file === "string")
  ) {
    throw new Error(
      "Invalid host-materials entry exported by " + packageName + ".",
    );
  }

  const files = descriptor.files;
  if (
    files.some(
      (file) =>
        file.length === 0 ||
        file.startsWith("/") ||
        file.includes("\\") ||
        file
          .split("/")
          .some((part) => part === "" || part === "." || part === ".."),
    ) ||
    new Set(files).size !== files.length
  ) {
    throw new Error(
      "Invalid host-materials file list exported by " + packageName + ".",
    );
  }
  return files;
}

function copyHostMaterialFiles(
  packageName: string,
  destination: string,
  include: (relativePath: string) => boolean,
  stripPrefix = "",
): void {
  const files = readHostMaterials(packageName);
  const selectedFiles = files.filter(include);
  if (selectedFiles.length === 0) {
    throw new Error("No host materials selected from " + packageName + ".");
  }

  for (const relativePath of selectedFiles) {
    const outputPath =
      stripPrefix.length === 0
        ? relativePath
        : relativePath.slice(stripPrefix.length);
    if (outputPath.length === 0) {
      throw new Error('Invalid host-materials prefix "' + stripPrefix + '".');
    }
    const outputFile = join(destination, outputPath);
    mkdirSync(dirname(outputFile), { recursive: true });
    copyFileSync(resolveHostMaterial(packageName, relativePath), outputFile);
  }
}

function copyHostMaterialFile(
  packageName: string,
  relativePath: string,
  destination: string,
): void {
  if (!readHostMaterials(packageName).includes(relativePath)) {
    throw new Error(
      'Host material "' +
        relativePath +
        '" is not exported by ' +
        packageName +
        ".",
    );
  }
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(resolveHostMaterial(packageName, relativePath), destination);
}

function copyNeutralHost(hostDir: string): {
  readonly appDir: string;
  readonly dataDir: string;
} {
  const appDir = join(hostDir, "packages/app");
  const dataDir = join(hostDir, "packages/data");
  copyHostMaterialFiles(
    baseAppPackage,
    hostDir,
    (relativePath) => relativePath.startsWith("host-root/"),
    "host-root/",
  );
  copyHostMaterialFiles(
    baseAppPackage,
    appDir,
    (relativePath) =>
      !relativePath.startsWith("host-root/") &&
      !relativePath.startsWith("provider-session-overlay/") &&
      !relativePath.startsWith("scenarios/") &&
      !relativePath.startsWith("variants/") &&
      relativePath !== "package.json" &&
      relativePath !== "host-package.json",
  );
  copyHostMaterialFile(
    baseAppPackage,
    "host-package.json",
    join(appDir, "package.json"),
  );
  copyHostMaterialFiles(baseDataPackage, dataDir, () => true);
  return { appDir, dataDir };
}

function copySpecializedHost(
  hostDir: string,
  overlay: Exclude<AcceptanceHostOverlay, "queue">,
): { readonly appDir: string; readonly dataDir: string } {
  const packages = overlayPackages[overlay];
  const appDir = join(hostDir, "packages/app");
  const dataDir = join(hostDir, "packages/data");
  copyHostMaterialFiles(
    packages.app,
    appDir,
    (relativePath) =>
      !relativePath.startsWith("host-root/") &&
      !relativePath.startsWith("variants/") &&
      relativePath !== "package.json" &&
      relativePath !== "host-package.json",
  );
  copyHostMaterialFile(
    packages.app,
    "host-package.json",
    join(appDir, "package.json"),
  );
  copyHostMaterialFiles(
    packages.data,
    dataDir,
    (relativePath) => !relativePath.startsWith("variants/"),
  );
  copyHostMaterialFiles(
    packages.app,
    hostDir,
    (relativePath) => relativePath.startsWith("host-root/"),
    "host-root/",
  );
  return { appDir, dataDir };
}

function copyQueueHost(hostDir: string): {
  readonly appDir: string;
  readonly dataDir: string;
} {
  const appDir = join(hostDir, "packages/app");
  const dataDir = join(hostDir, "packages/data");
  copyHostMaterialFiles(
    baseAppPackage,
    hostDir,
    (relativePath) => relativePath.startsWith("host-root/"),
    "host-root/",
  );
  copyHostMaterialFiles(
    baseAppPackage,
    appDir,
    (relativePath) => relativePath.startsWith("scenarios/queue/src/"),
    "scenarios/queue/",
  );
  copyHostMaterialFile(
    baseAppPackage,
    "scenarios/queue/verule.config.ts",
    join(appDir, "verule.config.ts"),
  );
  copyHostMaterialFile(
    baseAppPackage,
    "scenarios/queue/host-package.json",
    join(appDir, "package.json"),
  );
  copyHostMaterialFile(
    baseDataPackage,
    "package.json",
    join(dataDir, "package.json"),
  );
  return { appDir, dataDir };
}

/**
 * Copies a single manifest-listed host material file into `destinationPath`.
 */
export function copyAcceptanceHostMaterial(
  source: AcceptanceHostMaterialSource,
  materialPath: string,
  destinationPath: string,
): void {
  copyHostMaterialFile(materialPackages[source], materialPath, destinationPath);
}

/**
 * Reads a manifest-listed host material file as UTF-8 text via package exports.
 */
export function readAcceptanceHostMaterial(
  source: AcceptanceHostMaterialSource,
  materialPath: string,
): string {
  const packageName = materialPackages[source];
  if (!readHostMaterials(packageName).includes(materialPath)) {
    throw new Error(
      'Host material "' +
        materialPath +
        '" is not exported by ' +
        packageName +
        ".",
    );
  }
  return readFileSync(resolveHostMaterial(packageName, materialPath), "utf8");
}

/**
 * Copies only the selected manifest-listed host materials into a disposable
 * out-of-repo host directory.
 */
export function copyAcceptanceHost(
  hostDir: string,
  overlay?: AcceptanceHostOverlay,
): { readonly appDir: string; readonly dataDir: string } {
  mkdirSync(hostDir, { recursive: true });
  if (overlay === undefined) return copyNeutralHost(hostDir);
  if (overlay === "queue") return copyQueueHost(hostDir);
  return copySpecializedHost(hostDir, overlay);
}
