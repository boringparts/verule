import assert from "node:assert/strict";
import { it } from "node:test";

import { getEngineVersion } from "@boringparts/verule";

void it("returns the version reported by the packaged engine", async () => {
  assert.equal(process.versions.node, "24.0.0");
  assert.match(await getEngineVersion(), /^\d+\.\d+\.\d+(?:[-+][\w.+-]+)?$/u);
});
