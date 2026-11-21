import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { project } from "./project.ts";

const bin = fileURLToPath(new URL("../dist/cli.js", import.meta.url));

void test(
  "watch replaces full reports and reloads transitive imports after failed revisions",
  { timeout: 45_000 },
  async (t) => {
    const cwd = await project(t);
    const child = spawn(
      process.execPath,
      [bin, "watch", "--output", "ndjson"],
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
    const record = async () => {
      const line = await lines.next();
      assert.equal(line.done, false, stderr);
      return JSON.parse(line.value!);
    };
    assert.equal((await record()).kind, "stream");
    const first = await record();
    assert.equal(first.variant, "report", JSON.stringify(first));
    assert.equal(first.data.diagnostics.length, 2);
    await writeFile(
      join(cwd, "app.ts"),
      "export function publish() {}\npublish();\n",
    );
    const second = await record();
    assert.equal(second.data.diagnostics.length, 1, JSON.stringify(second));
    assert.equal(second.data.diagnostics[0].id, first.data.diagnostics[0].id);
    await writeFile(join(cwd, "app.ts"), "export function publish() {}\n");
    const third = await record();
    assert.deepEqual(third.data.diagnostics, []);
    assert.notEqual(second.data.version, third.data.version);
    await writeFile(
      join(cwd, "rules.ts"),
      'export {rules} from "./policy.ts";',
    );
    const missing = await record();
    assert.equal(missing.variant, "failed", JSON.stringify(missing));
    assert.match(missing.data.message, /policy\.ts/);
    assert.equal(missing.data.diagnostics, undefined);
    await writeFile(
      join(cwd, "policy.ts"),
      'export const rules=[{id:"policy",run(){throw new Error("Policy failed")}}];',
    );
    const thrown = await record();
    assert.equal(thrown.variant, "failed", JSON.stringify(thrown));
    assert.match(thrown.data.message, /Policy failed/);
    await writeFile(
      join(cwd, "policy.ts"),
      'export const rules=[{id:"policy",run(q){q.symbol({file:"app.ts",name:"missing"})}}];',
    );
    const recovered = await record();
    assert.equal(recovered.variant, "report", JSON.stringify(recovered));
    assert.deepEqual(recovered.data.diagnostics, []);
    assert.equal(recovered.data.gaps.length, 1);
    assert.equal(
      new Set(
        [first, second, third, missing, thrown, recovered].map(
          (item) => item.data.version,
        ),
      ).size,
      6,
    );
    await writeFile(
      join(cwd, "policy.ts"),
      [
        "let saved;",
        'export const rules=[{id:"saved",run(q){',
        '  saved ??= q.symbol({file:"app.ts",name:"publish"}).value;',
        '  q.report({at:saved,message:"A declaration."});',
        "}}];",
      ].join("\n"),
    );
    assert.equal((await record()).data.diagnostics.length, 1);
    await writeFile(join(cwd, "app.ts"), "export const renamed = 1;\n");
    const stale = await record();
    assert.equal(stale.variant, "failed", JSON.stringify(stale));
    assert.match(stale.data.message, /snapshot/iu);
    child.kill("SIGTERM");
    assert.equal((await record()).kind, "streamSuccess");
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(stderr, "");
  },
);

void test(
  "text watch discovers new project files and retracts their diagnostics on deletion",
  { timeout: 30_000 },
  async (t) => {
    const cwd = await project(t);
    await writeFile(
      join(cwd, "tsconfig.json"),
      '{"include":["app.ts","new.ts"]}',
    );
    await writeFile(join(cwd, "app.ts"), "export function publish() {}\n");
    const child = spawn(process.execPath, [bin, "watch"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
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
    assert.match((await lines.next()).value ?? "", /0 diagnostics, 0 gaps/);
    await writeFile(
      join(cwd, "new.ts"),
      'import { publish } from "./app";\npublish();\n',
    );
    assert.match((await lines.next()).value ?? "", /1 diagnostics?, 0 gaps/);
    assert.match((await lines.next()).value ?? "", /new\.ts:2:1.*no-publish/);
    assert.match((await lines.next()).value ?? "", /source.*new\.ts:2:1/);
    await unlink(join(cwd, "new.ts"));
    assert.match((await lines.next()).value ?? "", /0 diagnostics, 0 gaps/);
    child.kill("SIGTERM");
    assert.equal((await exited)[0], 0, stderr);
    assert.equal(stderr, "");
  },
);
