import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";

import {
  installArtifactPackages,
  type PackedArtifact,
  runBareVeruleInHost,
  spawnBareVeruleInHost,
  startSharedSessionProcess,
  startWatchProcess,
  verifyHostArtifactResolution,
} from "../../src/index.ts";

function createFakeVeruleTarballs(
  dir: string,
  engineVersion = "0.0.0-test",
  options: {
    readonly veruleEngines?: Readonly<Record<string, string>>;
    readonly cliScript?: string;
  } = {},
): {
  readonly artifacts: readonly PackedArtifact[];
  readonly binarySha256: string;
} {
  function pack(
    subDir: string,
    outFile: string,
    manifest: Record<string, unknown>,
    files: Readonly<Record<string, string>>,
    executables: readonly string[] = [],
  ): PackedArtifact {
    const stageDir = join(dir, subDir);
    const pkgRoot = join(stageDir, "package");
    mkdirSync(pkgRoot, { recursive: true });
    writeFileSync(
      join(pkgRoot, "package.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    for (const [relativePath, content] of Object.entries(files)) {
      const target = join(pkgRoot, relativePath);
      mkdirSync(join(target, ".."), { recursive: true });
      writeFileSync(target, content);
      if (executables.includes(relativePath)) {
        chmodSync(target, 0o755);
      }
    }
    const tarPath = join(dir, outFile);
    execFileSync("tar", ["-czf", tarPath, "-C", stageDir, "package"], {
      stdio: "pipe",
    });
    const bytes = readFileSync(tarPath);
    return {
      name: String(manifest.name),
      version: String(manifest.version),
      filename: tarPath,
      size: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      sha1: createHash("sha1").update(bytes).digest("hex"),
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      manifest,
    };
  }

  const engineScript = `#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log(${JSON.stringify(engineVersion)}); process.exit(0); }\nprocess.exit(2);\n`;
  const binarySha256 = createHash("sha256").update(engineScript).digest("hex");
  const executableName =
    process.platform === "win32" ? "tssae-engine.exe" : "tssae-engine";
  const engineBase = pack(
    "stage-tssae",
    "tssae-0.1.0.tgz",
    {
      name: "tssae",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
        "./package.json": "./package.json",
      },
    },
    {
      "dist/index.js": `import { execFile } from 'node:child_process';\nimport { fileURLToPath } from 'node:url';\nimport { promisify } from 'node:util';\nconst run = promisify(execFile);\nconst engineExecutablePath = fileURLToPath(new URL('./bin/${executableName}', import.meta.url));\nexport async function getEngineVersion() { const { stdout } = await run(engineExecutablePath, ['--version']); return stdout.trimEnd(); }\n`,
      "dist/index.d.ts":
        "export declare function getEngineVersion(): Promise<string>;\n",
      [`dist/bin/${executableName}`]: engineScript,
    },
    [`dist/bin/${executableName}`],
  );
  const engine: PackedArtifact = { ...engineBase, binarySha256 };

  const verule = pack(
    "stage-verule",
    "boringparts-verule-0.1.0.tgz",
    {
      name: "@boringparts/verule",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
      bin: { verule: "./dist/cli.js" },
      dependencies: { tssae: "0.1.0" },
      ...(options.veruleEngines === undefined
        ? {}
        : { engines: options.veruleEngines }),
    },
    {
      "dist/index.js": "export { getEngineVersion } from 'tssae';\n",
      "dist/cli.js":
        options.cliScript ??
        "#!/usr/bin/env node\nimport { readFileSync, writeFileSync } from 'node:fs';\nimport { getEngineVersion } from '@boringparts/verule';\nif (process.env.VERULE_SHARED_PROBE) { writeFileSync(process.env.VERULE_SHARED_PROBE, 'shared-ok'); process.stdout.write(readFileSync(process.env.VERULE_SHARED_PROBE, 'utf8') + '\\n'); }\nif (process.argv.includes('--version')) { console.log('verule 0.1.0'); } else { console.log(`verule 0.1.0 (engine ${await getEngineVersion()})`); }\n",
    },
    ["dist/cli.js"],
  );

  return { artifacts: [engine, verule], binarySha256 };
}

void test("installs direct dependencies in a fake host, allows workspace symlinks, blocks dev-repo reads, and runs bare verule", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-host-install-"));
  const devRepoDir = join(fixture.path, "dev-repo");
  mkdirSync(devRepoDir, { recursive: true });
  writeFileSync(join(devRepoDir, "package.json"), '{"name":"dev-repo"}\n');

  const bundleDir = join(fixture.path, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const { artifacts, binarySha256 } = createFakeVeruleTarballs(bundleDir);

  const hostDir = join(fixture.path, "fake-pnpm-host");
  mkdirSync(join(hostDir, "packages", "shared"), { recursive: true });
  mkdirSync(join(hostDir, "node_modules", "@host"), { recursive: true });
  writeFileSync(
    join(hostDir, "package.json"),
    '{"name":"fake-pnpm-host","private":true,"type":"module"}\n',
  );
  writeFileSync(
    join(hostDir, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n",
  );
  writeFileSync(
    join(hostDir, "packages", "shared", "package.json"),
    '{"name":"@host/shared","version":"1.0.0"}\n',
  );
  symlinkSync(
    "../../packages/shared",
    join(hostDir, "node_modules", "@host", "shared"),
  );
  writeFileSync(join(hostDir, ".npmrc"), "auto-install-peers=true\n");

  const storeDir = join(fixture.path, "store");
  mkdirSync(storeDir, { recursive: true });

  const installOutcome = await installArtifactPackages({
    checkoutDir: hostDir,
    packageManager: "pnpm",
    artifacts,
    storeDir,
  });
  assert.equal(installOutcome.status, "ready");
  assert.equal(
    readFileSync(join(hostDir, ".npmrc"), "utf8"),
    "auto-install-peers=true\n",
  );

  const hostManifest: unknown = JSON.parse(
    readFileSync(join(hostDir, "package.json"), "utf8"),
  );
  const devDeps =
    typeof hostManifest === "object" &&
    hostManifest !== null &&
    "devDependencies" in hostManifest &&
    typeof hostManifest.devDependencies === "object" &&
    hostManifest.devDependencies !== null
      ? hostManifest.devDependencies
      : {};
  assert.deepEqual(Object.keys(devDeps).toSorted(), ["@boringparts/verule"]);
  assert.equal("tssae" in devDeps, false);

  const audit = verifyHostArtifactResolution({
    checkoutDir: hostDir,
    artifacts,
    blockedPaths: [devRepoDir],
    allowedStorePaths: [storeDir],
  });
  assert.equal(audit.cliVersion, "0.1.0");
  assert.equal(audit.engineBinarySha256, binarySha256);
  assert.ok(audit.workspaceSymlinkCount >= 1);

  const bareRun = await runBareVeruleInHost({
    checkoutDir: hostDir,
    args: [],
    isolated: true,
    blockedPaths: [devRepoDir],
    pnpmStoreDir: storeDir,
  });
  assert.equal(bareRun.status, 0, bareRun.stderr);
  assert.equal(bareRun.stdout, "verule 0.1.0 (engine 0.0.0-test)\n");
  assert.equal(bareRun.isolation?.controlProbeBlocked, true);

  const versionRun = await runBareVeruleInHost({
    checkoutDir: hostDir,
    args: ["--version"],
    isolated: true,
    blockedPaths: [devRepoDir],
    pnpmStoreDir: storeDir,
  });
  assert.equal(versionRun.status, 0, versionRun.stderr);
  assert.equal(versionRun.stdout, "verule 0.1.0\n");

  symlinkSync(devRepoDir, join(hostDir, "node_modules", "leak-link"));
  assert.throws(
    () =>
      verifyHostArtifactResolution({
        checkoutDir: hostDir,
        artifacts,
        blockedPaths: [devRepoDir],
      }),
    /development repository/iu,
  );
});

void test("isolates pnpm metadata for repeated same-version artifact batches", async () => {
  using fixture = mkdtempDisposableSync(
    join(tmpdir(), "verule-artifact-batches-"),
  );
  const firstBundleDir = join(fixture.path, "first-bundle");
  const secondBundleDir = join(fixture.path, "second-bundle");
  mkdirSync(firstBundleDir);
  mkdirSync(secondBundleDir);
  const firstBatch = createFakeVeruleTarballs(firstBundleDir, "0.0.0-test-a");
  const secondBatch = createFakeVeruleTarballs(secondBundleDir, "0.0.0-test-b");
  assert.notEqual(
    firstBatch.artifacts.find((artifact) => artifact.name === "tssae")?.sha256,
    secondBatch.artifacts.find((artifact) => artifact.name === "tssae")?.sha256,
  );

  const pnpmShimDir = join(fixture.path, "pnpm-shim");
  mkdirSync(pnpmShimDir);
  const pnpmExecutable = execFileSync("which", ["pnpm"], {
    encoding: "utf8",
  }).trim();
  const cacheRecordPath = join(fixture.path, "cache-homes.txt");
  const pnpmShimPath = join(pnpmShimDir, "pnpm");
  writeFileSync(
    pnpmShimPath,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const recordPath = process.env.PNPM_CACHE_RECORD;
const executablePath = process.env.PNPM_REAL_PATH;
if (recordPath === undefined || executablePath === undefined) {
  throw new Error("Missing pnpm shim configuration");
}
appendFileSync(
  recordPath,
  (process.env.XDG_CACHE_HOME ?? "") + String.fromCharCode(10),
);
const result = spawnSync(executablePath, process.argv.slice(2), {
  env: process.env,
  stdio: "inherit",
});
process.exit(result.status ?? 1);
`,
  );
  chmodSync(pnpmShimPath, 0o755);

  const originalXdgCacheHome = process.env.XDG_CACHE_HOME;
  const callerCacheHome = join(fixture.path, "caller-cache");
  mkdirSync(callerCacheHome);
  const installEnv = {
    ...process.env,
    PATH: `${pnpmShimDir}${delimiter}${process.env.PATH ?? ""}`,
    XDG_CACHE_HOME: callerCacheHome,
    PNPM_CACHE_RECORD: cacheRecordPath,
    PNPM_REAL_PATH: pnpmExecutable,
  };

  const firstHost = join(fixture.path, "first-host");
  const secondHost = join(fixture.path, "second-host");
  const firstStore = join(fixture.path, "first-store");
  const secondStore = join(fixture.path, "second-store");
  for (const dir of [firstHost, secondHost, firstStore, secondStore]) {
    mkdirSync(dir);
  }
  for (const host of [firstHost, secondHost]) {
    writeFileSync(
      join(host, "package.json"),
      '{"name":"artifact-batch-host","private":true}\n',
    );
  }

  const firstInstall = await installArtifactPackages({
    checkoutDir: firstHost,
    packageManager: "pnpm",
    artifacts: firstBatch.artifacts,
    storeDir: firstStore,
    env: installEnv,
  });
  assert.equal(firstInstall.status, "ready", JSON.stringify(firstInstall));
  const secondInstall = await installArtifactPackages({
    checkoutDir: secondHost,
    packageManager: "pnpm",
    artifacts: secondBatch.artifacts,
    storeDir: secondStore,
    env: installEnv,
  });
  assert.equal(secondInstall.status, "ready", JSON.stringify(secondInstall));

  const firstRun = await runBareVeruleInHost({
    checkoutDir: firstHost,
    args: [],
  });
  const secondRun = await runBareVeruleInHost({
    checkoutDir: secondHost,
    args: [],
  });
  assert.equal(firstRun.status, 0, firstRun.stderr);
  assert.equal(firstRun.stdout, "verule 0.1.0 (engine 0.0.0-test-a)\n");
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.equal(secondRun.stdout, "verule 0.1.0 (engine 0.0.0-test-b)\n");

  const cacheHomes = readFileSync(cacheRecordPath, "utf8").trim().split("\n");
  assert.equal(cacheHomes.length, 2);
  assert.notEqual(cacheHomes[0], cacheHomes[1]);
  assert.ok(cacheHomes.every((path) => path !== callerCacheHome));
  assert.ok(cacheHomes.every((path) => !existsSync(path)));
  assert.equal(process.env.XDG_CACHE_HOME, originalXdgCacheHome);
});

void test("spawns an isolated bare verule child with sharedReadWritePaths outside hostDir", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-spawn-iso-"));
  const devRepoDir = join(fixture.path, "dev-repo");
  const sharedDir = join(fixture.path, "shared-runtime");
  const hostDir = join(fixture.path, "host");
  const bundleDir = join(fixture.path, "bundle");
  const storeDir = join(fixture.path, "store");
  for (const dir of [devRepoDir, sharedDir, hostDir, bundleDir, storeDir]) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(join(devRepoDir, "package.json"), '{"name":"dev-repo"}\n');
  writeFileSync(
    join(hostDir, "package.json"),
    '{"name":"spawn-iso-host","private":true,"type":"module"}\n',
  );

  const bundle = createFakeVeruleTarballs(bundleDir, "0.0.0-spawn");
  const installOutcome = await installArtifactPackages({
    checkoutDir: hostDir,
    packageManager: "pnpm",
    artifacts: bundle.artifacts,
    storeDir,
  });
  assert.equal(installOutcome.status, "ready");

  const spawned = await spawnBareVeruleInHost({
    checkoutDir: hostDir,
    args: ["--version"],
    isolated: true,
    blockedPaths: [devRepoDir],
    pnpmStoreDir: storeDir,
    sharedReadWritePaths: [sharedDir],
    env: {
      ...process.env,
      VERULE_SHARED_PROBE: join(sharedDir, "probe.txt"),
    },
  });
  assert.equal(spawned.isolation?.controlProbeBlocked, true);
  let stdout = "";
  let stderr = "";
  spawned.child.stdout?.setEncoding("utf8");
  spawned.child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  spawned.child.stderr?.setEncoding("utf8");
  spawned.child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const exitCode = await new Promise<number | null>(
    (resolveExit, rejectExit) => {
      spawned.child.once("error", rejectExit);
      spawned.child.once("close", (code) => resolveExit(code));
    },
  );
  assert.equal(exitCode, 0, stderr);
  assert.equal(stdout, "shared-ok\nverule 0.1.0\n");
  assert.equal(readFileSync(join(sharedDir, "probe.txt"), "utf8"), "shared-ok");

  const sharedWriteCheck = await runBareVeruleInHost({
    checkoutDir: hostDir,
    args: [],
    isolated: true,
    blockedPaths: [devRepoDir],
    pnpmStoreDir: storeDir,
    sharedReadWritePaths: [sharedDir],
    env: {
      ...process.env,
      VERULE_SHARED_PROBE: join(sharedDir, "probe-run.txt"),
    },
  });
  assert.equal(sharedWriteCheck.status, 0, sharedWriteCheck.stderr);
  assert.equal(sharedWriteCheck.isolation?.controlProbeBlocked, true);
  assert.equal(
    readFileSync(join(sharedDir, "probe-run.txt"), "utf8"),
    "shared-ok",
  );
});

void test("rejects packages requiring Node ^26.13.1 under strict engine checking on Node 24.0.0", async () => {
  using fixture = mkdtempDisposableSync(
    join(tmpdir(), "verule-engine-strict-"),
  );
  const bundleDir = join(fixture.path, "bundle");
  mkdirSync(bundleDir, { recursive: true });
  const { artifacts } = createFakeVeruleTarballs(bundleDir, "0.0.0-engine", {
    veruleEngines: { node: "^26.13.1" },
  });

  for (const packageManager of ["pnpm", "npm"] as const) {
    const hostDir = join(fixture.path, `host-${packageManager}`);
    const storeDir = join(fixture.path, `store-${packageManager}`);
    mkdirSync(hostDir, { recursive: true });
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(
      join(hostDir, "package.json"),
      JSON.stringify({
        name: `strict-${packageManager}-host`,
        private: true,
        type: "module",
      }),
    );

    const outcome = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager,
      artifacts,
      storeDir,
    });
    assert.equal(
      outcome.status,
      "install-failed",
      `Expected ${packageManager} strict engine check to reject ^26.13.1 under Node 24.0.0`,
    );
    assert.match(
      outcome.stderr,
      /ERR_PNPM_UNSUPPORTED_ENGINE|EBADENGINE/u,
      outcome.stderr,
    );
    assert.match(outcome.stderr, /24\.0\.0/u, outcome.stderr);
  }
});

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForPidFile(
  filePath: string,
  timeoutMs = 5_000,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(filePath)) {
      const parsed = Number(readFileSync(filePath, "utf8").trim());
      if (Number.isInteger(parsed) && parsed > 0) {
        return parsed;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for PID file: ${filePath}`);
}

function installFakeBwrap(binDir: string): string {
  const fakeBwrapPath = join(binDir, "bwrap");
  writeFileSync(
    fakeBwrapPath,
    `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
const separatorIndex = args.indexOf("--");
if (separatorIndex === -1 || separatorIndex + 1 >= args.length) {
  process.stderr.write("fake bwrap missing -- separator\\n");
  process.exit(2);
}
const blockedTmpfsPaths = [];
for (let index = 0; index < separatorIndex; index += 1) {
  if (args[index] === "--tmpfs" && index + 1 < separatorIndex) {
    blockedTmpfsPaths.push(args[index + 1]);
  }
}
const command = args[separatorIndex + 1];
const commandArgs = args.slice(separatorIndex + 2);
if (
  blockedTmpfsPaths.some((blocked) =>
    commandArgs.some((arg) => arg === blocked || arg.startsWith(\`\${blocked}/\`)),
  )
) {
  process.stderr.write("ENOENT: blocked by fake bwrap --tmpfs\\n");
  process.exit(1);
}

const pidLog = process.env.VERULE_FAKE_BWRAP_PID_LOG;
if (pidLog && command !== "true") {
  appendFileSync(pidLog, \`\${String(process.pid)}\\n\`);
}

// Keep real /usr/bin/bwrap's default signal disposition so direct SIGINT kills
// the wrapper immediately instead of letting the sandboxed process shut down cleanly.
const child = spawn(command, commandArgs, { stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal !== null) {
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 1);
});
`,
  );
  chmodSync(fakeBwrapPath, 0o755);
  return fakeBwrapPath;
}

void test(
  "kills bwrap wrapper and SIGINT-ignoring grandchild processes across process groups on close and timeout",
  { skip: process.platform !== "linux" },
  async () => {
    using fixture = mkdtempDisposableSync(
      join(tmpdir(), "verule-bwrap-pg-cleanup-"),
    );
    const devRepoDir = join(fixture.path, "dev-repo");
    const fakeBinDir = join(fixture.path, "fake-bin");
    const bundleDir = join(fixture.path, "bundle");
    const hostDir = join(fixture.path, "host");
    const storeDir = join(fixture.path, "store");
    for (const dir of [devRepoDir, fakeBinDir, bundleDir, hostDir, storeDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(devRepoDir, "package.json"), '{"name":"dev-repo"}\n');
    writeFileSync(
      join(hostDir, "package.json"),
      '{"name":"bwrap-pg-host","private":true,"type":"module"}\n',
    );

    const pidLogPath = join(fixture.path, "bwrap-wrapper-pids.log");
    installFakeBwrap(fakeBinDir);

    const hangWithGrandchildCli = `#!/usr/bin/env node
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

process.on("SIGINT", () => {});
process.on("SIGTERM", () => {});

const command = process.argv[2] ?? "check";
writeFileSync(join(process.cwd(), \`\${command}.cli.pid\`), String(process.pid));

spawn(
  process.execPath,
  [
    "-e",
    [
      'const { writeFileSync } = require("node:fs");',
      'process.on("SIGINT", () => {});',
      'process.on("SIGTERM", () => {});',
      'writeFileSync(process.argv[1], String(process.pid));',
      'setInterval(() => {}, 1_000);',
      'process.stdin.resume();',
    ].join("\\n"),
    join(process.cwd(), \`\${command}.grandchild.pid\`),
  ],
  { stdio: "inherit" },
);

if (command === "watch") {
  process.stdout.write(JSON.stringify({ kind: "stream", command: "verule watch" }) + "\\n");
}
setInterval(() => {}, 1_000);
process.stdin.resume();
`;

    const bundle = createFakeVeruleTarballs(bundleDir, "0.0.0-bwrap-pg", {
      cliScript: hangWithGrandchildCli,
    });
    const installOutcome = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      storeDir,
    });
    assert.equal(installOutcome.status, "ready");

    const originalPath = process.env.PATH;
    const originalPidLog = process.env.VERULE_FAKE_BWRAP_PID_LOG;
    const trackedPids = new Set<number>();

    const trackFromFile = (pidFile: string): number => {
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0) {
        trackedPids.add(pid);
      }
      return pid;
    };

    try {
      process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;
      process.env.VERULE_FAKE_BWRAP_PID_LOG = pidLogPath;

      const watch = await startWatchProcess({
        checkoutDir: hostDir,
        isolated: true,
        blockedPaths: [devRepoDir],
        pnpmStoreDir: storeDir,
      });
      assert.equal(watch.isolation?.mode, "bwrap");
      const watchCliPid = await waitForPidFile(join(hostDir, "watch.cli.pid"));
      const watchGrandchildPid = await waitForPidFile(
        join(hostDir, "watch.grandchild.pid"),
      );
      trackedPids.add(watchCliPid);
      trackedPids.add(watchGrandchildPid);

      await assert.rejects(
        () => watch.nextReport({ timeoutMs: 150 }),
        /Timed out waiting for watch report/u,
      );

      const closeStartedAt = performance.now();
      await watch.close({ timeoutMs: 200 });
      const closeDurationMs = performance.now() - closeStartedAt;

      const wrapperPidsAfterWatch = readFileSync(pidLogPath, "utf8")
        .trim()
        .split("\n")
        .map(Number)
        .filter((pid) => Number.isInteger(pid) && pid > 0);
      for (const pid of wrapperPidsAfterWatch) {
        trackedPids.add(pid);
      }

      assert.ok(
        closeDurationMs < 1_500,
        `Expected watch.close() to release process group promptly, took ${String(Math.round(closeDurationMs))}ms`,
      );
      for (const wrapperPid of wrapperPidsAfterWatch) {
        assert.equal(
          isProcessAlive(wrapperPid),
          false,
          `Expected fake bwrap wrapper (${String(wrapperPid)}) to be dead`,
        );
      }
      assert.equal(
        isProcessAlive(watchCliPid),
        false,
        `Expected watch CLI (${String(watchCliPid)}) to be dead`,
      );
      assert.equal(
        isProcessAlive(watchGrandchildPid),
        false,
        `Expected watch grandchild (${String(watchGrandchildPid)}) to be dead`,
      );

      await assert.rejects(
        () =>
          startSharedSessionProcess({
            checkoutDir: hostDir,
            socketPath: join(fixture.path, "hang-session.sock"),
            isolated: true,
            blockedPaths: [devRepoDir],
            pnpmStoreDir: storeDir,
            timeoutMs: 500,
          }),
        /Timed out waiting for shared session ready/u,
      );
      const sessionCliPid = trackFromFile(join(hostDir, "session.cli.pid"));
      const sessionGrandchildPid = trackFromFile(
        join(hostDir, "session.grandchild.pid"),
      );
      assert.equal(
        isProcessAlive(sessionCliPid),
        false,
        `Expected session CLI (${String(sessionCliPid)}) to be dead`,
      );
      assert.equal(
        isProcessAlive(sessionGrandchildPid),
        false,
        `Expected session grandchild (${String(sessionGrandchildPid)}) to be dead`,
      );

      const runResult = await runBareVeruleInHost({
        checkoutDir: hostDir,
        args: ["check"],
        isolated: true,
        blockedPaths: [devRepoDir],
        pnpmStoreDir: storeDir,
        timeoutMs: 500,
      });
      assert.equal(runResult.isolation?.mode, "bwrap");
      assert.equal(runResult.timedOut, true);
      const checkCliPid = trackFromFile(join(hostDir, "check.cli.pid"));
      const checkGrandchildPid = trackFromFile(
        join(hostDir, "check.grandchild.pid"),
      );
      assert.equal(
        isProcessAlive(checkCliPid),
        false,
        `Expected check CLI (${String(checkCliPid)}) to be dead`,
      );
      assert.equal(
        isProcessAlive(checkGrandchildPid),
        false,
        `Expected check grandchild (${String(checkGrandchildPid)}) to be dead`,
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
      if (originalPidLog === undefined) {
        delete process.env.VERULE_FAKE_BWRAP_PID_LOG;
      } else {
        process.env.VERULE_FAKE_BWRAP_PID_LOG = originalPidLog;
      }
      for (const pid of trackedPids) {
        if (isProcessAlive(pid)) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Ignore cleanup failure for already-exited processes.
          }
        }
      }
    }
  },
);

void test(
  "closes bwrap-isolated watch and session cleanly with exit code 0 on stdin EOF",
  { skip: process.platform !== "linux" },
  async () => {
    using fixture = mkdtempDisposableSync(
      join(tmpdir(), "verule-bwrap-graceful-eof-"),
    );
    const devRepoDir = join(fixture.path, "dev-repo");
    const fakeBinDir = join(fixture.path, "fake-bin");
    const bundleDir = join(fixture.path, "bundle");
    const hostDir = join(fixture.path, "host");
    const storeDir = join(fixture.path, "store");
    for (const dir of [devRepoDir, fakeBinDir, bundleDir, hostDir, storeDir]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(devRepoDir, "package.json"), '{"name":"dev-repo"}\n');
    writeFileSync(
      join(hostDir, "package.json"),
      '{"name":"bwrap-graceful-host","private":true,"type":"module"}\n',
    );

    installFakeBwrap(fakeBinDir);

    const gracefulCli = `#!/usr/bin/env node
import { createServer } from "node:net";
import { rmSync } from "node:fs";

const args = process.argv.slice(2);
const command = args[0] ?? "check";

if (command === "watch") {
  process.stdout.write(JSON.stringify({ kind: "stream", command: "verule watch" }) + "\\n");
  process.stdin.once("end", () => {
    process.stdout.write(JSON.stringify({ kind: "streamSuccess" }) + "\\n");
    process.exit(0);
  });
  process.stdin.resume();
}

if (command === "session") {
  const socketIdx = args.indexOf("--socket");
  const socketPath = args[socketIdx + 1];
  const server = createServer((socket) => {
    socket.end("{}\\n");
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  process.stdout.write(JSON.stringify({ kind: "stream", command: "verule session" }) + "\\n");
  process.stdout.write(
    JSON.stringify({
      kind: "record",
      variant: "ready",
      data: {
        reportVersion: "1",
        endpoint: socketPath,
        snapshotId: 1,
        projects: [],
      },
    }) + "\\n",
  );
  process.stdin.once("end", () => {
    server.close(() => {
      rmSync(socketPath, { force: true });
      process.stdout.write(JSON.stringify({ kind: "streamSuccess" }) + "\\n");
      process.exit(0);
    });
  });
  process.stdin.resume();
}
`;

    const bundle = createFakeVeruleTarballs(bundleDir, "0.0.0-bwrap-eof", {
      cliScript: gracefulCli,
    });
    const installOutcome = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      storeDir,
    });
    assert.equal(installOutcome.status, "ready");

    const originalPath = process.env.PATH;
    try {
      process.env.PATH = `${fakeBinDir}${delimiter}${originalPath ?? ""}`;

      const watch = await startWatchProcess({
        checkoutDir: hostDir,
        isolated: true,
        blockedPaths: [devRepoDir],
        pnpmStoreDir: storeDir,
      });
      assert.equal(watch.isolation?.mode, "bwrap");
      const watchExit = await watch.close();
      assert.equal(watchExit.code, 0, watchExit.stderr);
      assert.equal(watchExit.signal, null);
      assert.ok(
        watchExit.records.some((record) => record.kind === "streamSuccess"),
      );

      const session = await startSharedSessionProcess({
        checkoutDir: hostDir,
        socketPath: join(fixture.path, "graceful-session.sock"),
        isolated: true,
        blockedPaths: [devRepoDir],
        pnpmStoreDir: storeDir,
      });
      assert.equal(session.isolation?.mode, "bwrap");
      const sessionExit = await session.close();
      assert.equal(sessionExit.code, 0, sessionExit.stderr);
      assert.equal(sessionExit.signal, null);
      assert.ok(
        sessionExit.records.some((record) => record.kind === "streamSuccess"),
      );
    } finally {
      if (originalPath === undefined) {
        delete process.env.PATH;
      } else {
        process.env.PATH = originalPath;
      }
    }
  },
);
