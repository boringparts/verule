export {
  runCleanupsLifo,
  runCleanupsLifoSync,
  type CleanupFn,
} from "./cleanup.ts";
export {
  copyDirectory,
  createHostFileAccessors,
  linkNodeModulesPackage,
  normalizeLineEndings,
  resolveHostDir,
  resolvePathInsideRoot,
  writeHostFiles,
  writeSyntheticPackage,
  type CopyDirectoryOptions,
  type HostFileAccessors,
  type LineEnding,
  type SyntheticPackageSpec,
} from "./materials.ts";
export {
  prepareTempHost,
  withTempHost,
  type PreparedTempHost,
  type PrepareTempHostOptions,
} from "./temp-host.ts";
export { runTscTypecheck, type HostTypecheckResult } from "./typecheck.ts";
