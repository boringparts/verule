import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { type PackedArtifact, startArtifactRegistry } from "../../src/index.ts";

const execFileAsync = promisify(execFile);

function createTestTarball(
  stageDir: string,
  outFile: string,
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
): PackedArtifact {
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
  }
  execFileSync("tar", ["-czf", outFile, "-C", stageDir, "package"], {
    stdio: "pipe",
  });
  const bytes = readFileSync(outFile);
  return {
    name: String(manifest.name),
    version: String(manifest.version),
    filename: outFile,
    size: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    sha1: createHash("sha1").update(bytes).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
    manifest,
  };
}

void test("serves packuments with release age metadata and tarballs over loopback HTTP", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-reg-unit-"));
  const artifact = createTestTarball(
    join(fixture.path, "stage"),
    join(fixture.path, "boringparts-verule-0.1.0.tgz"),
    {
      name: "@boringparts/verule",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
    },
    { "dist/index.js": "export const version = '0.1.0';\n" },
  );

  const registry = await startArtifactRegistry([artifact]);
  try {
    assert.match(registry.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.deepEqual(registry.scopes, ["@boringparts"]);

    const encodedRes = await fetch(`${registry.url}/@boringparts%2fverule`);
    assert.equal(encodedRes.status, 200);
    const packument = (await encodedRes.json()) as {
      name: string;
      time: Record<string, string>;
      versions: Record<
        string,
        { dist: { integrity: string; shasum: string; tarball: string } }
      >;
    };
    assert.equal(packument.name, "@boringparts/verule");
    assert.equal(packument.time["0.1.0"], "2020-01-01T00:00:00.000Z");
    const dist = packument.versions["0.1.0"]?.dist;
    assert.ok(dist);
    assert.equal(dist.shasum, artifact.sha1);
    assert.equal(dist.integrity, artifact.integrity);

    const tarballRes = await fetch(dist.tarball);
    assert.equal(tarballRes.status, 200);
    const downloaded = Buffer.from(await tarballRes.arrayBuffer());
    assert.equal(
      createHash("sha256").update(downloaded).digest("hex"),
      artifact.sha256,
    );

    const unencodedRes = await fetch(`${registry.url}/@boringparts/verule`);
    assert.equal(unencodedRes.status, 200);
  } finally {
    await registry.close();
  }
});

void test("resolves transitive tssae dependency from loopback registry in a fake pnpm host with minimumReleaseAge", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-reg-pnpm-"));
  const tssaeArtifact = createTestTarball(
    join(fixture.path, "stage-tssae"),
    join(fixture.path, "tssae-0.1.0.tgz"),
    {
      name: "tssae",
      version: "0.1.0",
      type: "module",
      exports: {
        ".": "./dist/index.js",
        "./package.json": "./package.json",
      },
    },
    {
      "dist/index.js": "export const engineExecutablePath = 'fake-engine';\n",
    },
  );
  const veruleArtifact = createTestTarball(
    join(fixture.path, "stage-verule"),
    join(fixture.path, "boringparts-verule-0.1.0.tgz"),
    {
      name: "@boringparts/verule",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
      dependencies: { tssae: "0.1.0" },
    },
    {
      "dist/index.js":
        "import { engineExecutablePath } from 'tssae';\nexport function getEngine() { return engineExecutablePath; }\n",
    },
  );

  const hostDir = join(fixture.path, "fake-host");
  mkdirSync(hostDir, { recursive: true });
  writeFileSync(
    join(hostDir, "package.json"),
    `${JSON.stringify({ name: "fake-host", private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(
    join(hostDir, "pnpm-workspace.yaml"),
    "minimumReleaseAge: 1440\npackages:\n  - '.'\n",
  );

  const cacheHome = join(fixture.path, "pnpm-cache");
  const storeDir = join(fixture.path, "pnpm-store");
  mkdirSync(cacheHome, { recursive: true });
  mkdirSync(storeDir, { recursive: true });

  const registry = await startArtifactRegistry(
    [tssaeArtifact, veruleArtifact],
    { upstreamRegistryUrl: null },
  );
  try {
    writeFileSync(
      join(hostDir, ".npmrc"),
      `registry=${registry.url}/\n@boringparts:registry=${registry.url}/\n`,
    );
    await execFileAsync(
      "pnpm",
      [
        "--store-dir",
        storeDir,
        "add",
        "--save-dev",
        "--workspace-root",
        "--ignore-scripts",
        "@boringparts/verule@0.1.0",
      ],
      {
        cwd: hostDir,
        env: {
          ...process.env,
          XDG_CACHE_HOME: cacheHome,
        },
      },
    );
  } finally {
    await registry.close();
  }

  const hostPkg = JSON.parse(
    readFileSync(join(hostDir, "package.json"), "utf8"),
  ) as { devDependencies: Record<string, string> };
  assert.deepEqual(Object.keys(hostPkg.devDependencies), [
    "@boringparts/verule",
  ]);

  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkResolved = hostRequire.resolve("@boringparts/verule");
  const sdkRequire = createRequire(sdkResolved);
  const tssaeResolved = sdkRequire.resolve("tssae");
  const hostReal = realpathSync(hostDir);
  assert.ok(realpathSync(sdkResolved).startsWith(hostReal + sep));
  assert.ok(realpathSync(tssaeResolved).startsWith(hostReal + sep));
  assert.ok(existsSync(tssaeResolved));
});
