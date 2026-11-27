import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { defineConfig, openSession, runCheck } from "@boringparts/verule";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";
import {
  installPackedWorkspacePackages,
  linkNodeModulesPackage,
  type PreparedTempHost,
  withTempHost,
} from "@verule/test-hosts";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const pkgRequire = createRequire(join(packageRoot, "package.json"));
const tssaeRoot = dirname(pkgRequire.resolve("tssae/package.json"));
const tssaeDrizzleRoot = dirname(
  pkgRequire.resolve("@tssae/drizzle/package.json"),
);
const tssaeZodRoot = dirname(pkgRequire.resolve("@tssae/zod/package.json"));
const drizzleOrmRoot = join(packageRoot, "node_modules", "drizzle-orm");
const drizzleZodRoot = join(packageRoot, "node_modules", "drizzle-zod");
const zodRoot = join(packageRoot, "node_modules", "zod");
const externalConsumerSource = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "external-consumer",
  "consumer.ts",
);

async function withMonorepoHost(
  hostName: string,
  callback: (host: PreparedTempHost) => Promise<void>,
): Promise<void> {
  return withTempHost(
    {
      host: hostName,
      prefix: "verule-rules-ref-",
      packageLinks: {
        "drizzle-orm": drizzleOrmRoot,
        "drizzle-zod": drizzleZodRoot,
        zod: zodRoot,
      },
      setup: (host) => {
        host.removePath("tsconfig.json");
        renameSync(
          host.resolvePath("packages/db/tsconfig.runtime.json"),
          host.resolvePath("packages/db/tsconfig.json"),
        );
        renameSync(
          host.resolvePath("packages/api/tsconfig.runtime.json"),
          host.resolvePath("packages/api/tsconfig.json"),
        );
        const validatorsTsconfig = host.resolvePath(
          "packages/validators/tsconfig.runtime.json",
        );
        if (existsSync(validatorsTsconfig)) {
          renameSync(
            validatorsTsconfig,
            host.resolvePath("packages/validators/tsconfig.json"),
          );
          linkNodeModulesPackage(
            host.rootDir,
            "@fixture/validators",
            host.resolvePath("packages/validators"),
          );
        }
        linkNodeModulesPackage(
          host.rootDir,
          "@fixture/db",
          host.resolvePath("packages/db"),
        );
      },
    },
    callback,
  );
}

void describe("@verule/rules-reference rowProjectionSatisfiesValidatorRule", () => {
  void it("covers cross-package missing field (a), complete row pass (b), defaulted field pass (c), and unrelated input non-report", async () => {
    await withMonorepoHost(
      "rules-reference/row-projection-basic",
      async (host) => {
        await host.typecheck("packages/db/tsconfig.json");
        await host.typecheck("packages/validators/tsconfig.json");
        await host.typecheck("packages/api/tsconfig.json");

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            projects: [
              "packages/db/tsconfig.json",
              "packages/validators/tsconfig.json",
              "packages/api/tsconfig.json",
            ],
            rules: [rowProjectionSatisfiesValidatorRule],
          }),
        });

        assert.equal(report.status, "findings");
        assert.equal(report.diagnostics.length, 1);

        const diag = report.diagnostics[0]!;
        assert.equal(diag.ruleId, "row-projection-satisfies-validator");
        assert.equal(diag.at.file, "packages/api/src/handler.ts");
        assert.equal(diag.at.line, 9);
        assert.ok(
          diag.message.includes("age"),
          `Unexpected message: ${diag.message}`,
        );

        // Evidence must trace back to Drizzle projection in packages/db, value propagation, and Zod schema in packages/validators
        assert.ok(
          diag.evidence.some(
            (ev) => ev.at?.file === "packages/db/src/queries.ts",
          ),
          "Expected evidence pointing to packages/db/src/queries.ts",
        );
        assert.ok(
          diag.evidence.some(
            (ev) => ev.at?.file === "packages/validators/src/index.ts",
          ),
          "Expected evidence pointing to packages/validators/src/index.ts",
        );
        assert.ok(
          diag.evidence.some(
            (ev) => ev.at?.file === "packages/api/src/handler.ts",
          ),
          "Expected evidence along propagation path in packages/api/src/handler.ts",
        );
      },
    );
  });

  void it("handles dynamic query columns (d) and relational createSelectSchema + rest destructuring + live edit revocation (e)", async () => {
    await withMonorepoHost(
      "rules-reference/row-projection-relational",
      async (host) => {
        await host.typecheck("packages/db/tsconfig.json");
        await host.typecheck("packages/api/tsconfig.json");

        const session = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            projects: [
              "packages/db/tsconfig.json",
              "packages/api/tsconfig.json",
            ],
            rules: [rowProjectionSatisfiesValidatorRule],
          }),
        });

        try {
          const initial = await session.check();
          // Dynamic spread `maybeOk` has Gap (no false positive on maybeOk),
          // while `withoutAge` explicitly stripped `age` via rest destructuring -> reports at line 34!
          // Both `selectWorkspaceSchema.safeParse(_page.workspace)` and `gateFieldsSchema.parse(rest)` pass!
          assert.equal(initial.diagnostics.length, 1);
          assert.equal(
            initial.diagnostics[0]!.at.file,
            "packages/api/src/routes.ts",
          );
          assert.equal(initial.diagnostics[0]!.at.line, 34);
          assert.ok(initial.diagnostics[0]!.message.includes("age"));
          assert.ok(
            initial.gaps.some((g) => g.kind === "dynamic-query-projection"),
            "Expected dynamic-query-projection Gap to be preserved",
          );

          // Edit routes.ts: remove `slug: true,` from findFirst columns -> triggers diagnostic ONLY on gateFieldsSchema.parse(rest), NOT on selectWorkspaceSchema.safeParse(_page.workspace)!
          const originalRoutes = host.readText("packages/api/src/routes.ts");
          host.replaceText(
            "packages/api/src/routes.ts",
            "      slug: true,\n",
            "",
          );
          await session.update({ changed: ["packages/api/src/routes.ts"] });

          const afterDelete = await session.check();
          const gateDiag = afterDelete.diagnostics.find(
            (d) =>
              d.at.file === "packages/api/src/routes.ts" &&
              d.message.includes("slug"),
          );
          assert.ok(
            gateDiag,
            "Expected missing slug diagnostic after deleting slug: true",
          );
          assert.equal(gateDiag.at.line, 22);
          assert.equal(
            afterDelete.diagnostics.some((d) => d.at.line === 20),
            false,
            "_page.workspace validation must NOT report when page.slug is removed",
          );

          // Restore `slug: true,` -> slug diagnostic is revoked!
          host.writeText("packages/api/src/routes.ts", originalRoutes);
          await session.update({ changed: ["packages/api/src/routes.ts"] });
          const afterRestore = await session.check();
          assert.equal(
            afterRestore.diagnostics.some((d) => d.message.includes("slug")),
            false,
          );
        } finally {
          await session.close();
        }
      },
    );
  });

  void it("handles bracket relation reads, destructured aliases, chained rest omissions, omitted-relation counterexample, and targeted explain", async () => {
    await withMonorepoHost(
      "rules-reference/row-projection-relations-cases",
      async (host) => {
        await host.typecheck("packages/db/tsconfig.json");
        await host.typecheck("packages/api/tsconfig.json");

        const session = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            projects: [
              "packages/db/tsconfig.json",
              "packages/api/tsconfig.json",
            ],
            rules: [rowProjectionSatisfiesValidatorRule],
          }),
        });

        try {
          const report = await session.check();
          assert.equal(report.status, "findings");
          const diagLines = report.diagnostics
            .map((d) => d.at.line)
            .toSorted((a, b) => a - b);
          assert.deepEqual(diagLines, [14, 20, 22, 27]);
          for (const diag of report.diagnostics) {
            assert.ok(diag.message.includes("slug"), diag.message);
            assert.ok(
              diag.evidence.some(
                (e) => e.at?.file === "packages/api/src/routes.ts",
              ),
            );
            assert.ok(
              diag.evidence.some(
                (e) => e.at?.file === "packages/db/src/schema.ts",
              ),
            );
          }

          const explainedReported = await session.explain({
            ruleId: "row-projection-satisfies-validator",
            at: "packages/api/src/routes.ts:14:24",
          });
          assert.equal(explainedReported.explanation.status, "reported");
          assert.ok(
            explainedReported.diagnostics.some((d) => d.at.line === 14),
          );

          const explainedPass = await session.explain({
            ruleId: "row-projection-satisfies-validator",
            at: "packages/api/src/routes.ts:36:18",
          });
          assert.ok(
            explainedPass.explanation.checkpoints.some(
              (cp) =>
                cp.name === "row-projection-satisfied" && cp.outcome === "pass",
            ),
          );

          const explainedDyn = await session.explain({
            ruleId: "row-projection-satisfies-validator",
            at: "packages/api/src/routes.ts:43:27",
          });
          assert.equal(
            explainedDyn.explanation.status,
            "excluded_by_checkpoint",
          );
          assert.equal(
            explainedDyn.explanation.excludedByCheckpoint?.name,
            "dynamic-query-projection-gap",
          );

          const explainedUnrelated = await session.explain({
            ruleId: "row-projection-satisfies-validator",
            at: "packages/api/src/routes.ts:46:18",
          });
          assert.equal(
            explainedUnrelated.explanation.status,
            "excluded_by_checkpoint",
          );
          assert.equal(
            explainedUnrelated.explanation.excludedByCheckpoint?.name,
            "validator-input-not-from-query",
          );
        } finally {
          await session.close();
        }
      },
    );
  });

  void it("resolves createSelectSchema(table, refine) + .extend() override and reports unresolved-schema-field gaps", async () => {
    await withMonorepoHost(
      "rules-reference/row-projection-refined",
      async (host) => {
        await host.typecheck("packages/db/tsconfig.json");
        await host.typecheck("packages/api/tsconfig.json");

        const session = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            projects: [
              "packages/db/tsconfig.json",
              "packages/api/tsconfig.json",
            ],
            rules: [rowProjectionSatisfiesValidatorRule],
          }),
        });

        try {
          const report = await session.check();
          assert.equal(report.status, "clean");
          // Both createSelectSchema(..., { age: runtimeAgeValidator() }) calls emit
          // unresolved-schema-field, while defaultedAgeSchema overrides `age` via .extend().
          const schemaGaps = report.gaps.filter(
            (g) => g.kind === "unresolved-schema-field",
          );
          assert.equal(schemaGaps.length, 1, JSON.stringify(schemaGaps));
          assert.ok(
            schemaGaps.some(
              (g) =>
                g.at?.file === "packages/db/src/validation.ts" &&
                g.at.line === 9,
            ),
          );

          const resolvedExplain = await session.explain({
            ruleId: "row-projection-satisfies-validator",
            at: "packages/api/src/routes.ts:11:20",
          });
          assert.equal(resolvedExplain.explanation.gaps.length, 0);
        } finally {
          await session.close();
        }
      },
    );
  });

  void it("compiles an external TypeScript consumer against built @verule/rules-reference, @tssae/drizzle, @tssae/zod, tssae, and @boringparts/verule .d.ts", async () => {
    await withTempHost(
      { prefix: "verule-rules-ref-typecheck-" },
      async (host) => {
        await installPackedWorkspacePackages(
          host.rootDir,
          ["@boringparts/verule", "@verule/rules-reference"],
          { cwd: packageRoot },
        );
        linkNodeModulesPackage(host.rootDir, "tssae", tssaeRoot);
        linkNodeModulesPackage(
          host.rootDir,
          "@tssae/drizzle",
          tssaeDrizzleRoot,
        );
        linkNodeModulesPackage(host.rootDir, "@tssae/zod", tssaeZodRoot);

        host.writeText(
          "tsconfig.json",
          JSON.stringify(
            {
              compilerOptions: {
                strict: true,
                exactOptionalPropertyTypes: true,
                noUncheckedIndexedAccess: true,
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
                types: [],
                noEmit: true,
              },
              include: ["src/**/*.ts"],
            },
            null,
            2,
          ),
        );
        host.writeText(
          "src/consumer.ts",
          readFileSync(externalConsumerSource, "utf8"),
        );

        await host.typecheck();
      },
    );
  });
});
