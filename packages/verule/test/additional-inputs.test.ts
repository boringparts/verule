import assert from "node:assert/strict";
import { symlinkSync } from "node:fs";
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
} from "@boringparts/verule";
import { withTempHost } from "@verule/test-hosts";

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

void describe("@boringparts/verule additional inputs", () => {
  void it("merges config, rule, and summary declarations for the same physical file while preserving all sources and keeping compiler sourceFiles unchanged", async () => {
    await withTempHost(
      {
        host: "sdk-projects/additional-inputs-basic",
        setup: (host) => {
          symlinkSync(
            host.resolvePath("allowed-packages.json"),
            host.resolvePath("allowed-packages.link.json"),
          );
        },
      },
      async (host) => {
        await host.typecheck();

        const allowlistPath = host.resolvePath("allowed-packages.json");

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
                    basis: [
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

        // Standalone registry test using the shared AdditionalInputRegistrar hook
        const registrar: AdditionalInputRegistrar =
          createAdditionalInputRegistry({
            cwd: host.rootDir,
          });
        registrar.registerAdditionalInput("./allowed-packages.json", {
          kind: "config",
        });
        registrar.registerAdditionalInput(allowlistPath, {
          kind: "rule",
          id: "allowlist-reader",
        });
        registrar.registerAdditionalInput("./src/../allowed-packages.json", {
          kind: "summary",
          id: "package-allowlist-summary",
        });
        registrar.registerAdditionalInput("allowed-packages.link.json", {
          kind: "summary",
          id: "symlink-summary",
        });

        const standaloneEntries = registrar.listAdditionalInputs();
        assert.equal(standaloneEntries.length, 1);
        assert.equal(standaloneEntries[0]?.file, "allowed-packages.json");
        assert.deepEqual(standaloneEntries[0]?.sources, [
          { kind: "config" },
          { kind: "summary", id: "package-allowlist-summary" },
          { kind: "summary", id: "symlink-summary" },
          { kind: "rule", id: "allowlist-reader" },
        ] satisfies readonly AdditionalInputSource[]);
        assert.equal(registrar.getTrackedAbsolutePaths().length, 1);

        // Session integration with summary registration sharing the same mechanism
        const session = await openSession({ cwd: host.rootDir, config });
        try {
          session.registerAdditionalInput("./src/../allowed-packages.json", {
            kind: "summary",
            id: "package-allowlist-summary",
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
            { kind: "summary", id: "package-allowlist-summary" },
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
            err instanceof VeruleExecutionError &&
            err.code === "INVALID_CONFIG",
        );

        // runCheck preserves config + rule sources
        const coldReport = await runCheck({ cwd: host.rootDir, config });
        assert.equal(coldReport.additionalInputs.length, 1);
        assert.deepEqual(coldReport.additionalInputs[0]?.sources, [
          { kind: "config" },
          { kind: "rule", id: "allowlist-auditor" },
          { kind: "rule", id: "allowlist-reader" },
        ]);
      },
    );
  });

  void it("immediately updates shared session reports and watch stream when only an additional input manifest changes", async () => {
    await withTempHost(
      { host: "sdk-projects/additional-inputs-watch" },
      async (host) => {
        await host.typecheck();

        await withTempHost(
          {
            files: {
              "external-policy.json": JSON.stringify({ blocked: [] }, null, 2),
            },
          },
          async (externalHost) => {
            await withTempHost(
              { prefix: "verule-add-inputs-sock-" },
              async (socketHost) => {
                const socketPath = socketHost.resolvePath("shared.sock");
                const externalPolicyPath = externalHost.resolvePath(
                  "external-policy.json",
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
                    const calls = await ctx.findSyntax({
                      kinds: ["CallExpression"],
                    });
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
                          basis: [
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

                const abortController = new AbortController();
                let sharedSession:
                  | Awaited<ReturnType<typeof startSharedSession>>
                  | undefined;
                try {
                  sharedSession = await startSharedSession({
                    cwd: host.rootDir,
                    endpoint: socketPath,
                    config,
                    signal: abortController.signal,
                  });

                  // 1. Initial clean
                  const r1 = await requestSharedReport({
                    endpoint: socketPath,
                  });
                  assert.equal(r1.status, "clean");
                  assertMatchesCold(
                    r1,
                    await runCheck({ cwd: host.rootDir, config }),
                    "initial",
                  );

                  // 2. Edit ONLY allowed-packages.json -> immediate query (0ms) -> violation
                  host.writeText(
                    "allowed-packages.json",
                    JSON.stringify({ allowed: ["lodash"] }, null, 2),
                  );
                  const r2 = await requestSharedReport({
                    endpoint: socketPath,
                  });
                  assert.equal(r2.status, "findings");
                  assert.equal(r2.diagnostics.length, 1);
                  assertMatchesCold(
                    r2,
                    await runCheck({ cwd: host.rootDir, config }),
                    "allowlist-violation",
                  );

                  // 3. Restore ONLY allowed-packages.json -> immediate query (0ms) -> retracted
                  host.writeText(
                    "allowed-packages.json",
                    JSON.stringify({ allowed: ["zod"] }, null, 2),
                  );
                  const r3 = await requestSharedReport({
                    endpoint: socketPath,
                  });
                  assert.equal(r3.status, "clean");
                  assert.equal(r3.diagnostics.length, 0);
                  assertMatchesCold(
                    r3,
                    await runCheck({ cwd: host.rootDir, config }),
                    "allowlist-restored",
                  );

                  // 4. Edit ONLY rule-registered external policy file outside cwd -> immediate query -> violation
                  externalHost.writeText(
                    "external-policy.json",
                    JSON.stringify({ blocked: ["zod"] }, null, 2),
                  );
                  const r4 = await requestSharedReport({
                    endpoint: socketPath,
                  });
                  assert.equal(r4.status, "findings");
                  assert.equal(r4.diagnostics.length, 1);
                  assertMatchesCold(
                    r4,
                    await runCheck({ cwd: host.rootDir, config }),
                    "external-policy-violation",
                  );

                  // 5. Restore external policy -> clean
                  externalHost.writeText(
                    "external-policy.json",
                    JSON.stringify({ blocked: [] }, null, 2),
                  );
                  const r5 = await requestSharedReport({
                    endpoint: socketPath,
                  });
                  assert.equal(r5.status, "clean");
                  assertMatchesCold(
                    r5,
                    await runCheck({ cwd: host.rootDir, config }),
                    "external-policy-restored",
                  );

                  await sharedSession.close();
                  sharedSession = undefined;

                  // 6. Verify watchProject pushes updated reports and recovers from broken manifest
                  const watchAbort = new AbortController();
                  const events: WatchEvent[] = [];
                  let waiters: (() => void)[] = [];
                  const stream = watchProject({
                    cwd: host.rootDir,
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

                  async function nextWatchEvent(
                    expectedSeq: number,
                  ): Promise<WatchEvent> {
                    const deadline = Date.now() + 8_000;
                    while (true) {
                      const found = events.find(
                        (e) => e.sequence === expectedSeq,
                      );
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
                    externalHost.writeText(
                      "external-policy.json",
                      JSON.stringify({ blocked: ["zod"] }, null, 2),
                    );
                    const w2 = await nextWatchEvent(2);
                    assert.equal(w2.kind, "report");
                    assert.equal(w2.report.status, "findings");
                    assertMatchesCold(
                      w2.report,
                      await runCheck({ cwd: host.rootDir, config }),
                      "watch-external-violation",
                    );

                    // Corrupt external manifest -> single-round failure without exiting
                    externalHost.writeText(
                      "external-policy.json",
                      "{ invalid json",
                    );
                    const w3 = await nextWatchEvent(3);
                    assert.equal(w3.kind, "failed");
                    assert.equal(w3.code, "RULE_EXECUTION_ERROR");

                    // Restore external manifest -> watch recovers cleanly
                    externalHost.writeText(
                      "external-policy.json",
                      JSON.stringify({ blocked: [] }, null, 2),
                    );
                    const w4 = await nextWatchEvent(4);
                    assert.equal(w4.kind, "report");
                    assert.equal(w4.report.status, "clean");
                    assertMatchesCold(
                      w4.report,
                      await runCheck({ cwd: host.rootDir, config }),
                      "watch-external-restored",
                    );
                  } finally {
                    watchAbort.abort();
                    await consumeTask;
                  }
                } finally {
                  abortController.abort();
                  await sharedSession?.close();
                }
              },
            );
          },
        );
      },
    );
  });

  void it("tracks auto-discovered local tssae.summaries.json in additionalInputs and updates shared session reports when only the summary file changes", async () => {
    await withTempHost(
      {
        files: {
          "package.json": JSON.stringify({
            name: "summary-additional-input-host",
            private: true,
            type: "module",
          }),
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
            },
            include: ["src/**/*.ts"],
          }),
          "src/app.ts": [
            'import { transformToken } from "@acme/token";',
            "export function check(): string {",
            '  const orig = { tag: "orig" };',
            "  const next = transformToken(orig);",
            "  return next.tag;",
            "}",
            "",
          ].join("\n"),
          "tssae.summaries.json": JSON.stringify(
            {
              id: "local-token-summary",
              entries: [
                {
                  match: {
                    package: "@acme/token",
                    memberPath: ["transformToken"],
                  },
                  instances: {
                    completeness: "complete",
                    outcome: {
                      kind: "forwards-instance",
                      from: { argIndex: 0 },
                    },
                  },
                },
              ],
            },
            null,
            2,
          ),
        },
        syntheticPackages: {
          "@acme/token": {
            packageJson: {
              name: "@acme/token",
              version: "1.0.0",
              types: "./index.d.ts",
            },
            files: {
              "index.d.ts":
                "export declare function transformToken<T>(x: T): T;\n",
            },
          },
        },
      },
      async (host) => {
        await host.typecheck();

        await withTempHost(
          { prefix: "verule-summary-sock-" },
          async (socketHost) => {
            const socketPath = socketHost.resolvePath("shared.sock");

            const rule = defineRule({
              id: "require-forwarded-token",
              run: async (ctx) => {
                const vars = await ctx.findSyntax({
                  kinds: ["VariableDeclaration"],
                });
                const origVar = vars.find((v) => v.text.startsWith("orig ="));
                const nextVar = vars.find((v) => v.text.startsWith("next ="));
                if (!origVar?.initializer || !nextVar?.initializer) return;

                const [origInst, nextInst] = await ctx.resolveInstances([
                  origVar.initializer,
                  nextVar.initializer,
                ]);
                if (
                  origInst?.status === "proved" &&
                  nextInst?.status === "proved" &&
                  origInst.instanceKey !== nextInst.instanceKey
                ) {
                  ctx.report({
                    at: nextVar.location,
                    message: "transformToken allocated a distinct instance",
                    basis: [origInst, nextInst],
                  });
                }
              },
            });

            const config = defineConfig({
              tsconfig: "tsconfig.json",
              rules: [rule],
            });

            const abortController = new AbortController();
            let sharedSession:
              | Awaited<ReturnType<typeof startSharedSession>>
              | undefined;
            try {
              sharedSession = await startSharedSession({
                cwd: host.rootDir,
                endpoint: socketPath,
                config,
                signal: abortController.signal,
              });

              const r1 = await requestSharedReport({ endpoint: socketPath });
              assert.equal(r1.status, "clean");
              assert.ok(
                r1.additionalInputs.some(
                  (entry) =>
                    entry.file === "tssae.summaries.json" &&
                    entry.sources.some(
                      (s) =>
                        s.kind === "summary" && s.id === "local-token-summary",
                    ),
                ),
                JSON.stringify(r1.additionalInputs),
              );
              assertMatchesCold(
                r1,
                await runCheck({ cwd: host.rootDir, config }),
                "summary-initial",
              );

              host.writeText(
                "tssae.summaries.json",
                JSON.stringify(
                  {
                    id: "local-token-summary",
                    entries: [
                      {
                        match: {
                          package: "@acme/token",
                          memberPath: ["transformToken"],
                        },
                        instances: {
                          completeness: "complete",
                          outcome: { kind: "allocates-fresh-instance" },
                        },
                      },
                    ],
                  },
                  null,
                  2,
                ),
              );
              const r2 = await requestSharedReport({ endpoint: socketPath });
              assert.equal(r2.status, "findings");
              assert.equal(r2.diagnostics.length, 1);
              assertMatchesCold(
                r2,
                await runCheck({ cwd: host.rootDir, config }),
                "summary-updated-violation",
              );
            } finally {
              abortController.abort();
              await sharedSession?.close();
            }
          },
        );
      },
    );
  });
});
