import assert from "node:assert/strict";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };

void test("treats a closed stdout pipe as a normal exit", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity,
    argv: ["node", "verule", "--version"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw Object.assign(new Error("closed"), { code: "EPIPE" });
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(destinations, ["stdout"]);
});

void test("returns an execution failure even when its diagnostic cannot be written", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity,
    argv: ["node", "verule", "--version"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw new Error("write failed");
    },
  });
  assert.equal(status, 2);
  assert.deepEqual(destinations, ["stdout", "stderr"]);
});

void test("does not retry a failed stderr write", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity,
    argv: ["node", "verule", "--unknown"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw Object.assign(new Error("closed"), { code: "EPIPE" });
    },
  });
  assert.equal(status, 2);
  assert.deepEqual(destinations, ["stderr"]);
});
