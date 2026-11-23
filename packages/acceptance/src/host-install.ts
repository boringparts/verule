import { execFile } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { PackedArtifact } from "./artifacts.ts";
import {
  prepareHostCheckout,
  type PrepareHostCheckoutOptions,
} from "./checkout.ts";
import { HOST_DEFINITIONS } from "./hosts.ts";
import { startArtifactRegistry } from "./registry.ts";
import type {
  CheckedOutHost,
  HostId,
  PreparationFailure,
  PreparationStage,
} from "./types.ts";

export const DEFAULT_DIRECT_VERULE_PACKAGES: readonly string[] = [
  "@verule/sdk",
  "@verule/cli",
];

export type CommandOutcome = {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type InstallArtifactsOptions = {
  readonly hostId: HostId;
  readonly sha: string;
  readonly checkoutDir: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly directPackages?: readonly string[];
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type InstallArtifactsResult =
  | {
      readonly status: "ready";
      readonly directPackages: readonly string[];
    }
  | PreparationFailure;

export type InstallArtifactPackagesOptions = {
  readonly checkoutDir: string;
  readonly packageManager: "npm" | "pnpm";
  readonly artifacts: readonly PackedArtifact[];
  readonly directPackages?: readonly string[];
  readonly storeDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

export type InstallArtifactPackagesResult =
  | {
      readonly status: "ready";
      readonly directPackages: readonly string[];
    }
  | {
      readonly status: "install-failed";
      readonly command: string;
      readonly exitCode: number;
      readonly message: string;
      readonly stderr: string;
    };

export type RestoreDependenciesResult =
  | {
      readonly status: "ready";
    }
  | PreparationFailure;

export type PreparedHostWithArtifacts = {
  readonly status: "ready";
  readonly checkout: CheckedOutHost;
  readonly directPackages: readonly string[];
  cleanup(): void;
};

export type PrepareHostWithArtifactsOutcome =
  | PreparedHostWithArtifacts
  | PreparationFailure;

const maxInstallBufferBytes = 64 * 1024 * 1024;

function runAsyncCommand(
  command: string,
  args: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<CommandOutcome> {
  return new Promise((resolveResult) => {
    execFile(
      command,
      args,
      {
        cwd,
        encoding: "utf8",
        maxBuffer: maxInstallBufferBytes,
        env: {
          ...env,
          GIT_TERMINAL_PROMPT: "0",
        },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveResult({ status: 0, stdout, stderr });
          return;
        }
        resolveResult({
          status: typeof error.code === "number" ? error.code : 1,
          stdout,
          stderr: stderr.length > 0 ? stderr : error.message,
        });
      },
    );
  });
}

function preparationFailure(
  stage: PreparationStage,
  hostId: HostId,
  sha: string,
  message: string,
  command: string,
  result: CommandOutcome,
): PreparationFailure {
  return {
    status: "preparation-failed",
    stage,
    hostId,
    sha,
    command,
    exitCode: result.status,
    message,
    stderr: result.stderr.trim(),
  };
}

/**
 * Restores a checked-out host repository's dependencies using its native
 * package manager and lockfile with scripts disabled.
 */
export async function restoreHostDependencies(
  checkout: CheckedOutHost,
  options: { readonly env?: Readonly<Record<string, string | undefined>> } = {},
): Promise<RestoreDependenciesResult> {
  const host = HOST_DEFINITIONS[checkout.hostId];
  const [command, ...args] = host.restoreCommand;
  const result = await runAsyncCommand(
    command,
    args,
    checkout.checkoutDir,
    options.env ?? process.env,
  );
  if (result.status !== 0) {
    return preparationFailure(
      "restore-dependencies",
      checkout.hostId,
      checkout.sha,
      `Failed to restore ${host.displayName} dependencies at ${checkout.sha}`,
      host.restoreCommand.join(" "),
      result,
    );
  }
  return { status: "ready" };
}

/**
 * Installs only the direct Verule packages into a host checkout via a
 * short-lived loopback scoped registry so the host's package manager resolves
 * `@verule/engine` transitively from the same local artifact batch.
 */
export async function installArtifactsInHost(
  options: InstallArtifactsOptions,
): Promise<InstallArtifactsResult> {
  const host = HOST_DEFINITIONS[options.hostId];
  const result = await installArtifactPackages({
    checkoutDir: options.checkoutDir,
    packageManager: host.packageManager,
    artifacts: options.artifacts,
    ...(options.directPackages === undefined
      ? {}
      : { directPackages: options.directPackages }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (result.status === "install-failed") {
    return preparationFailure(
      "install-artifacts",
      options.hostId,
      options.sha,
      `Failed to install Verule direct packages into ${host.displayName} at ${options.sha}`,
      result.command,
      {
        status: result.exitCode,
        stdout: "",
        stderr: result.stderr,
      },
    );
  }
  return result;
}

/**
 * Installs direct Verule packages from one local artifact batch into an
 * existing host workspace or repository.
 */
export async function installArtifactPackages(
  options: InstallArtifactPackagesOptions,
): Promise<InstallArtifactPackagesResult> {
  const directPackages = [
    ...new Set(options.directPackages ?? DEFAULT_DIRECT_VERULE_PACKAGES),
  ];
  const artifactByName = new Map(
    options.artifacts.map((artifact) => [artifact.name, artifact]),
  );
  const specs = directPackages.map((name) => {
    const artifact = artifactByName.get(name);
    if (artifact === undefined) {
      throw new Error(`Missing packed artifact for direct package ${name}`);
    }
    return `${artifact.name}@${artifact.version}`;
  });

  const npmrcPath = join(options.checkoutDir, ".npmrc");
  const hadNpmrc = existsSync(npmrcPath);
  const previousNpmrc = hadNpmrc ? readFileSync(npmrcPath, "utf8") : "";
  const registry = await startArtifactRegistry(options.artifacts);
  try {
    const scopeLines = registry.scopes.map(
      (scope) => `${scope}:registry=${registry.url}/`,
    );
    const separator =
      previousNpmrc.length === 0 || previousNpmrc.endsWith("\n") ? "" : "\n";
    writeFileSync(
      npmrcPath,
      `${previousNpmrc}${separator}${scopeLines.join("\n")}\n`,
    );

    const commandArgs =
      options.packageManager === "npm"
        ? [
            "npm",
            "install",
            "--save-dev",
            "--ignore-scripts",
            "--no-audit",
            "--no-fund",
            ...specs,
          ]
        : [
            "pnpm",
            ...(options.storeDir === undefined
              ? []
              : ["--store-dir", options.storeDir]),
            "add",
            "--save-dev",
            ...(existsSync(join(options.checkoutDir, "pnpm-workspace.yaml"))
              ? ["--workspace-root"]
              : []),
            "--ignore-scripts",
            ...specs,
          ];
    const [command, ...args] = commandArgs;
    const commandResult = await runAsyncCommand(
      command!,
      args,
      options.checkoutDir,
      options.env ?? process.env,
    );
    if (commandResult.status !== 0) {
      return {
        status: "install-failed",
        command: commandArgs.join(" "),
        exitCode: commandResult.status,
        message: "Failed to install packed Verule artifacts.",
        stderr: commandResult.stderr.trim(),
      };
    }
    return { status: "ready", directPackages };
  } finally {
    if (hadNpmrc) {
      writeFileSync(npmrcPath, previousNpmrc);
    } else {
      rmSync(npmrcPath, { force: true });
    }
    await registry.close();
  }
}

/**
 * Checks out a pinned host commit, restores its lockfile dependencies, and
 * installs direct Verule artifacts from the current build batch. Cleans up
 * the temporary checkout directory if any preparation step fails.
 */
export async function prepareHostWithArtifacts(
  options: PrepareHostCheckoutOptions & {
    readonly artifacts: readonly PackedArtifact[];
    readonly directPackages?: readonly string[];
  },
): Promise<PrepareHostWithArtifactsOutcome> {
  const checkout = await prepareHostCheckout(options);
  if (checkout.status === "preparation-failed") {
    return checkout;
  }

  const restored = await restoreHostDependencies(
    checkout,
    options.env === undefined ? {} : { env: options.env },
  );
  if (restored.status === "preparation-failed") {
    checkout.cleanup();
    return restored;
  }

  const installed = await installArtifactsInHost({
    hostId: options.hostId,
    sha: options.sha,
    checkoutDir: checkout.checkoutDir,
    artifacts: options.artifacts,
    ...(options.directPackages === undefined
      ? {}
      : { directPackages: options.directPackages }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (installed.status === "preparation-failed") {
    checkout.cleanup();
    return installed;
  }

  return {
    status: "ready",
    checkout,
    directPackages: installed.directPackages,
    cleanup: () => checkout.cleanup(),
  };
}
