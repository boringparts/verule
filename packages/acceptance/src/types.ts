export type HostId = "vscode" | "vue" | "openstatus";

export type PackageManager = "npm" | "pnpm";

export type HostDefinition = {
  readonly id: HostId;
  readonly displayName: string;
  readonly defaultRepositoryUrl: string;
  readonly repositoryEnvVar: string;
  readonly packageManager: PackageManager;
  readonly restoreCommand: readonly [string, ...string[]];
};

export type HostRevision = {
  readonly label: string;
  readonly sha: string;
};

export type HostScenario = {
  readonly id: string;
  readonly hostId: HostId;
  readonly description: string;
  readonly revisions: readonly HostRevision[];
};

export type PreparationStage =
  | "pack-artifacts"
  | "git-fetch"
  | "git-checkout"
  | "restore-dependencies"
  | "install-artifacts";

export type PreparationFailure = {
  readonly status: "preparation-failed";
  readonly stage: PreparationStage;
  readonly hostId: HostId;
  readonly sha: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly message: string;
  readonly stderr?: string;
};

export type CheckedOutHost = {
  readonly status: "ready";
  readonly hostId: HostId;
  readonly sha: string;
  readonly checkoutDir: string;
  cleanup(): void;
};

export type HostCheckoutOutcome = CheckedOutHost | PreparationFailure;
