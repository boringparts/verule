import assert from "node:assert/strict";
import { test } from "node:test";

import {
  computeMedian,
  deduplicateTiers,
  formatPerfMarkdownReport,
  formatPerfSummaryTable,
  generatePoolOwnershipProject,
  type PackedArtifactBundle,
  parsePerfCliArgs,
  parseScaleTier,
  type PerfBaselineReport,
  runPoolOwnershipPerfBaseline,
} from "../../src/index.ts";

function createDummyBundle(): PackedArtifactBundle {
  return {
    packDir: "/tmp/dummy-pack",
    artifacts: [
      {
        name: "tssae",
        version: "0.1.0",
        filename: "/tmp/dummy-pack/tssae.tgz",
        size: 123,
        sha256: "a".repeat(64),
        sha1: "b".repeat(40),
        integrity: "sha512-dummy",
        manifest: { name: "tssae", version: "0.1.0" },
        binarySha256: "c".repeat(64),
      },
    ],
    dispose() {},
  };
}

void test("parsePerfCliArgs defaults to five unique tiers with 256/8 counted once and parses overrides", () => {
  const defaults = parsePerfCliArgs([]);
  assert.equal(defaults.scenario, "pool-ownership");
  assert.equal(defaults.samples, 5);
  assert.equal(defaults.retries, 0);
  assert.deepEqual(defaults.tiers, [
    { fileCount: 64, candidateFactoryCount: 8 },
    { fileCount: 256, candidateFactoryCount: 8 },
    { fileCount: 1024, candidateFactoryCount: 8 },
    { fileCount: 256, candidateFactoryCount: 32 },
    { fileCount: 256, candidateFactoryCount: 128 },
  ]);

  const custom = parsePerfCliArgs([
    "--",
    "--scenario",
    "pool-ownership",
    "--tier",
    "64/8",
    "--tiers=256/8,1024/8,256/8",
    "--tier=64/8",
    "--samples",
    "3",
    "--retries=1",
    "--json-out",
    "/tmp/out.json",
    "--markdown-out=/tmp/out.md",
  ]);
  assert.equal(custom.samples, 3);
  assert.equal(custom.retries, 1);
  assert.equal(custom.jsonOut, "/tmp/out.json");
  assert.equal(custom.markdownOut, "/tmp/out.md");
  assert.deepEqual(custom.tiers, [
    { fileCount: 64, candidateFactoryCount: 8 },
    { fileCount: 256, candidateFactoryCount: 8 },
    { fileCount: 1024, candidateFactoryCount: 8 },
  ]);
});

void test("parseScaleTier, deduplicateTiers, and parsePerfCliArgs reject invalid inputs", () => {
  assert.deepEqual(
    deduplicateTiers([
      parseScaleTier("256/8"),
      parseScaleTier("64/8"),
      parseScaleTier("256/8"),
    ]),
    [
      { fileCount: 256, candidateFactoryCount: 8 },
      { fileCount: 64, candidateFactoryCount: 8 },
    ],
  );

  assert.throws(
    () => parsePerfCliArgs(["--scenario", "unknown-scenario"]),
    /Unknown scenario/u,
  );
  assert.throws(
    () => parseScaleTier("256"),
    /Expected "<files>\/<candidates>"/u,
  );
  assert.throws(
    () => parseScaleTier("4/1"),
    /fileCount must be an integer >= 5/u,
  );
  assert.throws(
    () => parseScaleTier("64/0"),
    /candidateFactoryCount must be an integer >= 1/u,
  );
  assert.throws(
    () => parsePerfCliArgs(["--samples", "0"]),
    /positive integer/u,
  );
  assert.throws(
    () => parsePerfCliArgs(["--retries", "-1"]),
    /non-negative integer/u,
  );
  assert.throws(() => parsePerfCliArgs(["--unknown"]), /Unknown option/u);
});

void test("computeMedian handles empty, odd, and even numeric arrays", () => {
  assert.equal(computeMedian([]), null);
  assert.equal(computeMedian([42.5]), 42.5);
  assert.equal(computeMedian([300, 100, 200]), 200);
  assert.equal(computeMedian([400, 100, 300, 200]), 250);
});

void test("runPoolOwnershipPerfBaseline records retries, failure reasons, not_run items, and formats summary table", async () => {
  const seenTiers: string[] = [];
  const report: PerfBaselineReport = await runPoolOwnershipPerfBaseline({
    samples: 2,
    retries: 1,
    bundle: createDummyBundle(),
    executeTier: async ({ tier, samples }) => {
      const label = `${String(tier.fileCount)}/${String(tier.candidateFactoryCount)}`;
      seenTiers.push(label);

      if (label === "64/8") {
        // Round 1 fails then succeeds on retry; round 2 succeeds on first attempt.
        return {
          isolationMode: "node-permission",
          preflight: {
            status: "succeeded",
            typecheckMs: 500,
            scaleAuditMs: 700,
            observedFileCount: 64,
            observedCandidateCount: 8,
            seedCheckpointCount: 8,
            judgmentCheckpointCount: 8,
            coldReconcileStates: ["initial", "fixed", "restored", "unrelated"],
          },
          rounds: [
            {
              round: 1,
              status: "succeeded",
              coldCheckMs: 520,
              fixOwnershipMs: 110,
              unrelatedEditMs: 85,
              retryCount: 1,
              attempts: [
                {
                  attempt: 1,
                  status: "failed",
                  failureReason:
                    "watch fix ownership timed out: Timed out waiting for watch report",
                  durationMs: 1200,
                },
                {
                  attempt: 2,
                  status: "succeeded",
                  coldCheckMs: 520,
                  fixOwnershipMs: 110,
                  unrelatedEditMs: 85,
                  durationMs: 900,
                },
              ],
            },
            {
              round: 2,
              status: "succeeded",
              coldCheckMs: 500,
              fixOwnershipMs: 100,
              unrelatedEditMs: 75,
              retryCount: 0,
              attempts: [
                {
                  attempt: 1,
                  status: "succeeded",
                  coldCheckMs: 500,
                  fixOwnershipMs: 100,
                  unrelatedEditMs: 75,
                  durationMs: 800,
                },
              ],
            },
          ],
          durationMs: 3000,
        };
      }

      if (label === "256/8") {
        // Explicit failures for early exit, stale snapshot, and report mismatch
        return {
          preflight: {
            status: "succeeded",
            observedFileCount: 256,
            observedCandidateCount: 8,
            coldReconcileStates: ["initial", "fixed", "restored", "unrelated"],
          },
          rounds: [
            {
              round: 1,
              status: "failed",
              retryCount: 1,
              attempts: [
                {
                  attempt: 1,
                  status: "failed",
                  failureReason:
                    "Cold check exited early with status 2 (expected 1): crash",
                  durationMs: 100,
                },
                {
                  attempt: 2,
                  status: "failed",
                  failureReason:
                    "Stale snapshot after ownership fix: expected snapshotId>2, got snapshotId=2",
                  durationMs: 200,
                },
              ],
              failureReason:
                "Stale snapshot after ownership fix: expected snapshotId>2, got snapshotId=2",
            },
            {
              round: 2,
              status: "failed",
              retryCount: 0,
              attempts: [
                {
                  attempt: 1,
                  status: "failed",
                  failureReason:
                    "Watch/cold check reconciliation failed at round 2",
                  durationMs: 150,
                },
              ],
              failureReason:
                "Watch/cold check reconciliation failed at round 2",
            },
          ],
          durationMs: 450,
        };
      }

      if (label === "1024/8") {
        // Preflight failure leaves all rounds as not_run and aborts remaining tiers
        return {
          preflight: {
            status: "failed",
            coldReconcileStates: ["initial"],
            failureReason: "Scale mismatch: expected 1024 files, got 1023",
          },
          rounds: Array.from({ length: samples }, (_, index) => ({
            round: index + 1,
            status: "not_run" as const,
            retryCount: 0,
            attempts: [],
            failureReason:
              "Preflight verification failed: Scale mismatch: expected 1024 files, got 1023",
          })),
          abortRemainingTiers: true,
          failureReason: "Scale mismatch: expected 1024 files, got 1023",
          durationMs: 300,
        };
      }

      throw new Error(`Unexpected execution for tier ${label}`);
    },
  });

  // 256/8 ran once; 256/32 and 256/128 were marked not_run after abort
  assert.deepEqual(seenTiers, ["64/8", "256/8", "1024/8"]);
  assert.equal(report.status, "failed");
  assert.equal(report.tiers.length, 5);

  const [t64, t256, t1024, t256c32, t256c128] = report.tiers;
  assert.equal(t64?.status, "succeeded");
  assert.equal(t64?.totalRetries, 1);
  assert.equal(t64?.medianColdCheckMs, 510);
  assert.equal(t64?.medianFixOwnershipMs, 105);
  assert.equal(t64?.medianUnrelatedEditMs, 80);

  assert.equal(t256?.status, "failed");
  assert.equal(t256?.succeededRounds, 0);
  assert.equal(t256?.failedRounds, 2);
  assert.equal(t256?.medianColdCheckMs, null);
  assert.match(t256?.failureReason ?? "", /Stale snapshot/u);

  assert.equal(t1024?.status, "failed");
  assert.equal(t1024?.notRunRounds, 2);
  assert.equal(t1024?.rounds[0]?.status, "not_run");

  assert.equal(t256c32?.status, "not_run");
  assert.equal(t256c32?.notRunRounds, 2);
  assert.equal(t256c128?.status, "not_run");
  assert.equal(t256c128?.notRunRounds, 2);

  const table = formatPerfSummaryTable(report);
  assert.match(table, /Files\s+\|\s+Candidates\s+\|\s+Cold Check \(ms\)/u);
  assert.match(table, /510\.0/u);
  assert.match(table, /105\.0/u);
  assert.match(table, /80\.0/u);
  assert.match(table, /not_run/u);
  assert.match(table, /Stale snapshot/u);

  const md = formatPerfMarkdownReport(report);
  assert.match(md, /五档中位数汇总/u);
  assert.match(md, /各轮原始采样与状态/u);
});

void test("runPoolOwnershipPerfBaseline marks a tier whose setup throws as failed while leaving subsequent unattempted tiers as not_run", async () => {
  const cliOptions = parsePerfCliArgs([
    "--tier",
    "5/3",
    "--tier",
    "64/8",
    "--samples",
    "2",
  ]);
  const seenTiers: string[] = [];

  const report = await runPoolOwnershipPerfBaseline({
    scenario: cliOptions.scenario,
    tiers: cliOptions.tiers,
    samples: cliOptions.samples,
    retries: cliOptions.retries,
    bundle: createDummyBundle(),
    executeTier: async ({ tier }) => {
      seenTiers.push(
        `${String(tier.fileCount)}/${String(tier.candidateFactoryCount)}`,
      );
      generatePoolOwnershipProject(tier);
      throw new Error("Should not reach execution after invalid 5/3 tier");
    },
  });

  assert.deepEqual(seenTiers, ["5/3"]);
  assert.equal(report.status, "failed");
  assert.equal(report.tiers.length, 2);

  const [failedTier, unattemptedTier] = report.tiers;
  assert.equal(failedTier?.tierLabel, "5/3");
  assert.equal(failedTier?.status, "failed");
  assert.equal(failedTier?.preflight.status, "failed");
  assert.equal(failedTier?.notRunRounds, 2);
  assert.match(
    failedTier?.failureReason ?? "",
    /Unrecoverable setup error in tier 5\/3: Cannot fit \d+ base files into fileCount=5/u,
  );

  assert.equal(unattemptedTier?.tierLabel, "64/8");
  assert.equal(unattemptedTier?.status, "not_run");
  assert.equal(unattemptedTier?.preflight.status, "not_run");
  assert.equal(unattemptedTier?.notRunRounds, 2);
});
