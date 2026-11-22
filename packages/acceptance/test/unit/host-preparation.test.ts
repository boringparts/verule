import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempDisposableSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  HOST_DEFINITIONS,
  HOST_SCENARIOS,
  prepareHostCheckout,
  resolveHostCacheDir,
  resolveHostRepositoryUrl,
} from "../../src/index.ts";

void test("defines the fixed upstream commits for VS Code, Vue, and OpenStatus", () => {
  assert.deepEqual(Object.keys(HOST_DEFINITIONS).sort(), [
    "openstatus",
    "vscode",
    "vue",
  ]);

  const expectedShasByScenario = new Map<string, readonly string[]>([
    [
      "vscode-terminal-find",
      [
        "c79dbd0432433dde5697606122583c5c94d0ab74",
        "53f4de24cb61db9267fec741b31768c35ce127ae",
      ],
    ],
    [
      "vscode-accessible-view",
      [
        "5886d26498c71fbe4fe0ce10148cc5f9cbd8345e",
        "fb6289d60e979ff544a2619b2f0d192c8cc30c0a",
      ],
    ],
    [
      "vscode-ipc-connection",
      [
        "8309b22051c226cca9c3485fd282e93df6339eca",
        "c9ce5675282e562684c72fb6e1361995e0c6398c",
      ],
    ],
    [
      "vscode-resource-pool",
      [
        "f520d705ae646c2e26d624924d503562e20d9517",
        "3fc62371e017d5e6d3d742b7aa79832c9fc9e71d",
      ],
    ],
    [
      "vue-reentrant-scheduler",
      [
        "7257e6a34200409b3fc347d3bb807e11e2785974",
        "d18d6aa1b20dc57a8103c51ec4d61e8e53ed936d",
      ],
    ],
    [
      "openstatus-whoami",
      [
        "f8cbf5f4a0565b8b14bfa7272aaf9abbc6b778bf",
        "f04bd49aaac41f8be05eb821ec6442e763e6c86f",
        "f2840732f3f2879ccb1695a7a42513aeaf274cb3",
      ],
    ],
    ["openstatus-get-gate", ["090709ad0a4c838215c321cf3d0cb76447cd4b5d"]],
  ]);

  assert.equal(HOST_SCENARIOS.length, expectedShasByScenario.size);
  for (const scenario of HOST_SCENARIOS) {
    const expectedShas = expectedShasByScenario.get(scenario.id);
    assert.ok(expectedShas, `Unexpected scenario ${scenario.id}`);
    assert.deepEqual(
      scenario.revisions.map((revision) => revision.sha),
      expectedShas,
    );
  }
});

void test("resolves host repository URLs and cache directory from environment overrides", () => {
  assert.equal(
    resolveHostRepositoryUrl("vscode", {
      VERULE_VSCODE_REPO: "/tmp/local-vscode",
    }),
    "/tmp/local-vscode",
  );
  assert.equal(
    resolveHostRepositoryUrl("vue", { VERULE_VUE_REPO: "/tmp/local-vue" }),
    "/tmp/local-vue",
  );
  assert.equal(
    resolveHostRepositoryUrl("openstatus", {
      VERULE_OPENSTATUS_REPO: "/tmp/local-openstatus",
    }),
    "/tmp/local-openstatus",
  );
  assert.equal(
    resolveHostCacheDir({ VERULE_HOST_CACHE_DIR: "/tmp/custom-cache" }),
    "/tmp/custom-cache",
  );
  assert.equal(
    resolveHostCacheDir({ XDG_CACHE_HOME: "/tmp/xdg-cache" }),
    "/tmp/xdg-cache/verule/host-repos",
  );
});

void test("checks out an exact commit via cached bare repo and cleans up the working tree", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-git-fixture-"));
  const upstreamDir = join(fixture.path, "upstream");
  const cacheDir = join(fixture.path, "cache");
  execFileSync("git", ["init", "--initial-branch=main", upstreamDir], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", upstreamDir, "config", "user.name", "Test"], {
    stdio: "pipe",
  });
  execFileSync(
    "git",
    ["-C", upstreamDir, "config", "user.email", "test@example.com"],
    { stdio: "pipe" },
  );
  writeFileSync(join(upstreamDir, "package.json"), '{"name":"fake-host"}\n');
  execFileSync("git", ["-C", upstreamDir, "add", "package.json"], {
    stdio: "pipe",
  });
  execFileSync("git", ["-C", upstreamDir, "commit", "-m", "init"], {
    stdio: "pipe",
  });
  const sha = execFileSync("git", ["-C", upstreamDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
  }).trim();

  const result = await prepareHostCheckout({
    hostId: "vue",
    sha,
    repositoryUrl: upstreamDir,
    cacheDir,
    retryDelaysMs: [0],
  });

  assert.equal(result.status, "ready");
  assert.equal(result.sha, sha);
  assert.ok(existsSync(join(result.checkoutDir, "package.json")));
  assert.ok(existsSync(join(cacheDir, "vue.git", "HEAD")));

  const head = execFileSync(
    "git",
    ["-C", result.checkoutDir, "rev-parse", "HEAD"],
    { encoding: "utf8" },
  ).trim();
  assert.equal(head, sha);

  result.cleanup();
  assert.equal(existsSync(result.checkoutDir), false);
});

void test("records a separate preparation failure when upstream fetch fails after retries", async () => {
  const scratchDir = mkdtempSync(join(tmpdir(), "verule-git-fail-"));
  try {
    const missingRepo = join(scratchDir, "does-not-exist.git");
    const cacheDir = join(scratchDir, "cache");
    let fetchAttempts = 0;

    const result = await prepareHostCheckout({
      hostId: "vscode",
      sha: "0123456789abcdef0123456789abcdef01234567",
      repositoryUrl: missingRepo,
      cacheDir,
      retryDelaysMs: [0, 0],
      onFetchAttempt: () => {
        fetchAttempts += 1;
      },
    });

    assert.equal(result.status, "preparation-failed");
    assert.equal(result.stage, "git-fetch");
    assert.equal(result.hostId, "vscode");
    assert.equal(result.sha, "0123456789abcdef0123456789abcdef01234567");
    assert.equal(fetchAttempts, 3);
    assert.ok(result.message.length > 0);
  } finally {
    rmSync(scratchDir, { recursive: true, force: true });
  }
});
