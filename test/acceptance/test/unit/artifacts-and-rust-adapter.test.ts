import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  packAdapterApiCrate,
  packWorkspaceArtifacts,
  renderExternalRustCargoToml,
  resolveCargoBuildArgs,
  resolveInstalledPackageVersion,
  tryPackAdapterApiCrate,
} from "../../src/index.ts";

function writeTarball(
  stageDir: string,
  tarballPath: string,
  manifest: Record<string, unknown>,
  files: Readonly<Record<string, string>>,
): string {
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
  execFileSync("tar", ["-czf", tarballPath, "-C", stageDir, "package"], {
    stdio: "pipe",
  });
  const bytes = readFileSync(tarballPath);
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

void test("renders Cargo.toml and cargo args for both local .crate and public crates.io modes", () => {
  const cratesIoToml = renderExternalRustCargoToml({
    crateName: "acme_external_valid",
    apiCrateName: "tssae-adapter-api",
    apiCrateVersion: "0.1.0",
  });
  assert.match(
    cratesIoToml,
    /tssae-adapter-api = \{ version = "0\.1\.0", default-features = false \}/u,
  );
  assert.equal(cratesIoToml.includes("[patch.crates-io]"), false);

  const localCrateToml = renderExternalRustCargoToml({
    crateName: "acme_external_valid",
    apiCrateName: "tssae-adapter-api",
    apiCrateVersion: "0.1.0",
    extractedCrateDir: "/tmp/extracted-crate",
  });
  assert.match(localCrateToml, /\[patch\.crates-io\]/u);
  assert.match(
    localCrateToml,
    /tssae-adapter-api = \{ path = "\/tmp\/extracted-crate" \}/u,
  );

  assert.deepEqual(resolveCargoBuildArgs({}), ["build", "--release"]);
  assert.deepEqual(resolveCargoBuildArgs({ CARGO_NET_OFFLINE: "false" }), [
    "build",
    "--release",
  ]);
  assert.deepEqual(resolveCargoBuildArgs({ CARGO_NET_OFFLINE: "true" }), [
    "build",
    "--release",
    "--offline",
  ]);

  assert.match(resolveInstalledPackageVersion("tssae"), /^\d+\.\d+\.\d+/u);
  assert.match(
    resolveInstalledPackageVersion("@tssae/adapters"),
    /^\d+\.\d+\.\d+/u,
  );
});

void test("tryPackAdapterApiCrate returns undefined without local env overrides while packAdapterApiCrate throws", async () => {
  const prevCrate = process.env.TSSAE_ACCEPTANCE_CRATE_PATH;
  const prevPackDir = process.env.TSSAE_ACCEPTANCE_PACK_DIR;
  delete process.env.TSSAE_ACCEPTANCE_CRATE_PATH;
  delete process.env.TSSAE_ACCEPTANCE_PACK_DIR;
  try {
    assert.equal(await tryPackAdapterApiCrate(), undefined);
    await assert.rejects(
      () => packAdapterApiCrate(),
      /Missing tssae-adapter-api/u,
    );
  } finally {
    if (prevCrate !== undefined) {
      process.env.TSSAE_ACCEPTANCE_CRATE_PATH = prevCrate;
    }
    if (prevPackDir !== undefined) {
      process.env.TSSAE_ACCEPTANCE_PACK_DIR = prevPackDir;
    }
  }
});

void test("mixes VERULE_ACCEPTANCE_PACK_DIR with fallback private workspace packing without modifying candidate dir", async () => {
  using fixture = mkdtempDisposableSync(
    join(tmpdir(), "verule-artifacts-mix-"),
  );
  const verulePackDir = join(fixture.path, "verule-packed");
  const tssaePackDir = join(fixture.path, "tssae-packed");
  const workspaceDir = join(fixture.path, "workspace");
  const privatePkgDir = join(workspaceDir, "packages", "private-helper");
  const publicPkgDir = join(workspaceDir, "packages", "verule-core");
  for (const dir of [
    verulePackDir,
    tssaePackDir,
    privatePkgDir,
    publicPkgDir,
  ]) {
    mkdirSync(dir, { recursive: true });
  }

  writeFileSync(
    join(workspaceDir, "package.json"),
    '{"name":"fake-ws","private":true}\n',
  );
  writeFileSync(
    join(workspaceDir, "pnpm-workspace.yaml"),
    "packages:\n  - 'packages/*'\n",
  );
  writeFileSync(
    join(privatePkgDir, "package.json"),
    JSON.stringify(
      {
        name: "@verule/private-helper",
        version: "0.0.0",
        private: true,
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(privatePkgDir, "index.js"), "export const ok = true;\n");
  writeFileSync(
    join(publicPkgDir, "package.json"),
    JSON.stringify(
      {
        name: "@boringparts/verule",
        version: "0.1.0",
        type: "module",
      },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(join(publicPkgDir, "index.js"), "export const core = true;\n");

  const veruleTgz = join(verulePackDir, "boringparts-verule-0.1.0.tgz");
  const veruleIntegrity = writeTarball(
    join(fixture.path, "stage-verule"),
    veruleTgz,
    { name: "@boringparts/verule", version: "0.1.0", type: "module" },
    { "dist/index.js": "export const verule = true;\n" },
  );
  writeFileSync(
    join(verulePackDir, "publish-plan.json"),
    JSON.stringify({
      plan: [
        [
          {
            kind: "publish",
            name: "@boringparts/verule",
            tarball: {
              path: "boringparts-verule-0.1.0.tgz",
              integrity: veruleIntegrity,
            },
          },
        ],
      ],
    }),
  );

  const tssaeTgz = join(tssaePackDir, "tssae-0.1.0.tgz");
  writeTarball(
    join(fixture.path, "stage-tssae"),
    tssaeTgz,
    { name: "tssae", version: "0.1.0", type: "module" },
    {
      "dist/index.js": "export const tssae = true;\n",
      "dist/bin/tssae-engine": "binary",
      "dist/bin/tssae-engine.exe": "binary",
    },
  );

  const prevTssaePackDir = process.env.TSSAE_ACCEPTANCE_PACK_DIR;
  process.env.TSSAE_ACCEPTANCE_PACK_DIR = tssaePackDir;
  try {
    const bundle = await packWorkspaceArtifacts({
      fromPackDir: verulePackDir,
      additionalPackages: ["@verule/private-helper"],
      cwd: workspaceDir,
    });
    const privateArtifact = bundle.artifacts.find(
      (item) => item.name === "@verule/private-helper",
    );
    assert.ok(privateArtifact);
    assert.equal(privateArtifact.filename.startsWith(verulePackDir), false);
    assert.equal(bundle.packDir, verulePackDir);
    assert.deepEqual(readdirSync(verulePackDir).toSorted(), [
      "boringparts-verule-0.1.0.tgz",
      "publish-plan.json",
    ]);

    const fallbackTarball = privateArtifact.filename;
    assert.equal(existsSync(fallbackTarball), true);
    bundle.dispose();
    assert.equal(existsSync(veruleTgz), true);
    assert.equal(existsSync(fallbackTarball), false);

    // A publishable workspace package missing from fromPackDir must still fail.
    const emptyPackDir = join(fixture.path, "empty-verule-packed");
    mkdirSync(emptyPackDir, { recursive: true });
    await assert.rejects(
      () =>
        packWorkspaceArtifacts({
          fromPackDir: emptyPackDir,
          cwd: workspaceDir,
        }),
      /publishable workspace package @boringparts\/verule not found/u,
    );
  } finally {
    if (prevTssaePackDir === undefined) {
      delete process.env.TSSAE_ACCEPTANCE_PACK_DIR;
    } else {
      process.env.TSSAE_ACCEPTANCE_PACK_DIR = prevTssaePackDir;
    }
  }
});
