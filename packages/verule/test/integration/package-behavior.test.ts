import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { checkReportSchema } from "../../src/report-wire.ts";
import { resolveCliHostDir, withCliTempHost } from "../helpers/cli-hosts.ts";
import { captureCli } from "./cli-test-helpers.ts";

void test("verule check traces ESM import vs CJS require conditional exports and preserves signatures, model evidence, and gaps after removing implementations", async () => {
  const hostSourceDir = resolveCliHostDir("integration/package-behavior");
  const dualPkgManifest = JSON.parse(
    readFileSync(join(hostSourceDir, "vendor/dual-pkg/package.json"), "utf8"),
  ) as Record<string, unknown>;

  await withCliTempHost(
    {
      host: "integration/package-behavior",
      syntheticPackages: {
        "dual-pkg": {
          packageJson: dualPkgManifest,
          files: {
            "dist/index.d.ts": readFileSync(
              join(hostSourceDir, "vendor/dual-pkg/pkg-files/index.d.ts"),
              "utf8",
            ),
            "dist/index.mjs": readFileSync(
              join(hostSourceDir, "vendor/dual-pkg/pkg-files/index.mjs"),
              "utf8",
            ),
            "dist/index.cjs": readFileSync(
              join(hostSourceDir, "vendor/dual-pkg/pkg-files/index.cjs"),
              "utf8",
            ),
          },
        },
      },
      setup: (host) => {
        host.removePath("vendor");
      },
    },
    async (host) => {
      await host.typecheck("packages/esm/tsconfig.json");
      await host.typecheck("packages/cjs/tsconfig.json");

      // Phase 1: with implementations present -> ESM forwards (clean), CJS clones (finding with .cjs evidence)
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
          (e) => e.at?.file === "node_modules/dual-pkg/dist/index.cjs",
        ),
        `Expected evidence inside dist/index.cjs, got ${JSON.stringify(diag.evidence)}`,
      );
      for (const proj of report1.projects) {
        assert.ok(proj.sourceFiles.every((f) => !f.includes("node_modules/")));
      }
      assert.ok(
        report1.fileOrigins.every((o) => !o.file.includes("node_modules/")),
      );

      // Phase 2: remove `.mjs` and `.cjs` implementations, leaving only `.d.ts`
      host.removePath("node_modules/dual-pkg/dist/index.mjs");
      host.removePath("node_modules/dual-pkg/dist/index.cjs");

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
        report2.gaps.some((g) => g.kind === "missing-instance-model"),
        `Expected missing-instance-model gap, got ${JSON.stringify(report2.gaps)}`,
      );
      assert.ok(
        report2.gaps.some((g) => g.kind === "missing-package-implementation"),
        `Expected missing-package-implementation gap, got ${JSON.stringify(report2.gaps)}`,
      );

      const text2 = await captureCli(
        ["check", "--config", "verule.config.ts"],
        host.rootDir,
      );
      assert.equal(text2.status, 0, text2.stderr);
      assert.match(text2.stdout, /gap \[missing-instance-model\]:/u);
      assert.match(text2.stdout, /gap \[missing-package-implementation\]:/u);
    },
  );
});
