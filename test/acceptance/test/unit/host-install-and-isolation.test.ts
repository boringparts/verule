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
  verifyHostArtifactResolution,
} from "../../src/index.ts";

function createFakeVeruleTarballs(
  dir: string,
  engineVersion = "0.0.0-test",
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
    process.platform === "win32" ? "verule-engine.exe" : "verule-engine";
  const engineBase = pack(
    "stage-engine",
    "verule-engine-0.0.0.tgz",
    {
      name: "@verule/engine",
      version: "0.0.0",
      type: "module",
      exports: { "./binary": "./dist/binary.js" },
    },
    {
      "dist/binary.js": `import { fileURLToPath } from 'node:url';\nexport const engineExecutablePath = fileURLToPath(new URL('./bin/${executableName}', import.meta.url));\n`,
      [`dist/bin/${executableName}`]: engineScript,
    },
    [`dist/bin/${executableName}`],
  );
  const engine: PackedArtifact = { ...engineBase, binarySha256 };

  const sdk = pack(
    "stage-sdk",
    "verule-sdk-0.0.0.tgz",
    {
      name: "@verule/sdk",
      version: "0.0.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
      dependencies: { "@verule/engine": "0.0.0" },
    },
    {
      "dist/index.js":
        "import { execFile } from 'node:child_process';\nimport { promisify } from 'node:util';\nimport { engineExecutablePath } from '@verule/engine/binary';\nconst run = promisify(execFile);\nexport async function getEngineVersion() { const { stdout } = await run(engineExecutablePath, ['--version']); return stdout.trimEnd(); }\n",
    },
  );

  const cli = pack(
    "stage-cli",
    "verule-cli-0.0.0.tgz",
    {
      name: "@verule/cli",
      version: "0.0.0",
      type: "module",
      bin: { verule: "./dist/cli.js" },
      dependencies: { "@verule/sdk": "0.0.0" },
    },
    {
      "dist/cli.js":
        "#!/usr/bin/env node\nimport { getEngineVersion } from '@verule/sdk';\nif (process.argv.includes('--version')) { console.log('verule 0.0.0'); } else { console.log(`verule 0.0.0 (engine ${await getEngineVersion()})`); }\n",
    },
    ["dist/cli.js"],
  );

  return { artifacts: [engine, sdk, cli], binarySha256 };
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

  const installOutcome = await installArtifactPackages({
    checkoutDir: hostDir,
    packageManager: "pnpm",
    artifacts,
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
  assert.deepEqual(Object.keys(devDeps).toSorted(), [
    "@verule/cli",
    "@verule/sdk",
  ]);
  assert.equal("@verule/engine" in devDeps, false);

  const audit = await verifyHostArtifactResolution({
    checkoutDir: hostDir,
    artifacts,
    blockedPaths: [devRepoDir],
  });
  assert.equal(audit.cliVersion, "0.0.0");
  assert.equal(audit.engineBinarySha256, binarySha256);
  assert.ok(audit.workspaceSymlinkCount >= 1);

  const bareRun = await runBareVeruleInHost({
    checkoutDir: hostDir,
    args: [],
    isolated: true,
    blockedPaths: [devRepoDir],
  });
  assert.equal(bareRun.status, 0, bareRun.stderr);
  assert.equal(bareRun.stdout, "verule 0.0.0 (engine 0.0.0-test)\n");
  assert.equal(bareRun.isolation?.controlProbeBlocked, true);

  const versionRun = await runBareVeruleInHost({
    checkoutDir: hostDir,
    args: ["--version"],
    isolated: true,
    blockedPaths: [devRepoDir],
  });
  assert.equal(versionRun.status, 0, versionRun.stderr);
  assert.equal(versionRun.stdout, "verule 0.0.0\n");

  symlinkSync(devRepoDir, join(hostDir, "node_modules", "leak-link"));
  await assert.rejects(
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
    firstBatch.artifacts.find((artifact) => artifact.name === "@verule/engine")
      ?.sha256,
    secondBatch.artifacts.find((artifact) => artifact.name === "@verule/engine")
      ?.sha256,
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
  assert.equal(firstRun.stdout, "verule 0.0.0 (engine 0.0.0-test-a)\n");
  assert.equal(secondRun.status, 0, secondRun.stderr);
  assert.equal(secondRun.stdout, "verule 0.0.0 (engine 0.0.0-test-b)\n");

  const cacheHomes = readFileSync(cacheRecordPath, "utf8").trim().split("\n");
  assert.equal(cacheHomes.length, 2);
  assert.notEqual(cacheHomes[0], cacheHomes[1]);
  assert.ok(cacheHomes.every((path) => path !== callerCacheHome));
  assert.ok(cacheHomes.every((path) => !existsSync(path)));
  assert.equal(process.env.XDG_CACHE_HOME, originalXdgCacheHome);
});
