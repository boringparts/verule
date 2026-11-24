import assert from "node:assert/strict";
import { join } from "node:path";
import { test } from "node:test";

import { resolveCliHostDir, withCliTempHost } from "@verule/cli-hosts";

import { checkReportSchema } from "../../src/report-wire.ts";
import { captureCli } from "./cli-test-helpers.ts";

void test("verule check distinguishes resource instances across factories/models, emits model evidence, and surfaces missing-model gaps", async () => {
  await withCliTempHost(
    {
      host: "integration/instance-identity",
      packageLinks: {
        "@acme/lifecycle": join(
          resolveCliHostDir("integration/instance-identity"),
          "vendor/@acme/lifecycle",
        ),
      },
    },
    async (host) => {
      await host.typecheck();

      const jsonRun = await captureCli(
        ["check", "--config", "verule.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(jsonRun.status, 1, jsonRun.stderr);

      const envelope = JSON.parse(jsonRun.stdout) as {
        readonly variant: string;
        readonly data: unknown;
      };
      assert.equal(envelope.variant, "findings");
      const parsedReport = checkReportSchema.parse(envelope.data);
      assert.equal(parsedReport.status, "findings");
      assert.equal(parsedReport.diagnostics.length, 1);

      const diag = parsedReport.diagnostics[0]!;
      assert.equal(diag.ruleId, "check-instance-cleanup-match");
      assert.equal(diag.at.file, "src/app.ts");
      assert.match(diag.message, /different instance/u);
      assert.ok(
        diag.evidence.some((e) => e.kind === "source"),
        "Expected source evidence in CLI report",
      );
      assert.ok(
        diag.evidence.some(
          (e) =>
            e.kind === "model" &&
            e.modelId === "acme-lifecycle" &&
            e.declaration?.includes("_register"),
        ),
        "Expected model evidence for Disposable._register",
      );
      assert.ok(
        diag.evidence.some(
          (e) =>
            e.kind === "model" &&
            e.modelId === "acme-lifecycle" &&
            e.declaration?.includes("createMenu"),
        ),
        "Expected model evidence for IMenuService.createMenu",
      );
      assert.ok(
        parsedReport.gaps.some((g) => g.kind === "missing-instance-model"),
        `Expected missing-instance-model gap, got ${JSON.stringify(parsedReport.gaps)}`,
      );

      const textRun = await captureCli(
        ["check", "--config", "verule.config.ts"],
        host.rootDir,
      );
      assert.equal(textRun.status, 1, textRun.stderr);
      assert.match(textRun.stdout, /evidence \(source\):/u);
      assert.match(
        textRun.stdout,
        /evidence \(model\): .*\[model=acme-lifecycle:/u,
      );
      assert.match(textRun.stdout, /gap \[missing-instance-model\]:/u);
    },
  );
});
