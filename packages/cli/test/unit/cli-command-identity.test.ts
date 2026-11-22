import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { cliCommandIdentity } from "../../src/cli-command-identity.ts";

void describe("CLI command identity", () => {
  void it("reads the command name from the manifest and marks missing versions as unpublished", () => {
    assert.deepStrictEqual(
      cliCommandIdentity({ bin: { release: "./dist/cli.js" } }),
      { commandName: "release", version: "unpublished" },
    );
    assert.deepStrictEqual(
      cliCommandIdentity({ bin: { ship: "./dist/cli.js" }, version: "2.3.4" }),
      { commandName: "ship", version: "2.3.4" },
    );
  });

  void it("rejects manifests without a single command entry", () => {
    assert.throws(
      () => cliCommandIdentity({ bin: {} }),
      /exactly one command/u,
    );
    assert.throws(
      () =>
        cliCommandIdentity({
          bin: { release: "./dist/cli.js", ship: "./dist/cli.js" },
        }),
      /exactly one command/u,
    );
  });
});
