import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  VeruleExecutionError,
  createAdditionalInputRegistry,
  defineConfig,
  defineRule,
  openSession,
  requestSharedReport,
  runCheck,
  startSharedSession,
  watchProject,
  type AdditionalInputRegistrar,
  type AdditionalInputSource,
  type CheckReport,
  type WatchEvent,
} from "@verule/sdk";

function createTsConfig(include: readonly string[] = ["src/**/*.ts"]): string {
  return JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include,
    },
    null,
    2,
  );
}

void describe("@verule/sdk additional inputs", () => {
  void it("merges config, rule, and adapter declarations for the same physical file while preserving all sources and keeping compiler sourceFiles unchanged", async () => {
    const root = mkdtempSync(join(tmpdir(), "verule-add-inputs-"));
    mkdirSync(join(root, "src"), { recursive: true });

    const tsconfigPath = join(root, "tsconfig.json");
    const appPath = join(root, "src", "app.ts");
    const allowlistPath = join(root, "allowed-packages.json");
    const allowlistSymlinkPath = join(root, "allowed-packages.link.json");

    writeFileSync(tsconfigPath, createTsConfig(["src/**/*.ts"]), "utf8");
    writeFileSync(
      appPath,
      [
        "declare function usePackage(name: string): void;",
        'usePackage("zod");',
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["zod"] }, null, 2),
      "utf8",
    );
    symlinkSync(allowlistPath, allowlistSymlinkPath);

    const rule1 = defineRule({
      id: "allowlist-reader",
      run: async (ctx) => {
        const raw = ctx.readAdditionalInput("allowed-packages.json");
        const parsed = JSON.parse(raw) as { readonly allowed: string[] };
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (call.text.startsWith("usePackage(")) {
            const match = /usePackage\("([^"]+)"\)/u.exec(call.text);
            const pkg = match?.[1];
            if (pkg !== undefined && !parsed.allowed.includes(pkg)) {
              ctx.report({
                at: call.location,
                message: `Package "${pkg}" is not in allowed-packages.json`,
                findingKey: `disallowed-pkg:${pkg}`,
                evidence: [
                  {
                    kind: "source",
                    message: `Package "${pkg}" imported/used here`,
                    at: call.location,
                  },
                ],
              });
            }
          }
        }
      },
    });

    const rule2 = defineRule({
      id: "allowlist-auditor",
      run: (ctx) => {
        const entry = ctx.registerAdditionalInput(allowlistPath);
        assert.equal(entry.file, "allowed-packages.json");
        assert.equal(entry.exists, true);
      },
    });

    const config = defineConfig({
      tsconfig: "tsconfig.json",
      additionalInputs: ["./allowed-packages.json"],
      rules: [rule1, rule2],
    });

    try {
      // Standalone registry test using the shared AdditionalInputRegistrar hook
      const registrar: AdditionalInputRegistrar = createAdditionalInputRegistry(
        {
          cwd: root,
        },
      );
      registrar.registerAdditionalInput("./allowed-packages.json", {
        kind: "config",
      });
      registrar.registerAdditionalInput(allowlistPath, {
        kind: "rule",
        id: "allowlist-reader",
      });
      registrar.registerAdditionalInput("./src/../allowed-packages.json", {
        kind: "adapter",
        id: "package-allowlist-adapter",
      });
      registrar.registerAdditionalInput("allowed-packages.link.json", {
        kind: "adapter",
        id: "symlink-adapter",
      });

      const standaloneEntries = registrar.listAdditionalInputs();
      assert.equal(standaloneEntries.length, 1);
      assert.equal(standaloneEntries[0]?.file, "allowed-packages.json");
      assert.deepEqual(standaloneEntries[0]?.sources, [
        { kind: "config" },
        { kind: "adapter", id: "package-allowlist-adapter" },
        { kind: "adapter", id: "symlink-adapter" },
        { kind: "rule", id: "allowlist-reader" },
      ] satisfies readonly AdditionalInputSource[]);
      assert.equal(registrar.getTrackedAbsolutePaths().length, 1);

      // Session integration with adapter registration sharing the same mechanism
      const session = await openSession({ cwd: root, config });
      try {
        session.registerAdditionalInput("./src/../allowed-packages.json", {
          kind: "adapter",
          id: "package-allowlist-adapter",
        });

        const report = await session.check();
        assert.equal(report.status, "clean");
        assert.deepEqual(report.projects[0]?.sourceFiles, ["src/app.ts"]);
        assert.deepEqual(
          report.fileOrigins.map((origin) => origin.file),
          ["src/app.ts"],
        );
        assert.equal(report.additionalInputs.length, 1);
        const merged = report.additionalInputs[0]!;
        assert.equal(merged.file, "allowed-packages.json");
        assert.equal(merged.exists, true);
        assert.ok(merged.digest && merged.digest.length > 0);
        assert.deepEqual(merged.sources, [
          { kind: "config" },
          { kind: "adapter", id: "package-allowlist-adapter" },
          { kind: "rule", id: "allowlist-auditor" },
          { kind: "rule", id: "allowlist-reader" },
        ]);
      } finally {
        await session.close();
      }

      // Config validation rejects empty additionalInputs strings
      assert.throws(
        () =>
          defineConfig({
            tsconfig: "tsconfig.json",
            additionalInputs: ["   "],
          }),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "INVALID_CONFIG",
      );

      // runCheck without adapter registration still preserves config + rule sources
      const coldReport = await runCheck({ cwd: root, config });
      assert.equal(coldReport.additionalInputs.length, 1);
      assert.deepEqual(coldReport.additionalInputs[0]?.sources, [
        { kind: "config" },
        { kind: "rule", id: "allowlist-auditor" },
        { kind: "rule", id: "allowlist-reader" },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("immediately updates shared session reports and watch stream when only an additional input manifest changes", async () => {
    const root = mkdtempSync(join(tmpdir(), "verule-add-inputs-watch-"));
    const externalDir = mkdtempSync(join(tmpdir(), "verule-add-inputs-ext-"));
    const socketDir = mkdtempSync(join(tmpdir(), "verule-add-inputs-sock-"));
    const socketPath = join(socketDir, "shared.sock");
    mkdirSync(join(root, "src"), { recursive: true });

    const tsconfigPath = join(root, "tsconfig.json");
    const appPath = join(root, "src", "app.ts");
    const allowlistPath = join(root, "allowed-packages.json");
    const externalPolicyPath = join(externalDir, "external-policy.json");

    writeFileSync(tsconfigPath, createTsConfig(["src/**/*.ts"]), "utf8");
    const appSource = [
      'import { helper } from "./helper.js";',
      "declare function usePackage(name: string): void;",
      "export function run(): string {",
      '  usePackage("zod");',
      "  return helper();",
      "}",
      "",
    ].join("\n");
    writeFileSync(appPath, appSource, "utf8");
    writeFileSync(
      join(root, "src", "helper.ts"),
      'export function helper(): string { return "ok"; }\n',
      "utf8",
    );
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["zod"] }, null, 2),
      "utf8",
    );
    writeFileSync(
      externalPolicyPath,
      JSON.stringify({ blocked: [] }, null, 2),
      "utf8",
    );

    const rule = defineRule({
      id: "manifest-policy",
      run: async (ctx) => {
        const allowlist = JSON.parse(
          ctx.readAdditionalInput("allowed-packages.json"),
        ) as { readonly allowed: string[] };
        const externalPolicy = JSON.parse(
          ctx.readAdditionalInput(externalPolicyPath),
        ) as { readonly blocked: string[] };
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (!call.text.startsWith("usePackage(")) continue;
          const match = /usePackage\("([^"]+)"\)/u.exec(call.text);
          const pkg = match?.[1];
          if (pkg === undefined) continue;
          if (
            !allowlist.allowed.includes(pkg) ||
            externalPolicy.blocked.includes(pkg)
          ) {
            ctx.report({
              at: call.location,
              message: `Package "${pkg}" violates manifest policy`,
              findingKey: `manifest:${pkg}`,
              evidence: [
                {
                  kind: "source",
                  message: `Call uses package "${pkg}"`,
                  at: call.location,
                },
              ],
            });
          }
        }
      },
    });

    // Note: externalPolicyPath is NOT in config.additionalInputs; only registered by the rule.
    const config = defineConfig({
      tsconfig: "tsconfig.json",
      additionalInputs: ["allowed-packages.json"],
      rules: [rule],
    });

    function assertMatchesCold(
      actual: CheckReport,
      expected: CheckReport,
      label: string,
    ): void {
      assert.deepEqual(
        {
          status: actual.status,
          projects: actual.projects,
          fileOrigins: actual.fileOrigins,
          additionalInputs: actual.additionalInputs,
          diagnostics: actual.diagnostics,
          gaps: actual.gaps,
          identity: actual.identity,
        },
        {
          status: expected.status,
          projects: expected.projects,
          fileOrigins: expected.fileOrigins,
          additionalInputs: expected.additionalInputs,
          diagnostics: expected.diagnostics,
          gaps: expected.gaps,
          identity: expected.identity,
        },
        `Report diverged from cold runCheck at "${label}"`,
      );
    }

    const abortController = new AbortController();
    let sharedSession:
      | Awaited<ReturnType<typeof startSharedSession>>
      | undefined;
    try {
      sharedSession = await startSharedSession({
        cwd: root,
        endpoint: socketPath,
        config,
        signal: abortController.signal,
      });

      // 1. Initial clean
      const r1 = await requestSharedReport({ endpoint: socketPath });
      assert.equal(r1.status, "clean");
      assertMatchesCold(r1, await runCheck({ cwd: root, config }), "initial");

      // 2. Edit ONLY allowed-packages.json -> immediate query (0ms) -> violation
      writeFileSync(
        allowlistPath,
        JSON.stringify({ allowed: ["lodash"] }, null, 2),
        "utf8",
      );
      const r2 = await requestSharedReport({ endpoint: socketPath });
      assert.equal(r2.status, "findings");
      assert.equal(r2.diagnostics.length, 1);
      assertMatchesCold(
        r2,
        await runCheck({ cwd: root, config }),
        "allowlist-violation",
      );

      // 3. Restore ONLY allowed-packages.json -> immediate query (0ms) -> retracted
      writeFileSync(
        allowlistPath,
        JSON.stringify({ allowed: ["zod"] }, null, 2),
        "utf8",
      );
      const r3 = await requestSharedReport({ endpoint: socketPath });
      assert.equal(r3.status, "clean");
      assert.equal(r3.diagnostics.length, 0);
      assertMatchesCold(
        r3,
        await runCheck({ cwd: root, config }),
        "allowlist-restored",
      );

      // 4. Edit ONLY rule-registered external policy file outside cwd -> immediate query -> violation
      writeFileSync(
        externalPolicyPath,
        JSON.stringify({ blocked: ["zod"] }, null, 2),
        "utf8",
      );
      const r4 = await requestSharedReport({ endpoint: socketPath });
      assert.equal(r4.status, "findings");
      assert.equal(r4.diagnostics.length, 1);
      assertMatchesCold(
        r4,
        await runCheck({ cwd: root, config }),
        "external-policy-violation",
      );

      // 5. Restore external policy -> clean
      writeFileSync(
        externalPolicyPath,
        JSON.stringify({ blocked: [] }, null, 2),
        "utf8",
      );
      const r5 = await requestSharedReport({ endpoint: socketPath });
      assert.equal(r5.status, "clean");
      assertMatchesCold(
        r5,
        await runCheck({ cwd: root, config }),
        "external-policy-restored",
      );

      await sharedSession.close();
      sharedSession = undefined;

      // 6. Verify watchProject pushes updated reports and recovers from broken manifest
      const watchAbort = new AbortController();
      const events: WatchEvent[] = [];
      let waiters: (() => void)[] = [];
      const stream = watchProject({
        cwd: root,
        config,
        debounceMs: 25,
        signal: watchAbort.signal,
      });

      const consumeTask = (async () => {
        for await (const event of stream) {
          events.push(event);
          const pending = waiters;
          waiters = [];
          for (const wake of pending) wake();
        }
      })();

      async function nextWatchEvent(expectedSeq: number): Promise<WatchEvent> {
        const deadline = Date.now() + 8_000;
        while (true) {
          const found = events.find((e) => e.sequence === expectedSeq);
          if (found) return found;
          if (Date.now() >= deadline) {
            throw new Error(
              `Timed out waiting for watch event #${expectedSeq}. Events=${JSON.stringify(events)}`,
            );
          }
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, 50);
            waiters.push(() => {
              clearTimeout(timer);
              resolveWait();
            });
          });
        }
      }

      try {
        const w1 = await nextWatchEvent(1);
        assert.equal(w1.kind, "report");
        assert.equal(w1.report.status, "clean");

        // Edit external rule-only manifest -> watch emits violation report
        writeFileSync(
          externalPolicyPath,
          JSON.stringify({ blocked: ["zod"] }, null, 2),
          "utf8",
        );
        const w2 = await nextWatchEvent(2);
        assert.equal(w2.kind, "report");
        assert.equal(w2.report.status, "findings");
        assertMatchesCold(
          w2.report,
          await runCheck({ cwd: root, config }),
          "watch-external-violation",
        );

        // Corrupt external manifest -> single-round failure without exiting
        writeFileSync(externalPolicyPath, "{ invalid json", "utf8");
        const w3 = await nextWatchEvent(3);
        assert.equal(w3.kind, "failed");
        assert.equal(w3.code, "RULE_EXECUTION_ERROR");

        // Restore external manifest -> watch recovers cleanly
        writeFileSync(
          externalPolicyPath,
          JSON.stringify({ blocked: [] }, null, 2),
          "utf8",
        );
        const w4 = await nextWatchEvent(4);
        assert.equal(w4.kind, "report");
        assert.equal(w4.report.status, "clean");
        assertMatchesCold(
          w4.report,
          await runCheck({ cwd: root, config }),
          "watch-external-restored",
        );
      } finally {
        watchAbort.abort();
        await consumeTask;
      }
    } finally {
      abortController.abort();
      await sharedSession?.close();
      rmSync(root, { recursive: true, force: true });
      rmSync(externalDir, { recursive: true, force: true });
      rmSync(socketDir, { recursive: true, force: true });
    }
  });
});
