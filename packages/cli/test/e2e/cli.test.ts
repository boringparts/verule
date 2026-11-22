import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempDisposableSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";

void test("runs the independently deployed CLI with its production SDK and engine", async () => {
  using deployment = mkdtempDisposableSync(join(tmpdir(), "verule-cli-"));
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@verule/cli",
      "deploy",
      "--prod",
      "--offline",
      deployment.path,
    ],
    { cwd: new URL("../../", import.meta.url), stdio: "pipe" },
  );
  const deployed = createRequire(join(deployment.path, "package.json"));
  const manifest: { bin: { verule: string }; version: string } =
    deployed("./package.json");
  assert.ok(
    deployed
      .resolve("@verule/sdk")
      .startsWith(realpathSync(deployment.path) + sep),
  );
  const sdk: typeof import("@verule/sdk") = deployed("@verule/sdk");
  const entry = join(deployment.path, manifest.bin.verule);

  function invoke(...args: string[]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd: tmpdir(),
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    return result;
  }

  const result = invoke();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `verule ${manifest.version} (engine ${await sdk.getEngineVersion()})\n`,
  );

  const version = invoke("--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `verule ${manifest.version}\n`);

  const help = invoke("--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--schema/u);

  const schema = invoke("--schema");
  assert.equal(schema.status, 0, schema.stderr);
  assert.partialDeepStrictEqual(JSON.parse(schema.stdout), {
    command: "verule",
  });

  const invalid = invoke("--unknown");
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /--unknown/u);
});
