import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { linkNodeModulesPackage } from "@verule/test-hosts";

import { checkReportSchema } from "../../src/report-wire.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { captureCli } from "./cli-test-helpers.ts";

const require = createRequire(import.meta.url);
const tscScriptPath = join(
  dirname(require.resolve("typescript-7/package.json")),
  "bin",
  "tsc",
);

void test("verule check traces first-party workspace packages via declarationMap and surfaces missing-source-file and missing-behavior-summary gaps", async () => {
  await withCliTempHost(
    {
      host: "integration/package-behavior",
      syntheticPackages: {
        "ext-pkg": {
          packageJson: {
            name: "ext-pkg",
            version: "1.0.0",
            type: "module",
            exports: {
              ".": {
                types: "./dist/index.d.ts",
                default: "./dist/index.js",
              },
            },
          },
          files: {
            "dist/index.d.ts":
              "export declare function opaqueExternal<T>(value: T): T;\n",
            "dist/index.js":
              "export function opaqueExternal(value) {\n  return value;\n}\n",
          },
        },
      },
      setup: (host) => {
        host.removePath("vendor");
        execFileSync(
          process.execPath,
          [
            tscScriptPath,
            "-p",
            host.resolvePath("packages/shared-pkg/tsconfig.json"),
            "--pretty",
            "false",
          ],
          { cwd: host.rootDir, encoding: "utf8" },
        );
        linkNodeModulesPackage(
          host.rootDir,
          "@ws/shared-pkg",
          host.resolvePath("packages/shared-pkg"),
        );
      },
    },
    async (host) => {
      await host.typecheck("packages/esm/tsconfig.json");
      await host.typecheck("packages/cjs/tsconfig.json");

      // Phase 1: with declarationMap present -> traces into packages/shared-pkg/src/index.ts, reports clone in CJS, and marks ext-pkg external
      const json1 = await captureCli(
        ["check", "--config", "verule.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(json1.status, 1, json1.stderr);
      const env1 = JSON.parse(json1.stdout) as {
        readonly variant: string;
        readonly data: unknown;
      };
      assert.equal(env1.variant, "findings");
      const report1 = checkReportSchema.parse(env1.data);
      assert.equal(report1.diagnostics.length, 1);
      const diag = report1.diagnostics[0]!;
      assert.equal(diag.at.file, "packages/cjs/src/app.ts");
      assert.ok(
        diag.evidence.some(
          (e) => e.at?.file === "packages/shared-pkg/src/index.ts",
        ),
        `Expected evidence inside packages/shared-pkg/src/index.ts, got ${JSON.stringify(diag.evidence)}`,
      );
      assert.ok(
        report1.gaps.some((g) => g.kind === "missing-behavior-summary"),
        `Expected missing-behavior-summary gap for ext-pkg, got ${JSON.stringify(report1.gaps)}`,
      );
      for (const proj of report1.projects) {
        assert.ok(proj.sourceFiles.every((f) => !f.includes("node_modules/")));
      }
      assert.ok(
        report1.fileOrigins.every((o) => !o.file.includes("node_modules/")),
      );

      // Phase 2: remove `.d.ts.map`, leaving first-party package as `.d.ts`-only -> reports missing-source-file with TS config hints
      host.removePath("packages/shared-pkg/dist/index.d.ts.map");

      const json2 = await captureCli(
        ["check", "--config", "verule.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(json2.status, 0, json2.stderr);
      const env2 = JSON.parse(json2.stdout) as {
        readonly variant: string;
        readonly data: unknown;
      };
      assert.equal(env2.variant, "clean");
      const report2 = checkReportSchema.parse(env2.data);
      assert.equal(report2.diagnostics.length, 0);
      assert.ok(
        report2.gaps.some((g) => g.kind === "missing-source-file"),
        `Expected missing-source-file gap, got ${JSON.stringify(report2.gaps)}`,
      );
      assert.ok(
        report2.gaps.some((g) => g.kind === "missing-behavior-summary"),
        `Expected missing-behavior-summary gap, got ${JSON.stringify(report2.gaps)}`,
      );

      const text2 = await captureCli(
        ["check", "--config", "verule.config.ts"],
        host.rootDir,
      );
      assert.equal(text2.status, 0, text2.stderr);
      assert.match(text2.stdout, /gap \[missing-source-file\]:/u);
      assert.match(text2.stdout, /gap \[missing-behavior-summary\]:/u);
    },
  );
});
