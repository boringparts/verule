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
    join(fixture.path, "verule-sdk-0.0.0.tgz"),
    {
      name: "@verule/sdk",
      version: "0.0.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
    },
    { "dist/index.js": "export const version = '0.0.0';\n" },
  );

  const registry = await startArtifactRegistry([artifact]);
  try {
    assert.match(registry.url, /^http:\/\/127\.0\.0\.1:\d+$/u);
    assert.deepEqual(registry.scopes, ["@verule"]);

    const encodedRes = await fetch(`${registry.url}/@verule%2fsdk`);
    assert.equal(encodedRes.status, 200);
    const packument = (await encodedRes.json()) as {
      name: string;
      time: Record<string, string>;
      versions: Record<
        string,
        { dist: { integrity: string; shasum: string; tarball: string } }
      >;
    };
    assert.equal(packument.name, "@verule/sdk");
    assert.equal(packument.time["0.0.0"], "2020-01-01T00:00:00.000Z");
    const dist = packument.versions["0.0.0"]?.dist;
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

    const unencodedRes = await fetch(`${registry.url}/@verule/sdk`);
    assert.equal(unencodedRes.status, 200);
  } finally {
    await registry.close();
  }
});

void test("resolves transitive @verule dependency from loopback registry in a fake pnpm host with minimumReleaseAge", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-reg-pnpm-"));
  const engineArtifact = createTestTarball(
    join(fixture.path, "stage-engine"),
    join(fixture.path, "verule-engine-0.0.0.tgz"),
    {
      name: "@verule/engine",
      version: "0.0.0",
      type: "module",
      exports: { "./binary": "./dist/binary.js" },
    },
    {
      "dist/binary.js": "export const engineExecutablePath = 'fake-engine';\n",
    },
  );
  const sdkArtifact = createTestTarball(
    join(fixture.path, "stage-sdk"),
    join(fixture.path, "verule-sdk-0.0.0.tgz"),
    {
      name: "@verule/sdk",
      version: "0.0.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
      dependencies: { "@verule/engine": "0.0.0" },
    },
    {
      "dist/index.js":
        "import { engineExecutablePath } from '@verule/engine/binary';\nexport function getEngine() { return engineExecutablePath; }\n",
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

  const registry = await startArtifactRegistry([engineArtifact, sdkArtifact]);
  try {
    writeFileSync(
      join(hostDir, ".npmrc"),
      `@verule:registry=${registry.url}/\n`,
    );
    await execFileAsync(
      "pnpm",
      [
        "add",
        "--save-dev",
        "--workspace-root",
        "--ignore-scripts",
        "@verule/sdk@0.0.0",
      ],
      { cwd: hostDir },
    );
  } finally {
    await registry.close();
  }

  const hostPkg = JSON.parse(
    readFileSync(join(hostDir, "package.json"), "utf8"),
  ) as { devDependencies: Record<string, string> };
  assert.deepEqual(Object.keys(hostPkg.devDependencies), ["@verule/sdk"]);

  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkResolved = hostRequire.resolve("@verule/sdk");
  const sdkRequire = createRequire(sdkResolved);
  const engineResolved = sdkRequire.resolve("@verule/engine/binary");
  const hostReal = realpathSync(hostDir);
  assert.ok(realpathSync(sdkResolved).startsWith(hostReal + sep));
  assert.ok(realpathSync(engineResolved).startsWith(hostReal + sep));
  assert.ok(existsSync(engineResolved));
});
