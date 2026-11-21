import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { prepareCheckout, revision } from "../scripts/checkout.ts";
import { compareTools } from "../scripts/compare.ts";
import { measureProject } from "../scripts/measure.ts";

void test("pinned CLI contracts agree with upstream behavior and independently reopened projects", async (t) => {
  const checkout = mkdtempSync(join(tmpdir(), "verule-replay-"));
  t.after(() => rmSync(checkout, { recursive: true, force: true }));
  const library = prepareCheckout(checkout);
  const file = join(library, "src/cli-execution.ts");
  const original = readFileSync(file, "utf8");
  function upstream() {
    const build = spawnSync(
      "pnpm",
      ["exec", "tsc", "-p", "tsconfig.build.json"],
      { cwd: library, encoding: "utf8" },
    );
    assert.equal(build.status, 0, build.stderr + build.stdout);
    // A nested Node test runner would otherwise inherit the parent's IPC reporter.
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(
      process.execPath,
      [
        "--test",
        "--test-reporter=spec",
        "--test-name-pattern=value option 经模式变换",
        "test/data-command.test.ts",
      ],
      { cwd: library, encoding: "utf8", env },
    );
  }
  let output = upstream();
  assert.equal(output.status, 0, output.stdout + output.stderr);
  assert.match(output.stdout, /value option 经模式变换/u);
  writeFileSync(
    file,
    original.replace(
      "        validation.value,",
      "        options.invocation.input,",
    ),
  );
  try {
    output = upstream();
    assert.equal(output.status, 1, output.stdout + output.stderr);
    assert.match(output.stdout, /Ada/u);
    assert.match(output.stdout, /ADA/u);
  } finally {
    writeFileSync(file, original);
  }
  output = upstream();
  assert.equal(output.status, 0, output.stdout + output.stderr);

  const rounds = await compareTools(library);
  const engine = measureProject(library);
  const edits = rounds.slice(1);
  const p95 = (samples: number[]) =>
    samples.toSorted((a, b) => a - b)[Math.ceil(samples.length * 0.95) - 1];
  const cli = {
    editSamples: edits.length,
    watchEditP95Ms: p95(edits.map((row) => row.watchMs)),
    freshCheckEditP95Ms: p95(edits.map((row) => row.checkMs)),
    oxlintEditP95Ms: p95(edits.map((row) => row.oxlintMs)),
    maxBytes: Math.max(...rounds.map((row) => row.bytes)),
    wireSpanP95Ms: p95(rounds.map((row) => row.wireSpanMs)),
  };
  const results = { revision, engine, cli, rounds };
  if (process.env.VERULE_REPLAY_OUTPUT)
    writeFileSync(
      process.env.VERULE_REPLAY_OUTPUT,
      JSON.stringify(results, null, 2) + "\n",
    );
  t.diagnostic(
    `Compared ${rounds.length} CLI reports and ${engine.matchedReportPairs} in-process report pairs on ${revision}.`,
  );
});
