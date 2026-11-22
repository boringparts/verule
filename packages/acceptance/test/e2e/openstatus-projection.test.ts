import assert from "node:assert/strict";
import { test } from "node:test";

import {
  OPENSTATUS_GET_GATE_FILE,
  OPENSTATUS_GET_GATE_SHA,
  OPENSTATUS_WHOAMI_STEPS,
  runOpenStatusProjectionAcceptance,
} from "@verule/acceptance";

void test("replays OpenStatus whoami sequence and getGate original + manual-edit sequence via installed verule CLI", async () => {
  const result = await runOpenStatusProjectionAcceptance();

  // Verify all 6 packed packages and binary digests
  assert.equal(result.artifacts.length, 6);
  for (const pkgName of [
    "@verule/engine",
    "@verule/sdk",
    "@verule/cli",
    "@verule/adapter-zod",
    "@verule/adapter-drizzle",
    "@verule/rules-reference",
  ]) {
    const artifact = result.artifacts.find((a) => a.name === pkgName);
    assert.ok(artifact, `Missing artifact digest for ${pkgName}`);
    assert.match(artifact.sha256, /^[0-9a-f]{64}$/u);
  }

  // 1. Verify whoami 3-commit sequence
  assert.equal(result.whoamiReplays.length, 3);

  const [whoamiInitial, whoamiFixTypo, whoamiRemoveField] =
    result.whoamiReplays;
  assert.ok(whoamiInitial && whoamiFixTypo && whoamiRemoveField);

  assert.equal(whoamiInitial.kind, "upstream-commit");
  assert.equal(whoamiInitial.sha, OPENSTATUS_WHOAMI_STEPS[0]!.sha);
  assert.deepEqual(
    whoamiInitial.projects.map((p) => p.projectId),
    ["apps/server/tsconfig.json", "packages/db/tsconfig.json"],
  );
  assert.ok(whoamiInitial.totalSourceFiles > 0);
  assert.equal(whoamiInitial.targetDiagnostics.length, 1);
  assert.equal(whoamiInitial.allDiagnosticsCount, 1);
  assert.equal(whoamiInitial.exitCode, 1);
  const initialDiag = whoamiInitial.targetDiagnostics[0]!;
  assert.equal(initialDiag.at.file, "apps/server/src/v1/whoami/get.ts");
  assert.match(initialDiag.message, /\bslub\b/u);
  assert.match(initialDiag.message, /\bworkspaceId\b/u);
  assert.doesNotMatch(initialDiag.message, /\bplan\b/u);
  assert.doesNotMatch(initialDiag.message, /\bname\b/u);
  assert.ok(
    initialDiag.evidence.some(
      (ev) => ev.at?.file === "packages/db/src/schema/workspaces/workspace.ts",
    ),
    `Expected workspace table evidence in ${JSON.stringify(initialDiag.evidence)}`,
  );
  assert.ok(
    initialDiag.evidence.some(
      (ev) => ev.at?.file === "apps/server/src/v1/whoami/schema.ts",
    ),
    `Expected whoami/schema.ts evidence in ${JSON.stringify(initialDiag.evidence)}`,
  );

  assert.equal(whoamiFixTypo.kind, "upstream-commit");
  assert.equal(whoamiFixTypo.sha, OPENSTATUS_WHOAMI_STEPS[1]!.sha);
  assert.equal(whoamiFixTypo.targetDiagnostics.length, 1);
  assert.equal(whoamiFixTypo.allDiagnosticsCount, 1);
  assert.equal(whoamiFixTypo.exitCode, 1);
  const fixTypoDiag = whoamiFixTypo.targetDiagnostics[0]!;
  assert.equal(fixTypoDiag.at.file, "apps/server/src/v1/whoami/get.ts");
  assert.doesNotMatch(fixTypoDiag.message, /\bslub\b/u);
  assert.match(fixTypoDiag.message, /\bworkspaceId\b/u);

  assert.equal(whoamiRemoveField.kind, "upstream-commit");
  assert.equal(whoamiRemoveField.sha, OPENSTATUS_WHOAMI_STEPS[2]!.sha);
  assert.equal(whoamiRemoveField.targetDiagnostics.length, 0);
  assert.equal(whoamiRemoveField.allDiagnosticsCount, 0);
  assert.equal(whoamiRemoveField.exitCode, 0);

  // 2. Verify getGate baseline + manual-edit sequence
  assert.equal(result.getGateReplays.length, 3);
  const [gateBaseline, gateRemovedSlug, gateRestoredSlug] =
    result.getGateReplays;
  assert.ok(gateBaseline && gateRemovedSlug && gateRestoredSlug);

  assert.equal(gateBaseline.kind, "baseline");
  assert.equal(gateBaseline.sha, OPENSTATUS_GET_GATE_SHA);
  assert.deepEqual(
    gateBaseline.projects.map((p) => p.projectId),
    ["packages/api/tsconfig.json", "packages/db/tsconfig.json"],
  );
  assert.ok(gateBaseline.totalSourceFiles > 0);
  assert.equal(gateBaseline.targetDiagnostics.length, 0);
  assert.equal(gateBaseline.allDiagnosticsCount, 0);
  assert.equal(gateBaseline.exitCode, 0);
  assert.equal(gateBaseline.explainAtCheckpoints?.length, 2);

  const [wsExplain, gateExplain] = gateBaseline.explainAtCheckpoints;
  assert.ok(wsExplain && gateExplain);
  const wsLine = Number(wsExplain.at.split(":").at(-1));
  const gateLine = Number(gateExplain.at.split(":").at(-1));
  const wsCp = wsExplain.checkpoints.find(
    (cp) =>
      cp.name === "row-projection-satisfied" &&
      cp.outcome === "pass" &&
      cp.at?.line === wsLine,
  );
  assert.ok(
    wsCp,
    `Expected row-projection-satisfied checkpoint at ${wsExplain.at}`,
  );
  assert.deepEqual(
    (wsCp.detail as { readonly relationName?: string }).relationName,
    "workspace",
  );
  assert.deepEqual(
    (wsCp.detail as { readonly schemaName?: string }).schemaName,
    "selectWorkspaceSchema",
  );

  const gateCp = gateExplain.checkpoints.find(
    (cp) =>
      cp.name === "row-projection-satisfied" &&
      cp.outcome === "pass" &&
      cp.at?.line === gateLine,
  );
  assert.ok(
    gateCp,
    `Expected row-projection-satisfied checkpoint at ${gateExplain.at}`,
  );
  assert.deepEqual(
    (gateCp.detail as { readonly schemaName?: string }).schemaName,
    "gateFieldsSchema",
  );
  assert.deepEqual(
    (gateCp.detail as { readonly requiredFields?: readonly string[] })
      .requiredFields,
    ["contactUrl", "customDomain", "homepageUrl", "slug"],
  );

  assert.equal(gateRemovedSlug.kind, "manual-edit");
  assert.equal(gateRemovedSlug.sha, OPENSTATUS_GET_GATE_SHA);
  assert.equal(gateRemovedSlug.targetDiagnostics.length, 1);
  assert.equal(gateRemovedSlug.allDiagnosticsCount, 1);
  assert.equal(gateRemovedSlug.exitCode, 1);
  const removedSlugDiag = gateRemovedSlug.targetDiagnostics[0]!;
  assert.equal(removedSlugDiag.at.file, OPENSTATUS_GET_GATE_FILE);
  assert.match(removedSlugDiag.message, /gateFieldsSchema/u);
  assert.match(removedSlugDiag.message, /\bslug\b/u);
  assert.doesNotMatch(removedSlugDiag.message, /selectWorkspaceSchema/u);
  assert.ok(
    removedSlugDiag.evidence.some(
      (ev) => ev.at?.file === "packages/db/src/schema/pages/validation.ts",
    ),
    `Expected cross-package selectPageSchema evidence in ${JSON.stringify(removedSlugDiag.evidence)}`,
  );
  assert.ok(
    removedSlugDiag.evidence.some(
      (ev) => ev.at?.file === "packages/db/src/schema/pages/page.ts",
    ),
    `Expected page table evidence in ${JSON.stringify(removedSlugDiag.evidence)}`,
  );

  assert.equal(gateRestoredSlug.kind, "manual-edit");
  assert.equal(gateRestoredSlug.sha, OPENSTATUS_GET_GATE_SHA);
  assert.equal(gateRestoredSlug.targetDiagnostics.length, 0);
  assert.equal(gateRestoredSlug.allDiagnosticsCount, 0);
  assert.equal(gateRestoredSlug.exitCode, 0);

  console.info(JSON.stringify(result, null, 2));
});
