import assert from "node:assert/strict";
import { test } from "node:test";

import { withAcceptanceHost } from "@verule/acceptance";
import type { CheckReport, VeruleConfig } from "@verule/sdk";

const configPath = "packages/app/verule.config.ts";
const schedulerPath = "packages/app/src/scheduler.ts";
const helperPath = "packages/app/src/helper.ts";

function findLine(source: string, lineText: string): number {
  const lines = source.split("\n");
  const idx = lines.findIndex((line) => line === lineText);
  assert.notEqual(
    idx,
    -1,
    `Expected source to contain line ${JSON.stringify(lineText)}`,
  );
  return idx + 1;
}

async function runInstalledSdk(
  host: Parameters<Parameters<typeof withAcceptanceHost>[1]>[0],
): Promise<CheckReport> {
  const sdk = await host.loadSdk();
  const config = await host.loadConfig<VeruleConfig>(configPath);
  return sdk.runCheck({ cwd: host.hostDir, config });
}

void test("verifies reentrantQueueFlagRule through installed CLI and SDK across direct, helper-mediated, guarded, secondary-queue, and --at explain scenarios", async (t) => {
  await withAcceptanceHost(
    {
      overlay: "queue",
      additionalPackages: [
        "@verule/rules-reference",
        "@verule/adapter-drizzle",
        "@verule/adapter-zod",
      ],
      directPackages: ["@verule/sdk", "@verule/cli", "@verule/rules-reference"],
    },
    async (host) => {
      const cliArtifact = host.artifact("@verule/cli");
      const rulesArtifact = host.artifact("@verule/rules-reference");
      const schedulerSource = host.readText(schedulerPath);

      const enqueueLine = findLine(
        schedulerSource,
        "    job.flags! |= JobFlags.QUEUED;",
      );
      const preClearLine = findLine(
        schedulerSource,
        "        cb.flags! &= ~JobFlags.QUEUED;",
      );
      const directCallLine = findLine(schedulerSource, "      cb();");
      const directClearLine = findLine(
        schedulerSource,
        "      cb.flags! &= ~JobFlags.QUEUED;",
      );
      const indirectCallLine = findLine(
        schedulerSource,
        "        invokeSafely(job);",
      );
      const indirectClearLine = findLine(
        schedulerSource,
        "        job.flags! &= ~JobFlags.QUEUED;",
      );
      const finallyTokenIndex = schedulerSource.indexOf(
        "        job.flags! &= ~JobFlags.QUEUED;\n      }\n    }\n    flushIndex",
      );
      assert.notEqual(finallyTokenIndex, -1);
      const actualFinallyClearLine = schedulerSource
        .slice(0, finallyTokenIndex)
        .split("\n").length;
      const secondaryClearLine = findLine(
        schedulerSource,
        "      task.flags! &= ~JobFlags.QUEUED;",
      );
      const continueGuardClearLine = findLine(
        schedulerSource,
        "      item.flags! &= ~JobFlags.QUEUED;",
      );

      const initialResult = await host.check({ config: configPath });
      assert.equal(initialResult.status, 1, initialResult.stderr);
      assert.equal(initialResult.isolation?.controlProbeBlocked, true);
      assert.equal(initialResult.variant, "findings");
      assert.equal(
        initialResult.report.diagnostics.length,
        2,
        JSON.stringify(initialResult.report.diagnostics),
      );

      assert.deepEqual(
        initialResult.report.diagnostics.map((d) => ({
          ruleId: d.ruleId,
          file: d.at.file,
          line: d.at.line,
        })),
        [
          {
            ruleId: "reentrant-queue-flag",
            file: schedulerPath,
            line: directClearLine,
          },
          {
            ruleId: "reentrant-queue-flag",
            file: schedulerPath,
            line: indirectClearLine,
          },
        ],
      );

      const directDiag = initialResult.report.diagnostics[0]!;
      assert.ok(directDiag.message.includes("directly"));
      assert.ok(
        directDiag.evidence.some(
          (ev) =>
            ev.kind === "model" && ev.modelId === "acceptance-scheduler-queue",
        ),
        JSON.stringify(directDiag.evidence),
      );
      assert.ok(
        directDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === schedulerPath &&
            ev.at.line === enqueueLine,
        ),
        JSON.stringify(directDiag.evidence),
      );
      assert.ok(
        directDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === schedulerPath &&
            ev.at.line === preClearLine,
        ),
        JSON.stringify(directDiag.evidence),
      );
      assert.ok(
        directDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === schedulerPath &&
            ev.at.line === directCallLine &&
            ev.message.includes("Direct invocation"),
        ),
        JSON.stringify(directDiag.evidence),
      );
      assert.ok(
        directDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === schedulerPath &&
            ev.at.line === directClearLine,
        ),
        JSON.stringify(directDiag.evidence),
      );
      assert.equal(
        directDiag.evidence.some(
          (ev) =>
            ev.at?.file === schedulerPath &&
            (ev.at.line === secondaryClearLine ||
              ev.at.line === continueGuardClearLine ||
              ev.at.line === actualFinallyClearLine),
        ),
        false,
        `Unrelated candidate evidence leaked: ${JSON.stringify(directDiag.evidence)}`,
      );

      const indirectDiag = initialResult.report.diagnostics[1]!;
      assert.ok(
        indirectDiag.message.includes("indirectly via helper callback"),
      );
      assert.ok(
        indirectDiag.evidence.some(
          (ev) =>
            ev.kind === "model" && ev.modelId === "acceptance-scheduler-queue",
        ),
      );
      assert.ok(
        indirectDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === schedulerPath &&
            ev.at.line === indirectCallLine &&
            ev.message.includes("invokeSafely"),
        ),
        JSON.stringify(indirectDiag.evidence),
      );
      assert.ok(
        indirectDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === helperPath &&
            ev.at.line === 1 &&
            ev.message.includes("invokeSafely"),
        ),
        JSON.stringify(indirectDiag.evidence),
      );
      assert.ok(
        indirectDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === helperPath &&
            ev.at.line === 3 &&
            ev.message.includes("invokes callback parameter"),
        ),
        JSON.stringify(indirectDiag.evidence),
      );
      assert.ok(
        indirectDiag.evidence.some(
          (ev) =>
            ev.kind === "source" &&
            ev.at?.file === schedulerPath &&
            ev.at.line === indirectClearLine,
        ),
        JSON.stringify(indirectDiag.evidence),
      );

      assert.deepEqual(await runInstalledSdk(host), initialResult.report);

      // Targeted --at explain via installed CLI
      const reportedExplain = await host.check({
        config: configPath,
        rule: "reentrant-queue-flag",
        at: `${schedulerPath}:${directClearLine}`,
      });
      assert.equal(reportedExplain.status, 1, reportedExplain.stderr);
      assert.equal(reportedExplain.report.explanation?.status, "reported");
      assert.ok(
        reportedExplain.report.explanation?.checkpoints.some(
          (cp) => cp.name === "branch-guard-coverage" && cp.outcome === "pass",
        ),
      );

      const secondaryExplain = await host.check({
        config: configPath,
        rule: "reentrant-queue-flag",
        at: `${schedulerPath}:${secondaryClearLine}`,
      });
      assert.equal(secondaryExplain.status, 1, secondaryExplain.stderr);
      assert.equal(
        secondaryExplain.report.explanation?.status,
        "excluded_by_checkpoint",
      );
      assert.equal(
        secondaryExplain.report.explanation?.excludedByCheckpoint?.name,
        "queue-scope-filter",
      );

      const finallyExplain = await host.check({
        config: configPath,
        rule: "reentrant-queue-flag",
        at: `${schedulerPath}:${actualFinallyClearLine}`,
      });
      assert.equal(finallyExplain.status, 1, finallyExplain.stderr);
      assert.equal(
        finallyExplain.report.explanation?.status,
        "excluded_by_checkpoint",
      );
      assert.equal(
        finallyExplain.report.explanation?.excludedByCheckpoint?.name,
        "post-callback-clear-filter",
      );

      const continueGuardExplain = await host.check({
        config: configPath,
        rule: "reentrant-queue-flag",
        at: `${schedulerPath}:${continueGuardClearLine}`,
      });
      assert.equal(continueGuardExplain.status, 1, continueGuardExplain.stderr);
      assert.equal(
        continueGuardExplain.report.explanation?.status,
        "excluded_by_checkpoint",
      );
      assert.equal(
        continueGuardExplain.report.explanation?.excludedByCheckpoint?.name,
        "branch-guard-coverage",
      );

      // Guard both unguarded post-callback clears and verify clean report + guarded explain
      host.replaceText(
        schedulerPath,
        "      cb();\n      cb.flags! &= ~JobFlags.QUEUED;",
        [
          "      cb();",
          "      if (!(cb.flags! & JobFlags.ALLOW_RECURSE)) {",
          "        cb.flags! &= ~JobFlags.QUEUED;",
          "      }",
        ].join("\n"),
      );
      host.replaceText(
        schedulerPath,
        "        invokeSafely(job);\n        job.flags! &= ~JobFlags.QUEUED;",
        [
          "        invokeSafely(job);",
          "        if (!(job.flags! & JobFlags.ALLOW_RECURSE)) {",
          "          job.flags! &= ~JobFlags.QUEUED;",
          "        }",
        ].join("\n"),
      );

      const fixedResult = await host.check({ config: configPath });
      assert.equal(fixedResult.status, 0, fixedResult.stderr);
      assert.equal(fixedResult.variant, "clean");
      assert.deepEqual(fixedResult.report.diagnostics, []);
      assert.deepEqual(await runInstalledSdk(host), fixedResult.report);

      const guardedSource = host.readText(schedulerPath);
      const guardedIfIndex = guardedSource.indexOf(
        "      if (!(cb.flags! & JobFlags.ALLOW_RECURSE)) {",
      );
      assert.notEqual(guardedIfIndex, -1);
      const guardedDirectClearLine =
        guardedSource.slice(0, guardedIfIndex).split("\n").length + 1;
      const guardedExplain = await host.check({
        config: configPath,
        rule: "reentrant-queue-flag",
        at: `${schedulerPath}:${guardedDirectClearLine}`,
      });
      assert.equal(guardedExplain.status, 0, guardedExplain.stderr);
      assert.equal(
        guardedExplain.report.explanation?.status,
        "excluded_by_checkpoint",
      );
      assert.equal(
        guardedExplain.report.explanation?.excludedByCheckpoint?.name,
        "branch-guard-coverage",
      );

      t.diagnostic(
        `Packed CLI ${cliArtifact.version}; rules-reference ${rulesArtifact.version}; isolation ${initialResult.isolation?.mode}`,
      );
    },
  );
});
