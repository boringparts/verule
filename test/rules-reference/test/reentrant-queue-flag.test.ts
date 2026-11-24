import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  defineReentrantQueueModel,
  reentrantQueueFlagRule,
} from "@verule/rules-reference";
import { defineConfig, openSession, runCheck } from "@verule/sdk";

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

function createTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-reentrant-queue-test-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*"],
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void describe("@verule/rules-reference reentrantQueueFlagRule", () => {
  void it("flags unguarded direct and indirect post-callback queued clears inside loop/try scopes with full evidence, and clears after adding ALLOW_RECURSE guards while ignoring pre-clears, finally drain, and secondary queues", async () => {
    const buggyFiles: Record<string, string> = {
      "src/customHandling.ts": [
        "export function invokeSafely(fn: () => void): void {",
        "  try {",
        "    fn();",
        "  } catch {",
        "    // handled",
        "  }",
        "}",
        "",
      ].join("\n"),
      "src/customScheduler.ts": [
        "import { invokeSafely } from './customHandling.js';",
        "",
        "export const JobFlags = {",
        "  QUEUED: 1 << 0,",
        "  PRE: 1 << 1,",
        "  ALLOW_RECURSE: 1 << 2,",
        "  DISPOSED: 1 << 3,",
        "} as const;",
        "",
        "export interface Task {",
        "  (): void;",
        "  flags?: number;",
        "}",
        "",
        "const queue: Task[] = [];",
        "const pendingPostCbs: Task[] = [];",
        "let activePostCbs: Task[] | null = null;",
        "let flushIndex = 0;",
        "",
        "export function queueJob(job: Task): void {",
        "  if (!(job.flags! & JobFlags.QUEUED)) {",
        "    queue.push(job);",
        "    job.flags! |= JobFlags.QUEUED;",
        "  }",
        "}",
        "",
        "export function flushPreFlushCbs(skip: boolean): void {",
        "  for (let i = 0; i < queue.length; i++) {",
        "    const cb = queue[i];",
        "    if (cb && (cb.flags! & JobFlags.PRE)) {",
        "      if (skip) {",
        "        continue;",
        "      }",
        "      if (cb.flags! & JobFlags.ALLOW_RECURSE) {",
        "        cb.flags! &= ~JobFlags.QUEUED;",
        "      }",
        "      cb();",
        "      cb.flags! &= ~JobFlags.QUEUED;",
        "    }",
        "  }",
        "}",
        "",
        "export function flushPostFlushCbs(): void {",
        "  activePostCbs = [...pendingPostCbs];",
        "  pendingPostCbs.length = 0;",
        "  for (let i = 0; i < activePostCbs.length; i++) {",
        "    const cb = activePostCbs[i];",
        "    if (cb.flags! & JobFlags.ALLOW_RECURSE) {",
        "      cb.flags! &= ~JobFlags.QUEUED;",
        "    }",
        "    cb();",
        "    cb.flags! &= ~JobFlags.QUEUED;",
        "  }",
        "  activePostCbs = null;",
        "}",
        "",
        "export function flushJobs(): void {",
        "  try {",
        "    for (flushIndex = 0; flushIndex < queue.length; flushIndex++) {",
        "      const job = queue[flushIndex];",
        "      if (job && !(job.flags! & JobFlags.DISPOSED)) {",
        "        if (job.flags! & JobFlags.ALLOW_RECURSE) {",
        "          job.flags! &= ~JobFlags.QUEUED;",
        "        }",
        "        invokeSafely(job);",
        "        job.flags! &= ~JobFlags.QUEUED;",
        "      }",
        "    }",
        "  } finally {",
        "    for (; flushIndex < queue.length; flushIndex++) {",
        "      const job = queue[flushIndex];",
        "      if (job) {",
        "        job.flags! &= ~JobFlags.QUEUED;",
        "      }",
        "    }",
        "    flushIndex = 0;",
        "    queue.length = 0;",
        "  }",
        "}",
        "",
      ].join("\n"),
    };

    const buggyRoot = createTempProject(buggyFiles);
    try {
      const buggyReport = await runCheck({
        cwd: buggyRoot,
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
        cwd: buggyRoot,
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
    } finally {
      rmSync(buggyRoot, { recursive: true, force: true });
    }

    const fixedRoot = createTempProject({
      ...buggyFiles,
      "src/customScheduler.ts": buggyFiles["src/customScheduler.ts"]!.replace(
        "      cb();\n      cb.flags! &= ~JobFlags.QUEUED;",
        [
          "      cb();",
          "      if (!(cb.flags! & JobFlags.ALLOW_RECURSE)) {",
          "        cb.flags! &= ~JobFlags.QUEUED;",
          "      }",
        ].join("\n"),
      ).replace(
        "        invokeSafely(job);\n        job.flags! &= ~JobFlags.QUEUED;",
        [
          "        invokeSafely(job);",
          "        if (!(job.flags! & JobFlags.ALLOW_RECURSE)) {",
          "          job.flags! &= ~JobFlags.QUEUED;",
          "        }",
        ].join("\n"),
      ),
    });

    try {
      const fixedReport = await runCheck({
        cwd: fixedRoot,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          models: [schedulerQueueModel],
          rules: [reentrantQueueFlagRule],
        }),
      });

      assert.equal(fixedReport.status, "clean");
      assert.equal(fixedReport.diagnostics.length, 0);

      const fixedSession = await openSession({
        cwd: fixedRoot,
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
    } finally {
      rmSync(fixedRoot, { recursive: true, force: true });
    }
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

    const root = createTempProject({
      "src/ring.ts": [
        "const enum Mask { IN_QUEUE = 1, REENTRANT = 2 }",
        "interface RingTask { (): void; stateMask: number }",
        "const taskRing: RingTask[] = [];",
        "",
        "export function enqueueTask(task: RingTask): void {",
        "  if (!(task.stateMask & Mask.IN_QUEUE)) {",
        "    taskRing.push(task);",
        "    task.stateMask |= Mask.IN_QUEUE;",
        "  }",
        "}",
        "",
        "export function drainGuardedByContinue(): void {",
        "  for (let i = 0; i < taskRing.length; i++) {",
        "    const item = taskRing[i];",
        "    item();",
        "    if (item.stateMask & Mask.REENTRANT) {",
        "      continue;",
        "    }",
        "    item.stateMask &= ~Mask.IN_QUEUE;",
        "  }",
        "}",
        "",
        "export function drainUnguarded(): void {",
        "  for (let i = 0; i < taskRing.length; i++) {",
        "    const item = taskRing[i];",
        "    item();",
        "    item.stateMask &= ~Mask.IN_QUEUE;",
        "  }",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          models: [customModel],
          rules: [reentrantQueueFlagRule],
        }),
      });

      assert.equal(report.status, "findings");
      assert.equal(report.diagnostics.length, 1);
      assert.equal(report.diagnostics[0]!.at.line, 27);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
