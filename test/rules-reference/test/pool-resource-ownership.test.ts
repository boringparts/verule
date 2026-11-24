import assert from "node:assert/strict";
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  definePoolResourceOwnershipModel,
  poolResourceOwnershipModel,
  poolResourceOwnershipRule,
} from "@verule/rules-reference";
import { defineConfig, openSession, runCheck } from "@verule/sdk";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pool-ownership",
);

function withTempFixtureProject<T>(
  fixtureDirs: readonly string[],
  fn: (rootDir: string) => Promise<T>,
): Promise<T> {
  const rootDir = mkdtempSync(join(tmpdir(), "verule-pool-ownership-test-"));
  for (const dir of fixtureDirs) {
    cpSync(join(fixturesRoot, dir), join(rootDir, dir), { recursive: true });
  }
  writeFileSync(
    join(rootDir, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          rewriteRelativeImportExtensions: true,
        },
        include: ["**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  return fn(rootDir).finally(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });
}

void describe("@verule/rules-reference poolResourceOwnershipRule", () => {
  void it("flags coexisting child resources registered onto outer host container while accepting item-owned DisposableStore wrappers and direct single-item factories", async () => {
    await withTempFixtureProject(
      ["shared", "positive-outer-reg"],
      async (rootDir) => {
        const report = await runCheck({
          cwd: rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [poolResourceOwnershipModel],
            rules: [poolResourceOwnershipRule],
          }),
        });

        assert.equal(report.status, "findings");
        assert.deepEqual(
          report.diagnostics.map((d) => ({ file: d.at.file, line: d.at.line })),
          [
            { file: "positive-outer-reg/pools.ts", line: 28 },
            { file: "positive-outer-reg/pools.ts", line: 31 },
          ],
          JSON.stringify(report.diagnostics),
        );
        for (const diag of report.diagnostics) {
          assert.ok(
            diag.evidence.some(
              (e) =>
                e.kind === "model" &&
                e.modelId === poolResourceOwnershipModel.id,
            ),
            JSON.stringify(diag.evidence),
          );
          assert.ok(
            diag.evidence.some(
              (e) =>
                e.kind === "source" &&
                e.at?.file === "positive-outer-reg/pools.ts" &&
                e.at.line === 24,
            ),
            JSON.stringify(diag.evidence),
          );
        }
      },
    );
  });

  void it("discovers aliased ResourcePool imports and cross-file helper outer registrations without hardcoded lookupFiles, while ignoring cross-file item-owned stores", async () => {
    await withTempFixtureProject(
      ["shared", "cross-file-helper"],
      async (rootDir) => {
        const report = await runCheck({
          cwd: rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [poolResourceOwnershipModel],
            rules: [poolResourceOwnershipRule],
          }),
        });

        assert.equal(report.status, "findings");
        assert.deepEqual(
          report.diagnostics.map((d) => ({ file: d.at.file, line: d.at.line })),
          [{ file: "cross-file-helper/helper.ts", line: 7 }],
          JSON.stringify(report.diagnostics),
        );
        const diag = report.diagnostics[0]!;
        assert.ok(
          diag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "cross-file-helper/consumer.ts",
          ),
          JSON.stringify(diag.evidence),
        );
      },
    );
  });

  void it("reports sibling resource leaks with wrongly-disposed evidence and retracts findings when fixed in openSession", async () => {
    await withTempFixtureProject(
      ["shared", "sibling-leak"],
      async (rootDir) => {
        const session = await openSession({
          cwd: rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [poolResourceOwnershipModel],
            rules: [poolResourceOwnershipRule],
          }),
        });
        try {
          const initial = await session.check();
          assert.equal(initial.status, "findings");
          assert.deepEqual(
            initial.diagnostics.map((d) => ({
              file: d.at.file,
              line: d.at.line,
            })),
            [{ file: "sibling-leak/sibling-leak.ts", line: 28 }],
            JSON.stringify(initial.diagnostics),
          );
          const diag = initial.diagnostics[0]!;
          assert.ok(diag.message.includes("primaryLabels"), diag.message);
          assert.ok(
            diag.evidence.some(
              (e) =>
                e.kind === "model" &&
                e.at?.file === "sibling-leak/sibling-leak.ts" &&
                e.at.line === 35,
            ),
            JSON.stringify(diag.evidence),
          );
          assert.ok(
            diag.evidence.some(
              (e) =>
                e.kind === "source" &&
                e.at?.file === "sibling-leak/sibling-leak.ts" &&
                e.at.line === 25,
            ),
            JSON.stringify(diag.evidence),
          );

          const targetPath = join(rootDir, "sibling-leak", "sibling-leak.ts");
          const updatedSource = readFileSync(targetPath, "utf8").replace(
            "dispose: () => primaryLabels.dispose(),",
            "dispose: () => { primaryLabels.dispose(); leakedLabels.dispose(); },",
          );
          writeFileSync(targetPath, updatedSource, "utf8");
          await session.update({
            changed: ["sibling-leak/sibling-leak.ts"],
          });
          const afterFix = await session.check();
          assert.equal(afterFix.status, "clean");
          assert.equal(afterFix.diagnostics.length, 0);
        } finally {
          await session.close();
        }
      },
    );
  });

  void it("surfaces missing-instance-model gaps for unmodeled external cleanup without crashing", async () => {
    const customModel = definePoolResourceOwnershipModel({
      id: "external-handle-model",
      instanceBehaviors: [
        {
          kind: "allocates-fresh-instance",
          match: { symbol: "allocateExternalHandle" },
        },
      ],
      facts: {
        childItemScopes: [
          {
            id: "resource-pool",
            kind: "factory-delegation",
            label: "ResourcePool item factory",
            match: { symbol: "ResourcePool" },
            callbackArgumentIndex: 0,
          },
        ],
      },
    });

    await withTempFixtureProject(
      ["shared", "external-gap"],
      async (rootDir) => {
        // Materialize the checked `.d.ts` fixture as an external package in `node_modules`
        // so `isExternal === true` triggers `missing-instance-model`.
        const pkgDir = join(
          rootDir,
          "node_modules",
          "@fixture",
          "external-gap",
        );
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(
          join(pkgDir, "package.json"),
          JSON.stringify({
            name: "@fixture/external-gap",
            version: "1.0.0",
            types: "./index.d.ts",
          }),
          "utf8",
        );
        const dtsPath = join(rootDir, "external-gap", "external-gap.d.ts");
        writeFileSync(
          join(pkgDir, "index.d.ts"),
          readFileSync(dtsPath, "utf8"),
          "utf8",
        );
        rmSync(dtsPath);
        const consumerPath = join(rootDir, "external-gap", "missing-model.ts");
        writeFileSync(
          consumerPath,
          readFileSync(consumerPath, "utf8").replace(
            '"./external-gap.ts"',
            '"@fixture/external-gap"',
          ),
          "utf8",
        );

        const report = await runCheck({
          cwd: rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [customModel],
            rules: [poolResourceOwnershipRule],
          }),
        });

        assert.ok(
          report.gaps.some(
            (g) =>
              g.kind === "missing-instance-model" &&
              g.at?.file === "external-gap/missing-model.ts",
          ),
          JSON.stringify(report.gaps),
        );
      },
    );
  });
});
