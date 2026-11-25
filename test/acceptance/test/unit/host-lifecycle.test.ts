import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
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
  type PackedArtifact,
  type PackedArtifactBundle,
  prepareAcceptanceHost,
  withAcceptanceHost,
} from "../../src/index.ts";

function createFakeBundle(
  bundleDir: string,
  options: {
    readonly cliScript: string;
    readonly sdkDependencies?: Readonly<Record<string, string>>;
    readonly overrideEngineSha256?: string;
  },
): PackedArtifactBundle {
  function pack(
    subDir: string,
    outFile: string,
    manifest: Record<string, unknown>,
    files: Readonly<Record<string, string>>,
    executables: readonly string[] = [],
  ): PackedArtifact {
    const stageDir = join(bundleDir, subDir);
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
    const tarPath = join(bundleDir, outFile);
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

  const engineScript =
    "#!/usr/bin/env node\nif (process.argv.includes('--version')) { console.log('0.0.0-fake'); process.exit(0); }\nprocess.exit(0);\n";
  const computedEngineSha = createHash("sha256")
    .update(engineScript)
    .digest("hex");
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
  const engine: PackedArtifact = {
    ...engineBase,
    binarySha256: options.overrideEngineSha256 ?? computedEngineSha,
  };

  const verule = pack(
    "stage-verule",
    "boringparts-verule-0.1.0.tgz",
    {
      name: "@boringparts/verule",
      version: "0.1.0",
      type: "module",
      exports: { ".": "./dist/index.js" },
      bin: { verule: "./dist/cli.js" },
      dependencies: {
        "@verule/engine": "0.0.0",
        ...options.sdkDependencies,
      },
    },
    {
      "dist/index.js": "export const sdkVersion = '0.1.0';\n",
      "dist/cli.js": options.cliScript,
    },
    ["dist/cli.js"],
  );

  return {
    packDir: bundleDir,
    artifacts: [engine, verule],
    dispose(): void {},
  };
}

const workingCliScript = `#!/usr/bin/env node
import { createServer } from "node:net";
import { existsSync, readFileSync, rmSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const command = args[0];

function makeReport(status, message) {
  return {
    reportVersion: "1",
    status,
    projects: [{ configFile: "packages/app/tsconfig.json", sourceFiles: ["packages/app/src/review.ts"] }],
    fileOrigins: [],
    additionalInputs: [],
    diagnostics: status === "findings" ? [{ id: "d1", ruleId: "fake-rule", severity: "error", message, at: { file: "packages/app/src/review.ts", start: 0, end: 1, line: 1, column: 1 }, evidence: [] }] : [],
    gaps: [],
    identity: { snapshotDigest: status, ruleIds: ["fake-rule"] },
  };
}

if (command === "check") {
  const sessionIdx = args.indexOf("--session");
  if (sessionIdx !== -1) {
    const sock = args[sessionIdx + 1];
    const net = await import("node:net");
    const response = await new Promise((resolve, reject) => {
      const client = net.createConnection(sock);
      let buf = "";
      client.on("data", (chunk) => {
        buf += chunk.toString("utf8");
        if (buf.includes("\\n")) {
          client.end();
          resolve(JSON.parse(buf.trim()));
        }
      });
      client.on("error", reject);
    });
    process.stdout.write(JSON.stringify({ kind: "data", variant: response.status, data: response }) + "\\n");
    process.exit(response.status === "findings" ? 1 : 0);
  }
  const report = makeReport("clean", "");
  process.stdout.write(JSON.stringify({ kind: "data", variant: "clean", data: report }) + "\\n");
  process.exit(0);
}

if (command === "watch") {
  process.stdout.write(JSON.stringify({ schemaVersion: "1", command: "verule watch", outputMode: "ndjson", kind: "stream" }) + "\\n");
  const targetFile = join(process.cwd(), "packages/app/src/review.ts");
  let seq = 1;
  const emitReport = (trigger, status) => {
    const data = {
      ...makeReport(status, "violation"),
      sequence: seq++,
      trigger,
      snapshotId: seq - 1,
      recomputation: { recomputedProjects: [], reusedProjects: [], recomputedFiles: [], reusedFiles: [], removedFiles: [], invalidatedBy: [] },
      memory: { hostRssBytes: 1024 },
    };
    process.stdout.write(JSON.stringify({ kind: "record", variant: "report", data }) + "\\n");
  };
  emitReport("initial", "findings");
  const initialContent = readFileSync(targetFile, "utf8");
  const timer = setInterval(() => {
    if (existsSync(targetFile) && readFileSync(targetFile, "utf8") !== initialContent) {
      clearInterval(timer);
      emitReport("change", "clean");
    }
  }, 20);
  const stop = () => {
    clearInterval(timer);
    process.stdout.write(JSON.stringify({ kind: "streamSuccess" }) + "\\n");
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.stdin.once("end", stop);
  process.stdin.resume();
}

if (command === "session") {
  const socketIdx = args.indexOf("--socket");
  const socketPath = args[socketIdx + 1];
  const server = createServer((socket) => {
    socket.end(JSON.stringify(makeReport("clean", "")) + "\\n");
  });
  await new Promise((resolve) => server.listen(socketPath, resolve));
  process.stdout.write(JSON.stringify({ schemaVersion: "1", command: "verule session", outputMode: "ndjson", kind: "stream" }) + "\\n");
  process.stdout.write(JSON.stringify({
    kind: "record",
    variant: "ready",
    data: {
      reportVersion: "1",
      endpoint: socketPath,
      snapshotId: 1,
      projects: [{ configFile: "packages/app/tsconfig.json", sourceFiles: ["packages/app/src/review.ts"] }],
    },
  }) + "\\n");
  const stop = () => {
    server.close(() => {
      rmSync(socketPath, { force: true });
      process.stdout.write(JSON.stringify({ kind: "streamSuccess" }) + "\\n");
      process.exit(0);
    });
  };
  process.on("SIGINT", stop);
  process.stdin.once("end", stop);
  process.stdin.resume();
}
`;

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

void test("withAcceptanceHost manages check, watch, session, text edits, and full cleanup", async () => {
  using fixture = mkdtempDisposableSync(join(tmpdir(), "verule-lifecycle-ok-"));
  const bundleDir = join(fixture.path, "bundle");
  const tempRoot = join(fixture.path, "hosts");
  mkdirSync(bundleDir, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });
  const bundle = createFakeBundle(bundleDir, { cliScript: workingCliScript });

  let capturedSocketPath = "";
  await withAcceptanceHost({ bundle, tempRoot }, async (host) => {
    assert.ok(host.readText("packages/app/src/review.ts").length > 0);
    assert.throws(
      () =>
        host.replaceText(
          "packages/app/src/review.ts",
          "NON_EXISTENT_TOKEN",
          "x",
        ),
      /NON_EXISTENT_TOKEN/u,
    );

    const checkResult = await host.check({
      config: "packages/app/verule.config.ts",
    });
    assert.equal(checkResult.status, 0);
    assert.equal(checkResult.report.status, "clean");

    const watch = await host.startWatch({
      config: "packages/app/verule.config.ts",
    });
    const first = await watch.nextReport({ timeoutMs: 5_000 });
    assert.equal(first.status, "findings");
    assert.equal(first.sequence, 1);

    host.writeText(
      "packages/app/src/review.ts",
      "// edited for watch\nexport const ok = true;\n",
    );
    const second = await watch.nextReport({ timeoutMs: 5_000 });
    assert.equal(second.status, "clean");
    assert.equal(second.sequence, 2);
    const watchExit = await watch.close();
    assert.equal(watchExit.code, 0, watchExit.stderr);

    const session = await host.startSession({
      config: "packages/app/verule.config.ts",
    });
    capturedSocketPath = session.endpoint;
    assert.ok(!session.endpoint.startsWith(host.hostDir));
    const sessionCheck = await session.check();
    assert.equal(sessionCheck.status, 0);
    assert.equal(sessionCheck.report.status, "clean");
    const sessionExit = await session.close();
    assert.equal(sessionExit.code, 0, sessionExit.stderr);
    assert.equal(existsSync(capturedSocketPath), false);
  });

  assert.deepEqual(readdirSync(tempRoot), []);
});

void test("mid-preparation failure preserves root cause, cleans temp resources, and allows rerun", async () => {
  using fixture = mkdtempDisposableSync(
    join(tmpdir(), "verule-lifecycle-prep-fail-"),
  );
  const badBundleDir = join(fixture.path, "bad-bundle");
  const goodBundleDir = join(fixture.path, "good-bundle");
  const tempRoot = join(fixture.path, "hosts");
  mkdirSync(badBundleDir, { recursive: true });
  mkdirSync(goodBundleDir, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });

  const mismatchedBundle = createFakeBundle(badBundleDir, {
    cliScript: workingCliScript,
    overrideEngineSha256: "deadbeef".repeat(8),
  });

  await assert.rejects(
    () =>
      prepareAcceptanceHost({
        bundle: mismatchedBundle,
        tempRoot,
      }),
    /does not match packed artifact/u,
  );
  assert.deepEqual(readdirSync(tempRoot), []);

  const goodBundle = createFakeBundle(goodBundleDir, {
    cliScript: workingCliScript,
  });
  await withAcceptanceHost({ bundle: goodBundle, tempRoot }, async (host) => {
    const result = await host.check({
      config: "packages/app/verule.config.ts",
    });
    assert.equal(result.status, 0);
  });
  assert.deepEqual(readdirSync(tempRoot), []);
});

void test("readiness and report timeouts clean up child processes, sockets, and allow rerun", async () => {
  using fixture = mkdtempDisposableSync(
    join(tmpdir(), "verule-lifecycle-timeout-"),
  );
  const hangBundleDir = join(fixture.path, "hang-bundle");
  const goodBundleDir = join(fixture.path, "good-bundle");
  const tempRoot = join(fixture.path, "hosts");
  mkdirSync(hangBundleDir, { recursive: true });
  mkdirSync(goodBundleDir, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });

  const hangCliScript = `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
writeFileSync(join(process.cwd(), args[0] + ".pid"), String(process.pid));
if (args[0] === "watch") {
  process.stdout.write(JSON.stringify({ kind: "stream", command: "verule watch" }) + "\\n");
}
setInterval(() => {}, 1_000);
process.stdin.resume();
`;

  const hangBundle = createFakeBundle(hangBundleDir, {
    cliScript: hangCliScript,
  });
  const host = await prepareAcceptanceHost({
    bundle: hangBundle,
    tempRoot,
  });
  let watchPid: number | undefined;
  let sessionPid: number | undefined;
  try {
    const watch = await host.startWatch({
      config: "packages/app/verule.config.ts",
    });
    await assert.rejects(
      () => watch.nextReport({ timeoutMs: 250 }),
      /Timed out waiting for watch report/u,
    );
    watchPid = Number(host.readText("watch.pid").trim());

    await assert.rejects(
      () =>
        host.startSession({
          config: "packages/app/verule.config.ts",
          timeoutMs: 250,
        }),
      /Timed out waiting for shared session ready/u,
    );
    sessionPid = Number(host.readText("session.pid").trim());
  } finally {
    await host.dispose();
  }

  assert.ok(
    watchPid && !isProcessAlive(watchPid),
    `Expected watch (${watchPid}) to exit`,
  );
  assert.ok(
    sessionPid && !isProcessAlive(sessionPid),
    `Expected session (${sessionPid}) to exit`,
  );
  assert.deepEqual(readdirSync(tempRoot), []);

  const goodBundle = createFakeBundle(goodBundleDir, {
    cliScript: workingCliScript,
  });
  await withAcceptanceHost(
    { bundle: goodBundle, tempRoot },
    async (rerunHost) => {
      const session = await rerunHost.startSession({
        config: "packages/app/verule.config.ts",
      });
      const res = await session.check();
      assert.equal(res.status, 0);
    },
  );
  assert.deepEqual(readdirSync(tempRoot), []);
});

void test("early subprocess exit rejects immediately with stderr and exit code, cleans up, and allows rerun", async () => {
  using fixture = mkdtempDisposableSync(
    join(tmpdir(), "verule-lifecycle-early-exit-"),
  );
  const crashBundleDir = join(fixture.path, "crash-bundle");
  const goodBundleDir = join(fixture.path, "good-bundle");
  const tempRoot = join(fixture.path, "hosts");
  mkdirSync(crashBundleDir, { recursive: true });
  mkdirSync(goodBundleDir, { recursive: true });
  mkdirSync(tempRoot, { recursive: true });

  const crashCliScript = `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "session") {
  process.stderr.write(JSON.stringify({
    kind: "failure",
    variant: "failed",
    data: { reportVersion: "1", code: "INVALID_CONFIG", message: "Broken config in fake CLI" },
  }) + "\\n");
  process.exit(2);
}
if (args[0] === "watch") {
  process.stdout.write(JSON.stringify({ kind: "stream", command: "verule watch" }) + "\\n");
  process.stderr.write("watch crashed early\\n");
  process.exit(2);
}
`;

  const crashBundle = createFakeBundle(crashBundleDir, {
    cliScript: crashCliScript,
  });
  const host = await prepareAcceptanceHost({ bundle: crashBundle, tempRoot });
  try {
    const sessionStart = performance.now();
    await assert.rejects(
      () =>
        host.startSession({
          config: "packages/app/verule.config.ts",
          timeoutMs: 30_000,
        }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exited/u);
        assert.match(error.message, /2/u);
        assert.match(error.message, /Broken config in fake CLI/u);
        return true;
      },
    );
    assert.ok(
      performance.now() - sessionStart < 5_000,
      "Expected early session exit to reject immediately without waiting for timeout",
    );

    const watch = await host.startWatch({
      config: "packages/app/verule.config.ts",
    });
    const watchStart = performance.now();
    await assert.rejects(
      () => watch.nextReport({ timeoutMs: 30_000 }),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /exited/u);
        assert.match(error.message, /2/u);
        assert.match(error.message, /watch crashed early/u);
        return true;
      },
    );
    assert.ok(
      performance.now() - watchStart < 5_000,
      "Expected early watch exit to reject immediately without waiting for timeout",
    );
  } finally {
    await host.dispose();
  }
  assert.deepEqual(readdirSync(tempRoot), []);

  const goodBundle = createFakeBundle(goodBundleDir, {
    cliScript: workingCliScript,
  });
  await withAcceptanceHost(
    { bundle: goodBundle, tempRoot },
    async (rerunHost) => {
      const watch = await rerunHost.startWatch({
        config: "packages/app/verule.config.ts",
      });
      const report = await watch.nextReport({ timeoutMs: 5_000 });
      assert.equal(report.status, "findings");
    },
  );
  assert.deepEqual(readdirSync(tempRoot), []);
});
