import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { toWireFactConflict } from "../../src/report-wire.ts";

void describe("CLI report wire conversion", () => {
  void it("preserves modelId and declaration on conflict party evidence", () => {
    const wire = toWireFactConflict({
      factTypeId: "test.fact",
      projectId: "proj-1",
      snapshotId: 1,
      subjectHandleId: "syn:1:1",
      reason: "conflicting conclusions",
      parties: [
        {
          providerId: "alpha",
          providers: ["alpha"],
          conclusion: { ok: true },
          conclusionSummary: '{"ok":true}',
          evidence: [
            {
              kind: "model",
              message: "Derived from alpha model",
              modelId: "alpha-model",
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
          ],
        },
        {
          providerId: "beta",
          providers: ["beta"],
          conclusion: { ok: false },
          conclusionSummary: '{"ok":false}',
          evidence: [
            {
              kind: "source",
              message: "Derived from beta source",
              declaration: "betaFn",
            },
          ],
        },
      ],
    });

    assert.equal(wire.parties[0].evidence[0]?.modelId, "alpha-model");
    assert.equal(wire.parties[0].evidence[0]?.declaration, "alphaFn");
    assert.equal(wire.parties[1].evidence[0]?.declaration, "betaFn");
    assert.equal("modelId" in (wire.parties[1].evidence[0] ?? {}), false);
  });
});
