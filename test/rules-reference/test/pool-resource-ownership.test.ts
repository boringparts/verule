import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  definePoolResourceOwnershipModel,
  poolResourceOwnershipModel,
  poolResourceOwnershipRule,
} from "@verule/rules-reference";
import { defineConfig, openSession, runCheck } from "@verule/sdk";
import {
  copyDirectory,
  type PreparedTempHost,
  withTempHost,
  writeSyntheticPackage,
} from "@verule/test-hosts";

const fixturesRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "pool-ownership",
);

function withTempFixtureProject<T>(
  fixtureDirs: readonly string[],
  fn: (host: PreparedTempHost) => Promise<T>,
): Promise<T> {
  return withTempHost(
    {
      prefix: "verule-pool-ownership-test-",
      setup: (host) => {
        for (const dir of fixtureDirs) {
          copyDirectory(join(fixturesRoot, dir), host.resolvePath(dir));
        }
        host.writeText(
          "tsconfig.json",
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
        );
      },
    },
    fn,
  );
}

void describe("@verule/rules-reference poolResourceOwnershipRule", () => {
  void it("flags coexisting child resources registered onto outer host container while accepting item-owned DisposableStore wrappers and direct single-item factories", async () => {
    await withTempFixtureProject(
      ["shared", "positive-outer-reg"],
      async (host) => {
        const report = await runCheck({
          cwd: host.rootDir,
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
      async (host) => {
        const report = await runCheck({
          cwd: host.rootDir,
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
    await withTempFixtureProject(["shared", "sibling-leak"], async (host) => {
      const session = await openSession({
        cwd: host.rootDir,
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

        host.replaceText(
          "sibling-leak/sibling-leak.ts",
          "dispose: () => primaryLabels.dispose(),",
          "dispose: () => { primaryLabels.dispose(); leakedLabels.dispose(); },",
        );
        await session.update({
          changed: ["sibling-leak/sibling-leak.ts"],
        });
        const afterFix = await session.check();
        assert.equal(afterFix.status, "clean");
        assert.equal(afterFix.diagnostics.length, 0);
      } finally {
        await session.close();
      }
    });
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

    await withTempFixtureProject(["shared", "external-gap"], async (host) => {
      // Materialize the checked `.d.ts` fixture as an external package in `node_modules`
      // so `isExternal === true` triggers `missing-instance-model`.
      writeSyntheticPackage(host.rootDir, "@fixture/external-gap", {
        packageJson: {
          name: "@fixture/external-gap",
          version: "1.0.0",
          types: "./index.d.ts",
        },
        files: {
          "index.d.ts": host.readText("external-gap/external-gap.d.ts"),
        },
      });
      host.removePath("external-gap/external-gap.d.ts");
      host.replaceText(
        "external-gap/missing-model.ts",
        '"./external-gap.ts"',
        '"@fixture/external-gap"',
      );

      const report = await runCheck({
        cwd: host.rootDir,
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
    });
  });
});
