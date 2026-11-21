import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import type { Report } from "@verule/sdk";

void test(
  "each saved revision matches a fresh CLI check, including source locations and unknowns",
  { timeout: 60_000 },
  async (t) => {
    const cwd = await mkdtemp(
      fileURLToPath(new URL("../.edits-", import.meta.url)),
    );
    t.after(() => rm(cwd, { recursive: true, force: true }));
    await cp(new URL("../fixture/", import.meta.url), cwd, { recursive: true });
    const cli = fileURLToPath(import.meta.resolve("@verule/cli/bin"));
    const app = join(cwd, "app.ts");
    const noCommands = (await readFile(app, "utf8"))
      .split("\n")
      .filter((line) => !line.startsWith("register("))
      .join("\n");
    await writeFile(app, noCommands);

    const child = spawn(
      process.execPath,
      [cli, "watch", "--output", "ndjson"],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
      stderr += chunk;
    });
    t.after(async () => {
      child.kill("SIGKILL");
      await exited;
    });
    const lines = createInterface({ input: child.stdout })[
      Symbol.asyncIterator
    ]();
    const header = await lines.next();
    assert.equal(header.done, false, stderr);
    assert.equal(JSON.parse(header.value!).kind, "stream");
    const versions = new Set<string>();
    async function verifiedRevision() {
      const line = await lines.next();
      assert.equal(line.done, false, stderr);
      const event = JSON.parse(line.value!) as {
        variant: string;
        data: Report;
      };
      assert.equal(event.variant, "report", line.value);
      assert.ok(!versions.has(event.data.version));
      versions.add(event.data.version);
      const reference = spawnSync(
        process.execPath,
        [cli, "check", "--output", "json"],
        { cwd, encoding: "utf8", timeout: 15_000 },
      );
      assert.equal(reference.stderr, "");
      assert.equal(
        reference.status,
        event.data.diagnostics.length ? 1 : 0,
        reference.stderr,
      );
      const { data: full } = JSON.parse(reference.stdout) as { data: Report };
      assert.deepEqual(event.data.diagnostics, full.diagnostics);
      assert.deepEqual(event.data.gaps, full.gaps);
      return event.data;
    }

    const empty = await verifiedRevision();
    assert.deepEqual(
      empty.diagnostics.map((d) => d.rule),
      ["orders/preview-id"],
    );
    const first = noCommands + '\nregister("draft");\n';
    await writeFile(app, first);
    const added = await verifiedRevision();
    assert.equal(
      added.diagnostics.filter((d) => d.rule === "commands/declared").length,
      1,
    );
    await writeFile(app, first + 'register("draft");\n');
    const repeated = await verifiedRevision();
    assert.equal(
      repeated.diagnostics.filter((d) => d.rule === "commands/duplicate")
        .length,
      1,
    );
    assert.equal(
      repeated.diagnostics.filter((d) => d.rule === "commands/declared").length,
      2,
    );

    const api = join(cwd, "api.ts");
    const declarations = await readFile(api, "utf8");
    await writeFile(api, declarations.replace('"build"', '"build" | "draft"'));
    const allowed = await verifiedRevision();
    assert.equal(allowed.diagnostics.length, 2);
    assert.equal(
      allowed.diagnostics.some((d) => d.rule === "commands/declared"),
      false,
    );
    const helper = join(cwd, "helpers.ts");
    await writeFile(helper, "\n\n" + (await readFile(helper, "utf8")));
    const moved = await verifiedRevision();
    const helperEvidence = (report: Report) =>
      report.diagnostics
        .find((d) => d.rule === "orders/preview-id")!
        .evidence.filter((e) => e.at.file === "helpers.ts");
    assert.ok(helperEvidence(allowed).length > 0);
    assert.deepEqual(
      helperEvidence(moved).map((e) => e.at.line),
      helperEvidence(allowed).map((e) => e.at.line + 2),
    );

    const config = join(cwd, "verule.config.ts");
    const modeled = await readFile(config, "utf8");
    await writeFile(
      config,
      modeled.replace(/models:\s*exampleModels/u, "models: []"),
    );
    const unmodeled = await verifiedRevision();
    assert.deepEqual(
      unmodeled.diagnostics.map((d) => d.rule),
      ["commands/duplicate"],
    );
    assert.ok(unmodeled.gaps.some((g) => g.rule === "orders/preview-id"));

    await writeFile(config, modeled);
    const restored = await verifiedRevision();
    assert.deepEqual(restored.diagnostics, moved.diagnostics);
    assert.deepEqual(restored.gaps, moved.gaps);
    child.kill("SIGTERM");
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(stderr, "");
  },
);
