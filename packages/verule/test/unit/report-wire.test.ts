import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkReportSchema, toWireReport } from "../../src/report-wire.ts";
import type { CheckReport } from "../../src/types.ts";

void describe("CLI report wire conversion", () => {
  void it("preserves summary evidence, engine observation metrics, and explain cleanupPaths without models", () => {
    const sampleReport: CheckReport = {
      reportVersion: "1",
      status: "findings",
      projects: [],
      fileOrigins: [],
      additionalInputs: [
        {
          file: "tssae.summaries.json",
          exists: true,
          digest: "sum-digest",
          sources: [{ kind: "summary", id: "local-lifecycle" }],
        },
      ],
      diagnostics: [
        {
          id: "diag-1",
          ruleId: "resource-cleanup",
          message: "Resource was not disposed",
          at: {
            file: "src/a.ts",
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 10,
            start: 0,
            end: 9,
          },
          evidence: [
            {
              kind: "summary",
              message: "Derived from local summary",
              summaryId: "local-lifecycle",
              summarySource: "local",
              declaration: "alphaFn",
              at: {
                file: "src/a.ts",
                line: 1,
                column: 1,
                endLine: 1,
                endColumn: 10,
                start: 0,
                end: 9,
              },
            },
            {
              kind: "source",
              message: "Derived from source",
              declaration: "betaFn",
            },
          ],
          projects: ["tsconfig.json"],
        },
      ],
      gaps: [],
      identity: {
        snapshotDigest: "snap-1",
        configDigest: "cfg-1",
        rules: [{ id: "resource-cleanup", digest: "rule-1" }],
      },
      explanation: {
        ruleId: "resource-cleanup",
        target: { file: "src/a.ts", line: 1, column: 1 },
        status: "covered_by_cleanup",
        inCandidates: true,
        summary: "Covered by cleanup.",
        projectsChecked: ["tsconfig.json"],
        matchingCandidates: [],
        queries: [],
        checkpoints: [],
        gaps: [],
        providers: [],
        cleanupPaths: [
          {
            instanceKey: "inst-1",
            scopeLocation: {
              file: "src/a.ts",
              line: 1,
              column: 1,
              endLine: 1,
              endColumn: 10,
              start: 0,
              end: 9,
            },
            cleanupLocations: [],
            summaryIds: ["local-lifecycle"],
            summary: "Resource disposed on all paths.",
            evidence: [],
          },
        ],
      },
      observation: {
        mode: "summary",
        truncated: false,
        droppedCount: 0,
        phases: {
          configAndOpenMs: 1,
          engineQueryMs: 2,
          ruleExecutionMs: 3,
          totalMs: 6,
        },
        rpc: {
          batches: 2,
          queryBatches: 1,
          bytesSent: 100,
          bytesReceived: 200,
        },
        overhead: { checkpointMs: 0, encodeMs: 0, writeMs: 0 },
        queryCount: 2,
        computedQueryCount: 1,
        reusedQueryCount: 1,
        candidateCount: 3,
        checkpointCount: 0,
        providers: [],
        lowering: {
          functionsLowered: 2,
          verticesCreated: 12,
          durationMs: 0.5,
        },
        irCache: {
          functionHits: 1,
          functionMisses: 2,
          filesReused: 3,
          filesInvalidated: 1,
        },
        summaryLookup: {
          lookups: 4,
          hits: 2,
          misses: 2,
          hitsBySource: {
            local: 1,
            package: 0,
            community: 0,
            builtin: 1,
          },
        },
      },
    };

    const wire = toWireReport(sampleReport);
    const parsed = checkReportSchema.parse(wire);

    assert.equal(parsed.diagnostics[0]?.evidence[0]?.kind, "summary");
    assert.equal(
      parsed.diagnostics[0]?.evidence[0]?.summaryId,
      "local-lifecycle",
    );
    assert.equal(parsed.diagnostics[0]?.evidence[0]?.summarySource, "local");
    assert.equal(parsed.diagnostics[0]?.evidence[0]?.declaration, "alphaFn");
    assert.equal(parsed.diagnostics[0]?.evidence[1]?.declaration, "betaFn");
    assert.equal(
      "summaryId" in (parsed.diagnostics[0]?.evidence[1] ?? {}),
      false,
    );
    assert.deepEqual(parsed.explanation?.cleanupPaths[0]?.summaryIds, [
      "local-lifecycle",
    ]);
    assert.deepEqual(parsed.observation?.irCache, {
      functionHits: 1,
      functionMisses: 2,
      filesReused: 3,
      filesInvalidated: 1,
    });
    assert.equal(parsed.observation?.lowering.functionsLowered, 2);
    assert.equal(parsed.observation?.summaryLookup.lookups, 4);
  });
});
