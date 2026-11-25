import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { defineConfig, openSession, runCheck } from "@boringparts/verule";
import {
  defineReentrantQueueModel,
  reentrantQueueFlagRule,
} from "@verule/rules-reference";
import { withTempHost } from "@verule/test-hosts";

const schedulerQueueModel = defineReentrantQueueModel({
  id: "test-scheduler-queue",
  description: "Model for the scheduler queue behavior exercised in this test.",
  contracts: [
    {
      id: "scheduler-queue",
      queueName: "scheduler-queue",
      enqueueFunctionName: "queueJob",
      queueIdentifier: "queue",
      flagProperty: "flags",
      queuedFlagName: "QUEUED",
      reentrantFlagName: "ALLOW_RECURSE",
    },
  ],
});

void describe("@verule/rules-reference reentrantQueueFlagRule", () => {
  void it("flags unguarded direct and indirect post-callback queued clears inside loop/try scopes with full evidence, and clears after adding ALLOW_RECURSE guards while ignoring pre-clears, finally drain, and secondary queues", async () => {
    await withTempHost(
      {
        host: "rules-reference/queue-scheduler",
        prefix: "verule-reentrant-queue-test-",
      },
      async (host) => {
        await host.typecheck();

        const buggyReport = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [schedulerQueueModel],
            rules: [reentrantQueueFlagRule],
          }),
        });

        assert.equal(buggyReport.status, "findings");
        assert.equal(buggyReport.diagnostics.length, 2);
        assert.deepEqual(
          buggyReport.diagnostics.map((d) => ({
            file: d.at.file,
            line: d.at.line,
          })),
          [
            { file: "src/customScheduler.ts", line: 38 },
            { file: "src/customScheduler.ts", line: 66 },
          ],
        );

        const directDiag = buggyReport.diagnostics[0]!;
        assert.ok(directDiag.message.includes("directly"));
        assert.ok(
          directDiag.evidence.some(
            (e) => e.kind === "model" && e.modelId === "test-scheduler-queue",
          ),
          JSON.stringify(directDiag.evidence),
        );
        assert.ok(
          directDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 23 &&
              e.message.includes("|="),
          ),
          JSON.stringify(directDiag.evidence),
        );
        assert.ok(
          directDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 29,
          ),
          JSON.stringify(directDiag.evidence),
        );
        assert.ok(
          directDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 35,
          ),
          JSON.stringify(directDiag.evidence),
        );
        assert.ok(
          directDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 37 &&
              e.message.includes("Direct invocation"),
          ),
          JSON.stringify(directDiag.evidence),
        );
        assert.ok(
          directDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 38 &&
              e.message.includes("&="),
          ),
          JSON.stringify(directDiag.evidence),
        );
        assert.equal(
          directDiag.evidence.some(
            (e) =>
              e.at?.file === "src/customScheduler.ts" &&
              (e.at.line === 52 || e.at.line === 73),
          ),
          false,
          `Unrelated post-flush or finally clear leaked: ${JSON.stringify(directDiag.evidence)}`,
        );

        const indirectDiag = buggyReport.diagnostics[1]!;
        assert.ok(
          indirectDiag.message.includes("indirectly via helper callback"),
        );
        assert.ok(
          indirectDiag.evidence.some(
            (e) => e.kind === "model" && e.modelId === "test-scheduler-queue",
          ),
          JSON.stringify(indirectDiag.evidence),
        );
        assert.ok(
          indirectDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 65 &&
              e.message.includes("invokeSafely"),
          ),
          JSON.stringify(indirectDiag.evidence),
        );
        assert.ok(
          indirectDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customHandling.ts" &&
              e.at.line === 1 &&
              e.message.includes("invokeSafely"),
          ),
          JSON.stringify(indirectDiag.evidence),
        );
        assert.ok(
          indirectDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customHandling.ts" &&
              e.at.line === 3 &&
              e.message.includes("invokes callback parameter"),
          ),
          JSON.stringify(indirectDiag.evidence),
        );
        assert.ok(
          indirectDiag.evidence.some(
            (e) =>
              e.kind === "source" &&
              e.at?.file === "src/customScheduler.ts" &&
              e.at.line === 66 &&
              e.message.includes("&="),
          ),
          JSON.stringify(indirectDiag.evidence),
        );

        // Targeted explain across reported, finally-excluded, and secondary-queue-excluded sites
        const buggySession = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [schedulerQueueModel],
            rules: [reentrantQueueFlagRule],
          }),
        });
        try {
          const reportedExplain = await buggySession.explain({
            ruleId: "reentrant-queue-flag",
            at: { file: "src/customScheduler.ts", line: 38 },
          });
          assert.equal(reportedExplain.explanation?.status, "reported");

          const finallyExplain = await buggySession.explain({
            ruleId: "reentrant-queue-flag",
            at: { file: "src/customScheduler.ts", line: 73 },
          });
          assert.equal(
            finallyExplain.explanation?.status,
            "excluded_by_checkpoint",
          );
          assert.equal(
            finallyExplain.explanation?.excludedByCheckpoint?.name,
            "post-callback-clear-filter",
          );

          const otherQueueExplain = await buggySession.explain({
            ruleId: "reentrant-queue-flag",
            at: { file: "src/customScheduler.ts", line: 52 },
          });
          assert.equal(
            otherQueueExplain.explanation?.status,
            "excluded_by_checkpoint",
          );
          assert.equal(
            otherQueueExplain.explanation?.excludedByCheckpoint?.name,
            "queue-scope-filter",
          );
        } finally {
          await buggySession.close();
        }
      },
    );

    await withTempHost(
      {
        host: "rules-reference/queue-scheduler",
        prefix: "verule-reentrant-queue-fixed-",
        setup: (host) => {
          host.replaceText(
            "src/customScheduler.ts",
            "      cb();\n      cb.flags! &= ~JobFlags.QUEUED;",
            [
              "      cb();",
              "      if (!(cb.flags! & JobFlags.ALLOW_RECURSE)) {",
              "        cb.flags! &= ~JobFlags.QUEUED;",
              "      }",
            ].join("\n"),
          );
          host.replaceText(
            "src/customScheduler.ts",
            "        invokeSafely(job);\n        job.flags! &= ~JobFlags.QUEUED;",
            [
              "        invokeSafely(job);",
              "        if (!(job.flags! & JobFlags.ALLOW_RECURSE)) {",
              "          job.flags! &= ~JobFlags.QUEUED;",
              "        }",
            ].join("\n"),
          );
        },
      },
      async (host) => {
        await host.typecheck();

        const fixedReport = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [schedulerQueueModel],
            rules: [reentrantQueueFlagRule],
          }),
        });

        assert.equal(fixedReport.status, "clean");
        assert.equal(fixedReport.diagnostics.length, 0);

        const fixedSession = await openSession({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [schedulerQueueModel],
            rules: [reentrantQueueFlagRule],
          }),
        });
        try {
          const guardedExplain = await fixedSession.explain({
            ruleId: "reentrant-queue-flag",
            at: { file: "src/customScheduler.ts", line: 39 },
          });
          assert.equal(
            guardedExplain.explanation?.status,
            "excluded_by_checkpoint",
          );
          assert.equal(
            guardedExplain.explanation?.excludedByCheckpoint?.name,
            "branch-guard-coverage",
          );
        } finally {
          await fixedSession.close();
        }
      },
    );
  });

  void it("supports custom ReentrantQueueContract names and early-continue guards", async () => {
    const customModel = defineReentrantQueueModel({
      id: "custom-task-queue",
      contracts: [
        {
          queueName: "render-queue",
          enqueueFunctionName: "enqueueTask",
          queueIdentifier: "taskRing",
          flagProperty: "stateMask",
          queuedFlagName: "IN_QUEUE",
          reentrantFlagName: "REENTRANT",
        },
      ],
    });

    await withTempHost(
      {
        host: "rules-reference/queue-ring",
        prefix: "verule-reentrant-queue-ring-",
      },
      async (host) => {
        await host.typecheck();

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [customModel],
            rules: [reentrantQueueFlagRule],
          }),
        });

        assert.equal(report.status, "findings");
        assert.equal(report.diagnostics.length, 1);
        assert.equal(report.diagnostics[0]!.at.line, 33);
      },
    );
  });

  void it("handles === 0 / == 0 / false guard polarities and early-exiting inner callback invocations", async () => {
    const model = defineReentrantQueueModel({
      id: "polarity-and-inner-queue",
      contracts: [
        {
          queueName: "job-queue",
          enqueueFunctionName: "enqueueJob",
          queueIdentifier: "queue",
          flagProperty: "flags",
          queuedFlagName: "QUEUED",
          reentrantFlagName: "ALLOW_RECURSE",
        },
      ],
    });

    await withTempHost(
      {
        host: "rules-reference/queue-polarity-inner",
        prefix: "verule-reentrant-queue-polarity-",
      },
      async (host) => {
        await host.typecheck();

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [model],
            rules: [reentrantQueueFlagRule],
          }),
        });

        assert.equal(report.status, "findings");
        assert.deepEqual(
          report.diagnostics.map((d) => d.at.line),
          [36, 59, 70, 82],
          JSON.stringify(report.diagnostics),
        );
      },
    );
  });

  void it("handles !== 0, != 0, !== false, != false, == 0, 0 ===, 0 !==, and > 0 guard polarities without inverting branches", async () => {
    const model = defineReentrantQueueModel({
      id: "inequality-polarity-queue",
      contracts: [
        {
          queueName: "job-queue",
          enqueueFunctionName: "enqueueJob",
          queueIdentifier: "queue",
          flagProperty: "flags",
          queuedFlagName: "QUEUED",
          reentrantFlagName: "ALLOW_RECURSE",
        },
      ],
    });

    await withTempHost(
      {
        host: "rules-reference/queue-inequality-polarity",
        prefix: "verule-reentrant-queue-ineq-",
      },
      async (host) => {
        await host.typecheck();

        const report = await runCheck({
          cwd: host.rootDir,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            models: [model],
            rules: [reentrantQueueFlagRule],
          }),
        });

        assert.equal(report.status, "findings");
        assert.deepEqual(
          report.diagnostics.map((d) => d.at.line),
          [32, 51, 70, 73],
          JSON.stringify(report.diagnostics),
        );
      },
    );
  });
});
