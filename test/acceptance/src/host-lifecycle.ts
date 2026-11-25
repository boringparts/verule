import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import type { NormalizedVeruleConfig } from "@boringparts/verule";
import {
  type CleanupFn,
  createHostFileAccessors,
  runCleanupsLifo,
} from "@verule/test-hosts";

import {
  type PackedArtifact,
  type PackedArtifactBundle,
  packWorkspaceArtifacts,
} from "./artifacts.ts";
import {
  DEFAULT_DIRECT_VERULE_PACKAGES,
  installArtifactPackages,
} from "./host-install.ts";
import {
  type AcceptanceHostOverlay,
  copyAcceptanceHost,
} from "./host-materials.ts";
import { type BareVeruleRunResult, runBareVeruleInHost } from "./isolation.ts";
import {
  type AcceptanceSharedSession,
  type AcceptanceWatchSession,
  type CliCheckResult,
  parseCheckJsonResult,
  startSharedSessionProcess,
  startWatchProcess,
} from "./process-stream.ts";
import type { PackageManager } from "./types.ts";
import {
  type HostResolutionAudit,
  type VerifiedNativeLibrary,
  verifyHostArtifactResolution,
  verifyInstalledNativeLibrary,
} from "./verify.ts";

export type PrepareAcceptanceHostOptions = {
  readonly overlay?: AcceptanceHostOverlay;
  readonly additionalPackages?: readonly string[];
  readonly directPackages?: readonly string[];
  readonly verifyNativeAdapters?: readonly string[];
  readonly bundle?: PackedArtifactBundle;
  readonly packageManager?: PackageManager;
  readonly blockedPaths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly tempRoot?: string;
  readonly cwd?: string;
};

export type HostCheckOptions = {
  readonly config?: string;
  readonly rule?: string;
  readonly at?: string;
  readonly observe?: "summary" | "detail";
  readonly isolated?: boolean;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type HostRunCliOptions = {
  readonly isolated?: boolean;
  readonly timeoutMs?: number;
  readonly sharedReadWritePaths?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type StartHostWatchOptions = {
  readonly config?: string;
  readonly isolated?: boolean;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type StartHostSessionOptions = {
  readonly config?: string;
  readonly socketPath?: string;
  readonly isolated?: boolean;
  readonly timeoutMs?: number;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type PreparedAcceptanceHost = {
  readonly environmentDir: string;
  readonly hostDir: string;
  readonly appDir: string;
  readonly dataDir: string;
  readonly storeDir: string;
  readonly runtimeDir: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly audit: HostResolutionAudit;
  readonly nativeLibraries: Readonly<Record<string, VerifiedNativeLibrary>>;
  resolvePath(relativePath: string): string;
  readText(relativePath: string): string;
  writeText(relativePath: string, content: string): void;
  replaceText(
    relativePath: string,
    search: string,
    replacement: string,
  ): string;
  artifact(packageName: string): PackedArtifact;
  runCli(
    args: readonly string[],
    options?: HostRunCliOptions,
  ): Promise<BareVeruleRunResult>;
  check(options?: HostCheckOptions): Promise<CliCheckResult>;
  startWatch(options?: StartHostWatchOptions): Promise<AcceptanceWatchSession>;
  startSession(
    options?: StartHostSessionOptions,
  ): Promise<AcceptanceSharedSession>;
  loadSdk(): Promise<typeof import("@boringparts/verule")>;
  loadConfig<TConfig = NormalizedVeruleConfig>(
    relativePath: string,
  ): Promise<TConfig>;
  verifyNativeAdapter(
    packageName: string,
    options?: {
      readonly expectedProviderId?: string;
      readonly resolutionBaseDir?: string;
    },
  ): VerifiedNativeLibrary;
  dispose(): Promise<void>;
  [Symbol.asyncDispose](): Promise<void>;
};

/**
 * Prepares an isolated out-of-repo acceptance host with packed workspace
 * artifacts installed and verified, guaranteeing LIFO resource reclamation on
 * any mid-preparation failure or subsequent `dispose()`.
 */
export async function prepareAcceptanceHost(
  options: PrepareAcceptanceHostOptions = {},
): Promise<PreparedAcceptanceHost> {
  const cleanups: CleanupFn[] = [];
  const tempParent = options.tempRoot ?? tmpdir();
  mkdirSync(tempParent, { recursive: true });
  const environmentDir = mkdtempSync(join(tempParent, "verule-host-"));
  cleanups.push(() => {
    rmSync(environmentDir, { recursive: true, force: true });
  });

  const hostDir = join(environmentDir, "host");
  const storeDir = join(environmentDir, "store");
  const runtimeDir = join(environmentDir, "runtime");

  try {
    mkdirSync(storeDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    const { appDir, dataDir } = copyAcceptanceHost(hostDir, options.overlay);

    const bundle =
      options.bundle ??
      (await packWorkspaceArtifacts({
        ...(options.additionalPackages === undefined
          ? {}
          : { additionalPackages: options.additionalPackages }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      }));
    if (options.bundle === undefined) {
      cleanups.push(() => {
        bundle.dispose();
      });
    }

    const directPackages = [
      ...new Set(
        options.directPackages ?? [
          ...DEFAULT_DIRECT_VERULE_PACKAGES,
          ...(options.additionalPackages ?? []),
        ],
      ),
    ];

    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: options.packageManager ?? "pnpm",
      artifacts: bundle.artifacts,
      directPackages,
      storeDir,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (installation.status === "install-failed") {
      throw new Error(
        `${installation.message} (${installation.command}, exit=${String(installation.exitCode)}): ${installation.stderr}`,
      );
    }

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      directPackages,
      ...(options.blockedPaths === undefined
        ? {}
        : { blockedPaths: options.blockedPaths }),
      allowedStorePaths: [storeDir],
    });

    const artifacts = bundle.artifacts;
    const artifactByName = new Map(
      artifacts.map((artifact) => [artifact.name, artifact]),
    );
    const getArtifact = (packageName: string): PackedArtifact => {
      const found = artifactByName.get(packageName);
      if (found === undefined) {
        throw new Error(`Missing packed artifact for ${packageName}`);
      }
      return found;
    };

    const nativeLibraries: Record<string, VerifiedNativeLibrary> = {};
    for (const packageName of options.verifyNativeAdapters ?? []) {
      const adapterArtifact = artifactByName.get(packageName);
      nativeLibraries[packageName] = verifyInstalledNativeLibrary({
        checkoutDir: hostDir,
        packageName,
        ...(adapterArtifact === undefined ? {} : { artifact: adapterArtifact }),
      });
    }

    let sessionCounter = 0;
    let disposePromise: Promise<void> | undefined;

    const dispose = (): Promise<void> => {
      if (disposePromise !== undefined) {
        return disposePromise;
      }
      disposePromise = (async () => {
        const cleanupError = await runCleanupsLifo(cleanups);
        if (cleanupError !== undefined) {
          throw cleanupError;
        }
      })();
      return disposePromise;
    };

    const hostFiles = createHostFileAccessors(hostDir);
    const resolvePath = hostFiles.resolvePath;

    const runCli = (
      args: readonly string[],
      cliOptions: HostRunCliOptions = {},
    ): Promise<BareVeruleRunResult> => {
      const mergedEnv = cliOptions.env ?? options.env;
      return runBareVeruleInHost({
        checkoutDir: hostDir,
        args,
        isolated: cliOptions.isolated ?? true,
        pnpmStoreDir: storeDir,
        ...(options.blockedPaths === undefined
          ? {}
          : { blockedPaths: options.blockedPaths }),
        ...(cliOptions.sharedReadWritePaths === undefined
          ? {}
          : { sharedReadWritePaths: cliOptions.sharedReadWritePaths }),
        ...(cliOptions.timeoutMs === undefined
          ? {}
          : { timeoutMs: cliOptions.timeoutMs }),
        ...(mergedEnv === undefined ? {} : { env: mergedEnv }),
      });
    };

    return {
      environmentDir,
      hostDir,
      appDir,
      dataDir,
      storeDir,
      runtimeDir,
      artifacts,
      audit,
      nativeLibraries,
      resolvePath,
      readText: hostFiles.readText,
      writeText: hostFiles.writeText,
      replaceText: hostFiles.replaceText,
      artifact: getArtifact,
      runCli,
      async check(
        checkOptions: HostCheckOptions = {},
      ): Promise<CliCheckResult> {
        const args = [
          "check",
          ...(checkOptions.config === undefined
            ? []
            : ["--config", checkOptions.config]),
          ...(checkOptions.rule === undefined
            ? []
            : ["--rule", checkOptions.rule]),
          ...(checkOptions.at === undefined ? [] : ["--at", checkOptions.at]),
          ...(checkOptions.observe === undefined
            ? []
            : ["--observe", checkOptions.observe]),
          "--output",
          "json",
        ];
        const result = await runCli(args, {
          ...(checkOptions.isolated === undefined
            ? {}
            : { isolated: checkOptions.isolated }),
          ...(checkOptions.timeoutMs === undefined
            ? {}
            : { timeoutMs: checkOptions.timeoutMs }),
          ...(checkOptions.env === undefined ? {} : { env: checkOptions.env }),
        });
        return parseCheckJsonResult(result);
      },
      async startWatch(
        watchOptions: StartHostWatchOptions = {},
      ): Promise<AcceptanceWatchSession> {
        const mergedEnv = watchOptions.env ?? options.env;
        const watch = await startWatchProcess({
          checkoutDir: hostDir,
          ...(watchOptions.config === undefined
            ? {}
            : { config: watchOptions.config }),
          isolated: watchOptions.isolated ?? true,
          pnpmStoreDir: storeDir,
          ...(options.blockedPaths === undefined
            ? {}
            : { blockedPaths: options.blockedPaths }),
          ...(mergedEnv === undefined ? {} : { env: mergedEnv }),
          ...(watchOptions.timeoutMs === undefined
            ? {}
            : { defaultTimeoutMs: watchOptions.timeoutMs }),
        });
        cleanups.push(async () => {
          await watch.close();
        });
        return watch;
      },
      async startSession(
        sessionOptions: StartHostSessionOptions = {},
      ): Promise<AcceptanceSharedSession> {
        const mergedEnv = sessionOptions.env ?? options.env;
        sessionCounter += 1;
        const socketPath =
          sessionOptions.socketPath ??
          join(runtimeDir, `s-${String(sessionCounter)}.sock`);
        const session = await startSharedSessionProcess({
          checkoutDir: hostDir,
          socketPath,
          ...(sessionOptions.config === undefined
            ? {}
            : { config: sessionOptions.config }),
          isolated: sessionOptions.isolated ?? true,
          pnpmStoreDir: storeDir,
          ...(options.blockedPaths === undefined
            ? {}
            : { blockedPaths: options.blockedPaths }),
          ...(mergedEnv === undefined ? {} : { env: mergedEnv }),
          ...(sessionOptions.timeoutMs === undefined
            ? {}
            : { timeoutMs: sessionOptions.timeoutMs }),
        });
        cleanups.push(async () => {
          await session.close();
        });
        return session;
      },
      async loadSdk(): Promise<typeof import("@boringparts/verule")> {
        const hostRequire = createRequire(join(hostDir, "package.json"));
        const sdkPath = realpathSync(
          hostRequire.resolve("@boringparts/verule"),
        );
        return (await import(
          pathToFileURL(sdkPath).href
        )) as typeof import("@boringparts/verule");
      },
      async loadConfig<TConfig = NormalizedVeruleConfig>(
        relativePath: string,
      ): Promise<TConfig> {
        const configModule = (await import(
          pathToFileURL(resolvePath(relativePath)).href
        )) as { readonly default: TConfig };
        return configModule.default;
      },
      verifyNativeAdapter(packageName, verifyOptions = {}) {
        const adapterArtifact = artifactByName.get(packageName);
        return verifyInstalledNativeLibrary({
          checkoutDir: hostDir,
          packageName,
          ...(adapterArtifact === undefined
            ? {}
            : { artifact: adapterArtifact }),
          ...(verifyOptions.expectedProviderId === undefined
            ? {}
            : { expectedProviderId: verifyOptions.expectedProviderId }),
          ...(verifyOptions.resolutionBaseDir === undefined
            ? {}
            : { resolutionBaseDir: verifyOptions.resolutionBaseDir }),
        });
      },
      dispose,
      [Symbol.asyncDispose]: dispose,
    };
  } catch (error) {
    // Preserve the original failure while reclaiming all resources created so far.
    await runCleanupsLifo(cleanups);
    throw error;
  }
}

/**
 * Prepares an acceptance host, passes it to `callback`, and always disposes all
 * child processes, sockets, and temporary directories in a `finally` block.
 */
export async function withAcceptanceHost<T>(
  options: PrepareAcceptanceHostOptions,
  callback: (host: PreparedAcceptanceHost) => Promise<T>,
): Promise<T> {
  const host = await prepareAcceptanceHost(options);
  try {
    return await callback(host);
  } finally {
    await host.dispose();
  }
}
