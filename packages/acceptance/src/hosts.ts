import { homedir } from "node:os";
import { join } from "node:path";

import type { HostDefinition, HostId, HostScenario } from "./types.ts";

/**
 * Fixed upstream host definitions used for out-of-repo installation and replay
 * verification.
 */
export const HOST_DEFINITIONS: Readonly<Record<HostId, HostDefinition>> = {
  vscode: {
    id: "vscode",
    displayName: "VS Code",
    defaultRepositoryUrl: "https://github.com/microsoft/vscode.git",
    repositoryEnvVar: "VERULE_VSCODE_REPO",
    packageManager: "npm",
    restoreCommand: [
      "npm",
      "ci",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
  },
  vue: {
    id: "vue",
    displayName: "Vue",
    defaultRepositoryUrl: "https://github.com/vuejs/core.git",
    repositoryEnvVar: "VERULE_VUE_REPO",
    packageManager: "pnpm",
    restoreCommand: [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
  },
  openstatus: {
    id: "openstatus",
    displayName: "OpenStatus",
    defaultRepositoryUrl: "https://github.com/openstatusHQ/openstatus.git",
    repositoryEnvVar: "VERULE_OPENSTATUS_REPO",
    packageManager: "pnpm",
    restoreCommand: [
      "pnpm",
      "install",
      "--frozen-lockfile",
      "--ignore-scripts",
    ],
  },
};

/**
 * Fixed upstream commits from the Verule v1 specification (`spec.md` and
 * OpenStatus projection evaluation scenarios).
 */
export const HOST_SCENARIOS: readonly HostScenario[] = [
  {
    id: "vscode-terminal-find",
    hostId: "vscode",
    description: "VS Code terminal repeated search listener replacement",
    revisions: [
      { label: "before", sha: "c79dbd0432433dde5697606122583c5c94d0ab74" },
      { label: "after", sha: "53f4de24cb61db9267fec741b31768c35ce127ae" },
    ],
  },
  {
    id: "vscode-accessible-view",
    hostId: "vscode",
    description: "VS Code accessible view toolbar menu replacement",
    revisions: [
      { label: "before", sha: "5886d26498c71fbe4fe0ce10148cc5f9cbd8345e" },
      { label: "after", sha: "fb6289d60e979ff544a2619b2f0d192c8cc30c0a" },
    ],
  },
  {
    id: "vscode-ipc-connection",
    hostId: "vscode",
    description: "VS Code IPC server per-connection disposable ownership",
    revisions: [
      { label: "before", sha: "8309b22051c226cca9c3485fd282e93df6339eca" },
      { label: "after", sha: "c9ce5675282e562684c72fb6e1361995e0c6398c" },
    ],
  },
  {
    id: "vscode-resource-pool",
    hostId: "vscode",
    description: "VS Code chat resource pool item disposal ownership",
    revisions: [
      { label: "before", sha: "f520d705ae646c2e26d624924d503562e20d9517" },
      { label: "after", sha: "3fc62371e017d5e6d3d742b7aa79832c9fc9e71d" },
    ],
  },
  {
    id: "vue-reentrant-scheduler",
    hostId: "vue",
    description: "Vue scheduler reentrant job QUEUED flag clearing",
    revisions: [
      { label: "before", sha: "7257e6a34200409b3fc347d3bb807e11e2785974" },
      { label: "after", sha: "d18d6aa1b20dc57a8103c51ec4d61e8e53ed936d" },
    ],
  },
  {
    id: "openstatus-whoami",
    hostId: "openstatus",
    description: "OpenStatus whoami Drizzle projection vs Zod schema sequence",
    revisions: [
      { label: "initial", sha: "f8cbf5f4a0565b8b14bfa7272aaf9abbc6b778bf" },
      { label: "fix-typo", sha: "f04bd49aaac41f8be05eb821ec6442e763e6c86f" },
      {
        label: "remove-field",
        sha: "f2840732f3f2879ccb1695a7a42513aeaf274cb3",
      },
    ],
  },
  {
    id: "openstatus-get-gate",
    hostId: "openstatus",
    description:
      "OpenStatus getGate Drizzle relational query vs Zod validation",
    revisions: [
      { label: "fixed", sha: "090709ad0a4c838215c321cf3d0cb76447cd4b5d" },
    ],
  },
];

/** Resolves the upstream repository URL or local clone path for a host. */
export function resolveHostRepositoryUrl(
  hostId: HostId,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const host = HOST_DEFINITIONS[hostId];
  const override = env[host.repositoryEnvVar]?.trim();
  return override !== undefined && override.length > 0
    ? override
    : host.defaultRepositoryUrl;
}

/**
 * Resolves the out-of-repo bare git cache directory, honoring
 * `VERULE_HOST_CACHE_DIR` and `XDG_CACHE_HOME`.
 */
export function resolveHostCacheDir(
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const explicit = env.VERULE_HOST_CACHE_DIR?.trim();
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const xdgCache = env.XDG_CACHE_HOME?.trim();
  const cacheBase =
    xdgCache !== undefined && xdgCache.length > 0
      ? xdgCache
      : join(homedir(), ".cache");
  return join(cacheBase, "verule", "host-repos");
}
