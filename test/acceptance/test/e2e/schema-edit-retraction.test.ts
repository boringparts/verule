import assert from "node:assert/strict";
import { test } from "node:test";

import { withAcceptanceHost } from "@verule/acceptance";

const configPath = "packages/app/verule.drizzle-zod.native.config.ts";
const schemaPath = "packages/data/src/drizzle-schema.ts";

void test("edits schema in an isolated host, waits for watch report, and verifies diagnostic retraction", async () => {
  await withAcceptanceHost(
    {
      overlay: "drizzle-zod",
      additionalPackages: [
        "@verule/adapter-drizzle",
        "@verule/adapter-zod",
        "@verule/rules-reference",
      ],
    },
    async (host) => {
      host.replaceText(
        schemaPath,
        "  age: z.number().default(18),\n",
        "  age: z.number(),\n",
      );

      const watch = await host.startWatch({ config: configPath });
      const initial = await watch.nextReport();
      assert.equal(initial.status, "findings");
      assert.equal(initial.diagnostics.length, 1);
      assert.equal(
        initial.diagnostics[0]?.ruleId,
        "row-projection-satisfies-validator",
      );
      assert.match(initial.diagnostics[0]?.message ?? "", /\bage\b/u);

      host.replaceText(
        schemaPath,
        "  age: z.number(),\n",
        "  age: z.number().default(18),\n",
      );

      const updated = await watch.nextReport();
      assert.equal(updated.status, "clean");
      assert.deepEqual(updated.diagnostics, []);

      const cold = await host.check({ config: configPath });
      assert.equal(cold.status, 0);
      assert.deepEqual(updated.diagnostics, cold.report.diagnostics);
      assert.deepEqual(updated.identity, cold.report.identity);
    },
  );
});
