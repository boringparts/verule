import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  VeruleExecutionError,
  defineConfig,
  defineRule,
  openSession,
  runCheck,
  type SyntaxRef,
} from "@verule/sdk";

function createMultiProjectFixture(options?: {
  readonly includeAggregateRoot?: boolean;
  readonly includeJsApp?: boolean;
}): string {
  const root = mkdtempSync(join(tmpdir(), "verule-sdk-projects-"));
  mkdirSync(join(root, "packages/shared"), { recursive: true });
  mkdirSync(join(root, "packages/web/src"), { recursive: true });
  mkdirSync(join(root, "packages/node/src"), { recursive: true });
  mkdirSync(join(root, "node_modules/ext-lib"), { recursive: true });

  writeFileSync(
    join(root, "node_modules/ext-lib/index.d.ts"),
    "export declare const externalId: string;\n",
    "utf8",
  );

  writeFileSync(
    join(root, "packages/shared/shared.ts"),
    [
      'import { mode } from "@runtime";',
      'import { externalId } from "ext-lib";',
      "",
      "function checkMode(value: string): string {",
      "  return `${value}:${externalId}`;",
      "}",
      "",
      "export const current = checkMode(mode);",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(root, "packages/web/src/web.ts"),
    'export const mode = "web" as const;\n',
    "utf8",
  );

  writeFileSync(
    join(root, "packages/node/src/node.ts"),
    'export const mode = "node" as const;\n',
    "utf8",
  );

  writeFileSync(
    join(root, "packages/web/tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: {
            "@runtime": ["./src/web.ts"],
            "ext-lib": ["../../node_modules/ext-lib/index.d.ts"],
          },
        },
        include: ["src/**/*.ts", "../shared/shared.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  writeFileSync(
    join(root, "packages/node/tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          composite: true,
          strict: false,
          allowJs: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: {
            "@runtime": ["./src/node.ts"],
            "ext-lib": ["../../node_modules/ext-lib/index.d.ts"],
          },
        },
        include: ["src/**/*.ts", "../shared/shared.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  if (options?.includeAggregateRoot !== false) {
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify(
        {
          files: [],
          references: [{ path: "./packages/web" }, { path: "./packages/node" }],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  if (options?.includeJsApp) {
    mkdirSync(join(root, "packages/jsapp"), { recursive: true });
    writeFileSync(
      join(root, "packages/jsapp/index.js"),
      "export const jsEntry = 1;\n",
      "utf8",
    );
    writeFileSync(
      join(root, "packages/jsapp/jsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: { checkJs: false },
          include: ["./index.js"],
        },
        null,
        2,
      ),
      "utf8",
    );
  }

  return root;
}

void describe("@verule/sdk multi-project scope and merging", () => {
  void it("opens an empty-root aggregate tsconfig, explains file origins, isolates @runtime types, and merges only matching diagnostics", async () => {
    const root = createMultiProjectFixture({ includeAggregateRoot: true });

    const observedTypesByProject = new Map<string, string>();

    const runtimeModeRule = defineRule({
      id: "runtime-mode-rule",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["packages/shared/shared.ts"],
          kinds: ["CallExpression"],
        });
        const checkCalls = calls.filter((c) => c.text.startsWith("checkMode("));
        for (const call of checkCalls) {
          const arg = call.arguments?.[0];
          if (!arg) continue;
          const [ty] = await ctx.typeAt([arg]);
          if (!ty) continue;
          observedTypesByProject.set(ctx.project.projectId, ty.typeText);
          ctx.report({
            at: call.location,
            message: `Resolved @runtime mode is ${ty.typeText}`,
            findingKey: `runtime-${String(ty.literalValue ?? "unknown")}`,
            basis: [
              {
                kind: "type",
                message: `@runtime resolved to ${ty.typeText}`,
                at: call.location,
              },
            ],
          });
        }
      },
    });

    const sharedSameConclusionRule = defineRule({
      id: "shared-same-conclusion",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["packages/shared/shared.ts"],
          kinds: ["CallExpression"],
        });
        for (const call of calls.filter((c) =>
          c.text.startsWith("checkMode("),
        )) {
          ctx.report({
            at: call.location,
            message: "Shared checkMode call must be audited",
            findingKey: "shared-audit",
            basis: [
              {
                kind: "source",
                message: "Called checkMode in shared.ts",
                at: call.location,
              },
            ],
          });
        }
      },
    });

    const differentFindingKeyRule = defineRule({
      id: "different-finding-key",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["packages/shared/shared.ts"],
          kinds: ["CallExpression"],
        });
        for (const call of calls.filter((c) =>
          c.text.startsWith("checkMode("),
        )) {
          ctx.report({
            at: call.location,
            message: "Same message across projects",
            findingKey: `key-for-${ctx.project.projectId}`,
            basis: [
              {
                kind: "note",
                message: "Same evidence across projects",
                at: call.location,
              },
            ],
          });
        }
      },
    });

    const differentEvidenceRule = defineRule({
      id: "different-evidence",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: ["packages/shared/shared.ts"],
          kinds: ["CallExpression"],
        });
        for (const call of calls.filter((c) =>
          c.text.startsWith("checkMode("),
        )) {
          ctx.report({
            at: call.location,
            message: "Same message and key across projects",
            findingKey: "same-key",
            basis: [
              {
                kind: "note",
                message: `Evidence from ${ctx.project.projectId}`,
                at: call.location,
              },
            ],
          });
        }
      },
    });

    try {
      const config = defineConfig({
        tsconfig: "tsconfig.json",
        rules: [
          runtimeModeRule,
          sharedSameConclusionRule,
          differentFindingKeyRule,
          differentEvidenceRule,
        ],
      });

      const session = await openSession({ cwd: root, config });
      let report;
      try {
        assert.equal(session.projects.length, 3);
        const webProj = session.projects.find(
          (p) => p.configFile === "packages/web/tsconfig.json",
        );
        const nodeProj = session.projects.find(
          (p) => p.configFile === "packages/node/tsconfig.json",
        );
        assert.ok(webProj);
        assert.ok(nodeProj);
        assert.equal(webProj.entryConfig, "tsconfig.json");
        assert.deepEqual(webProj.entryChain, [
          "tsconfig.json",
          "packages/web/tsconfig.json",
        ]);
        assert.equal(webProj.compilerOptions.strict, true);
        assert.deepEqual(webProj.compilerOptions.paths["@runtime"], [
          "./src/web.ts",
        ]);

        assert.equal(nodeProj.entryConfig, "tsconfig.json");
        assert.deepEqual(nodeProj.entryChain, [
          "tsconfig.json",
          "packages/node/tsconfig.json",
        ]);
        assert.equal(nodeProj.compilerOptions.strict, false);
        assert.equal(nodeProj.compilerOptions.allowJs, true);
        assert.deepEqual(nodeProj.compilerOptions.paths["@runtime"], [
          "./src/node.ts",
        ]);

        const sharedOrigin = session.fileOrigins.find(
          (o) => o.file === "packages/shared/shared.ts",
        );
        assert.ok(sharedOrigin);
        assert.deepEqual(
          sharedOrigin.projects.map((p) => p.projectId),
          ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
        );
        assert.equal(
          session.fileOrigins.some((o) => o.file.includes("node_modules")),
          false,
        );
        assert.equal(
          session.fileOrigins.some((o) => o.file.includes("lib.es")),
          false,
        );

        report = await session.check();
      } finally {
        await session.close();
      }

      assert.equal(
        observedTypesByProject.get("packages/web/tsconfig.json"),
        '"web"',
      );
      assert.equal(
        observedTypesByProject.get("packages/node/tsconfig.json"),
        '"node"',
      );

      assert.deepEqual(report.fileOrigins, session.fileOrigins);

      const runtimeDiags = report.diagnostics.filter(
        (d) => d.ruleId === "runtime-mode-rule",
      );
      assert.equal(runtimeDiags.length, 2);
      assert.deepEqual(
        runtimeDiags.find((d) => d.message.includes('"web"'))?.projects,
        ["packages/web/tsconfig.json"],
      );
      assert.deepEqual(
        runtimeDiags.find((d) => d.message.includes('"node"'))?.projects,
        ["packages/node/tsconfig.json"],
      );

      const mergedDiags = report.diagnostics.filter(
        (d) => d.ruleId === "shared-same-conclusion",
      );
      assert.equal(mergedDiags.length, 1);
      assert.deepEqual(mergedDiags[0]?.projects, [
        "packages/node/tsconfig.json",
        "packages/web/tsconfig.json",
      ]);

      const unmergedByKey = report.diagnostics.filter(
        (d) => d.ruleId === "different-finding-key",
      );
      assert.equal(unmergedByKey.length, 2);

      const unmergedByEvidence = report.diagnostics.filter(
        (d) => d.ruleId === "different-evidence",
      );
      assert.equal(unmergedByEvidence.length, 2);
      assert.deepEqual(
        unmergedByEvidence.map((d) => d.projects),
        [["packages/node/tsconfig.json"], ["packages/web/tsconfig.json"]],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("supports multiple independent entry configs including jsconfig.json and rejects cross-project refs", async () => {
    const root = createMultiProjectFixture({
      includeAggregateRoot: false,
      includeJsApp: true,
    });

    let webRef: SyntaxRef | undefined;

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          projects: [
            "packages/web/tsconfig.json",
            "packages/node/tsconfig.json",
            "packages/jsapp/jsconfig.json",
          ],
          rules: [
            defineRule({
              id: "capture-shared-call",
              run: async (ctx) => {
                const calls = await ctx.findSyntax({
                  files: ["packages/shared/shared.ts"],
                  kinds: ["CallExpression"],
                });
                const first = calls[0];
                if (!first) return;
                if (ctx.project.configFile === "packages/web/tsconfig.json") {
                  webRef = first.ref;
                }
                ctx.report({
                  at: first.location,
                  message: "Cross-entry shared finding",
                  findingKey: "cross-entry",
                  basis: [{ kind: "note", message: "Same evidence" }],
                });
              },
            }),
          ],
        }),
      });

      assert.equal(report.projects.length, 3);
      for (const proj of report.projects) {
        assert.equal(proj.entryConfig, proj.configFile);
        assert.deepEqual(proj.entryChain, [proj.configFile]);
      }

      assert.equal(report.diagnostics.length, 1);
      assert.deepEqual(report.diagnostics[0]?.projects, [
        "packages/node/tsconfig.json",
        "packages/web/tsconfig.json",
      ]);

      assert.ok(webRef);
      await assert.rejects(
        () =>
          runCheck({
            cwd: root,
            config: defineConfig({
              projects: ["packages/node/tsconfig.json"],
              rules: [
                defineRule({
                  id: "cross-project-ref-check",
                  run: async (ctx) => {
                    await ctx.typeAt([webRef!]);
                  },
                }),
              ],
            }),
          }),
        (err: unknown) =>
          err instanceof VeruleExecutionError &&
          (err.code === "STALE_REFERENCE" ||
            err.code === "CROSS_PROJECT_REFERENCE"),
      );

      // Also test CROSS_PROJECT_REFERENCE within the same active session.
      await assert.rejects(
        () =>
          runCheck({
            cwd: root,
            config: defineConfig({
              projects: [
                "packages/web/tsconfig.json",
                "packages/node/tsconfig.json",
              ],
              rules: [
                defineRule({
                  id: "same-session-cross-project",
                  run: async (ctx) => {
                    const calls = await ctx.findSyntax({
                      files: ["packages/shared/shared.ts"],
                      kinds: ["CallExpression"],
                    });
                    if (
                      ctx.project.configFile === "packages/web/tsconfig.json"
                    ) {
                      webRef = calls[0]?.ref;
                      return;
                    }
                    if (
                      ctx.project.configFile ===
                        "packages/node/tsconfig.json" &&
                      webRef
                    ) {
                      await ctx.typeAt([webRef]);
                    }
                  },
                }),
              ],
            }),
          }),
        (err: unknown) =>
          err instanceof VeruleExecutionError &&
          err.code === "CROSS_PROJECT_REFERENCE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
