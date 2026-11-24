export {
  CORE_VERULE_PACKAGES,
  packWorkspaceArtifacts,
  type PackedArtifact,
  type PackedArtifactBundle,
  type PackWorkspaceArtifactsOptions,
} from "./artifacts.ts";
export {
  DEFAULT_DIRECT_VERULE_PACKAGES,
  installArtifactPackages,
  type CommandOutcome,
  type InstallArtifactPackagesOptions,
  type InstallArtifactPackagesResult,
} from "./host-install.ts";
export {
  prepareAcceptanceHost,
  withAcceptanceHost,
  type HostCheckOptions,
  type HostRunCliOptions,
  type PrepareAcceptanceHostOptions,
  type PreparedAcceptanceHost,
  type StartHostSessionOptions,
  type StartHostWatchOptions,
} from "./host-lifecycle.ts";
export {
  copyAcceptanceHost,
  copyAcceptanceHostMaterial,
  readAcceptanceHostMaterial,
  type AcceptanceHostMaterialSource,
  type AcceptanceHostOverlay,
} from "./host-materials.ts";
export {
  resolveDefaultBlockedPaths,
  runBareVeruleInHost,
  spawnBareVeruleInHost,
  type BareVeruleRunResult,
  type IsolationEvidence,
  type IsolationMode,
  type RunBareVeruleOptions,
  type SpawnBareVeruleOptions,
  type SpawnedBareVerule,
} from "./isolation.ts";
export {
  addUnlistedProbePoolsFile,
  appendUnrelatedBackgroundComment,
  assertPoolOwnershipClean,
  assertPoolOwnershipDiagnostic,
  assertPoolOwnershipInitialFindings,
  assertPoolOwnershipReportsReconcile,
  fixPoolOwnershipViolation,
  fixUnlistedProbePool,
  generatePoolOwnershipProject,
  materializePoolOwnershipHost,
  POOL_OWNERSHIP_SMALL_SCALE,
  POOL_OWNERSHIP_TIERS,
  removeUnlistedProbePoolsFile,
  restorePoolOwnershipViolation,
  verifyPoolOwnershipScaleAndCandidates,
  withPoolOwnershipHost,
  type GeneratedPoolOwnershipProject,
  type PoolOwnershipCandidateAudit,
  type PoolOwnershipMaterializedSpec,
  type PoolOwnershipScaleSpec,
  type WithPoolOwnershipHostOptions,
} from "./pool-ownership-scenario.ts";
export {
  parseCheckJsonResult,
  startSharedSessionProcess,
  startWatchProcess,
  type AcceptanceSharedSession,
  type AcceptanceWatchSession,
  type CliCheckResult,
  type NdjsonEnvelope,
  type ProcessExitSummary,
  type SessionCheckOptions,
  type SessionReadyRecord,
  type StartSharedSessionProcessOptions,
  type StartWatchProcessOptions,
  type WatchFailureRecord,
  type WatchMemoryStats,
  type WatchRecomputationScope,
  type WatchReportRecord,
  type WatchStreamEvent,
} from "./process-stream.ts";
export {
  startArtifactRegistry,
  type ScopedRegistryServer,
} from "./registry.ts";
export type { PackageManager } from "./types.ts";
export {
  verifyHostArtifactResolution,
  verifyInstalledNativeLibrary,
  type HostResolutionAudit,
  type VerifiedNativeLibrary,
  type VerifyHostResolutionOptions,
  type VerifyInstalledNativeLibraryOptions,
} from "./verify.ts";
