import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type AcceptanceHostOverlay =
  | "drizzle"
  | "drizzle-zod"
  | "provider-session"
  | "zod";

const baseAppPackage = "@verule/acceptance-host-app";
const baseDataPackage = "@verule/acceptance-host-data";

const overlayPackages: Record<
  AcceptanceHostOverlay,
  { readonly app: string; readonly data: string }
> = {
  drizzle: {
    app: "@verule/acceptance-host-drizzle-app",
    data: "@verule/acceptance-host-drizzle-data",
  },
  "drizzle-zod": {
    app: "@verule/acceptance-host-drizzle-zod-app",
    data: "@verule/acceptance-host-drizzle-zod-data",
  },
  "provider-session": {
    app: baseAppPackage,
    data: "@verule/acceptance-host-provider-session-data",
  },
  zod: {
    app: "@verule/acceptance-host-zod-app",
    data: "@verule/acceptance-host-zod-data",
  },
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

  const files = descriptor.files as string[];
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
      !relativePath.startsWith("provider-session-overlay/"),
  );
  copyHostMaterialFiles(baseDataPackage, dataDir, () => true);
  return { appDir, dataDir };
}

function copySpecializedHost(
  hostDir: string,
  overlay: Exclude<AcceptanceHostOverlay, "provider-session">,
): { readonly appDir: string; readonly dataDir: string } {
  const packages = overlayPackages[overlay];
  const appDir = join(hostDir, "packages/app");
  const dataDir = join(hostDir, "packages/data");
  copyHostMaterialFiles(
    packages.app,
    appDir,
    (relativePath) =>
      !relativePath.startsWith("host-root/") &&
      relativePath !== "package.json" &&
      relativePath !== "host-package.json",
  );
  copyHostMaterialFile(
    packages.app,
    "host-package.json",
    join(appDir, "package.json"),
  );
  copyHostMaterialFiles(packages.data, dataDir, () => true);
  copyHostMaterialFiles(
    packages.app,
    hostDir,
    (relativePath) => relativePath.startsWith("host-root/"),
    "host-root/",
  );
  return { appDir, dataDir };
}

function copyProviderSessionHost(hostDir: string): {
  readonly appDir: string;
  readonly dataDir: string;
} {
  const { appDir, dataDir } = copyNeutralHost(hostDir);
  const packages = overlayPackages["provider-session"];
  const providerAppPrefix = "provider-session-overlay/app/";
  const providerHostRootPrefix = "provider-session-overlay/host-root/";
  const overlayAppDir = join(appDir, "provider-session-overlay/app");

  copyHostMaterialFiles(
    baseAppPackage,
    overlayAppDir,
    (relativePath) =>
      relativePath.startsWith(providerAppPrefix + "src/") ||
      relativePath.startsWith(providerAppPrefix + "verule."),
    providerAppPrefix,
  );
  copyHostMaterialFile(
    baseAppPackage,
    providerAppPrefix + "host-tsconfig.json",
    join(appDir, "tsconfig.json"),
  );
  copyHostMaterialFile(
    baseAppPackage,
    providerAppPrefix + "host-package.json",
    join(appDir, "package.json"),
  );
  copyHostMaterialFiles(packages.data, dataDir, (relativePath) =>
    relativePath.startsWith("src/"),
  );
  copyHostMaterialFile(
    packages.data,
    "host-package.json",
    join(dataDir, "package.json"),
  );
  copyHostMaterialFiles(
    baseAppPackage,
    hostDir,
    (relativePath) => relativePath.startsWith(providerHostRootPrefix),
    providerHostRootPrefix,
  );
  return { appDir, dataDir };
}

/** Copies only the selected manifest-listed resources into a disposable host tree. */
export function copyAcceptanceHost(
  hostDir: string,
  overlay?: AcceptanceHostOverlay,
): { readonly appDir: string; readonly dataDir: string } {
  mkdirSync(hostDir, { recursive: true });
  if (overlay === undefined) return copyNeutralHost(hostDir);
  if (overlay === "provider-session") return copyProviderSessionHost(hostDir);
  return copySpecializedHost(hostDir, overlay);
}
