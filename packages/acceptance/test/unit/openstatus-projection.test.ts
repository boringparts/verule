import assert from "node:assert/strict";
import { test } from "node:test";

import {
  applyGetGateManualColumnEdit,
  findLineContaining,
  OPENSTATUS_GET_GATE_PROJECTS,
  OPENSTATUS_GET_GATE_STEPS,
  OPENSTATUS_WHOAMI_PROJECTS,
  OPENSTATUS_WHOAMI_STEPS,
  parseCliCheckJson,
  renderOpenStatusVeruleConfig,
} from "@verule/acceptance";

void test("renders OpenStatus verule.config.mjs loading adapters and reference rule from public exports", () => {
  const whoamiConfig = renderOpenStatusVeruleConfig(OPENSTATUS_WHOAMI_PROJECTS);
  assert.match(whoamiConfig, /from "@verule\/sdk"/u);
  assert.match(whoamiConfig, /from "@verule\/adapter-drizzle"/u);
  assert.match(whoamiConfig, /from "@verule\/adapter-zod"/u);
  assert.match(whoamiConfig, /from "@verule\/rules-reference"/u);
  assert.match(whoamiConfig, /"apps\/server\/tsconfig\.json"/u);
  assert.match(whoamiConfig, /"packages\/db\/tsconfig\.json"/u);

  const getGateConfig = renderOpenStatusVeruleConfig(
    OPENSTATUS_GET_GATE_PROJECTS,
  );
  assert.match(getGateConfig, /"packages\/api\/tsconfig\.json"/u);
  assert.match(getGateConfig, /"packages\/db\/tsconfig\.json"/u);
});

void test("distinguishes upstream whoami commits from manual getGate edits in scenario metadata", () => {
  assert.equal(OPENSTATUS_WHOAMI_STEPS.length, 3);
  assert.equal(
    OPENSTATUS_WHOAMI_STEPS.every((step) => step.kind === "upstream-commit"),
    true,
  );
  assert.deepEqual(
    OPENSTATUS_WHOAMI_STEPS.map((step) => step.expectedMissingFields),
    [["slub", "workspaceId"], ["workspaceId"], []],
  );

  assert.equal(OPENSTATUS_GET_GATE_STEPS.length, 3);
  assert.equal(OPENSTATUS_GET_GATE_STEPS[0]!.kind, "baseline");
  assert.equal(OPENSTATUS_GET_GATE_STEPS[1]!.kind, "manual-edit");
  assert.equal(OPENSTATUS_GET_GATE_STEPS[2]!.kind, "manual-edit");
});

void test("applies and reverts the getGate manual slug column edit cleanly", () => {
  const sample = [
    "  getGate: publicProcedure",
    "    .query(async (opts) => {",
    "      const _page = await opts.ctx.db.query.page.findFirst({",
    "        columns: {",
    "          slug: true,",
    "          customDomain: true,",
    "        },",
    "      });",
    "      const ws = selectWorkspaceSchema.safeParse(_page.workspace);",
    "      const gate = gateFieldsSchema.parse(rest);",
    "      return { gate, ws };",
    "    }),",
    "",
  ].join("\n");

  const removed = applyGetGateManualColumnEdit(sample, "remove-slug");
  assert.equal(removed.includes("slug: true,"), false);
  assert.equal(removed.includes("customDomain: true,"), true);

  const restored = applyGetGateManualColumnEdit(removed, "restore-slug");
  assert.equal(restored, sample);

  assert.equal(
    findLineContaining(
      sample,
      "gateFieldsSchema.parse(rest)",
      "getGate: publicProcedure",
    ),
    10,
  );
});

void test("parses valid verule check JSON output and rejects malformed output", () => {
  const parsed = parseCliCheckJson(
    JSON.stringify({
      kind: "data",
      variant: "clean",
      data: {
        status: "clean",
        projects: [],
        fileOrigins: [],
        diagnostics: [],
        gaps: [],
      },
    }),
  );
  assert.equal(parsed.data.status, "clean");
  assert.throws(() => parseCliCheckJson("not json"));
  assert.throws(() => parseCliCheckJson(JSON.stringify({ kind: "error" })));
});
