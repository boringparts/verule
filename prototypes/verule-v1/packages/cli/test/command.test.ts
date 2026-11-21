import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { cliArgs, project } from "./project.ts";

void test("check reports violations, line-specific exceptions, gaps, and execution failures on the contracted channels", async (t) => {
  const cwd = await project(t);
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [...cliArgs, "check", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 20_000,
    });
  const first = run();
  assert.equal(first.status, 1, first.stderr);
  assert.match(first.stdout, /2 diagnostics, 0 gaps/);
  assert.match(first.stdout, /app\.ts:2:1.*no-publish/u);
  assert.equal(first.stderr, "");

  await writeFile(
    join(cwd, "app.ts"),
    "export function publish() {}\n// verule-ignore-next-line no-publish -- accepted\npublish();\n",
  );
  const clean = run("--output", "json");
  assert.equal(clean.status, 0, clean.stderr);
  assert.equal(clean.stderr, "");
  assert.deepEqual(JSON.parse(clean.stdout).data.diagnostics, []);

  await writeFile(
    join(cwd, "rules.ts"),
    `export const rules = [
    { id: "no-publish", run(q) {
      const fn = q.symbol({file:"app.ts", name:"publish"}).value;
      q.report({at:q.calls(fn)[0], message:"Ignored"});
    }},
    { id: "audit", run(q) {
      const fn = q.symbol({file:"app.ts", name:"publish"}).value;
      q.report({at:fn, message:"Audit declaration", evidence:[q.evidence(q.calls(fn)[0], "Ignored site still supplies evidence")]});
      q.symbol({file:"app.ts",name:"missing"});
    }}
  ];`,
  );
  const findings = run("--config", "verule.config.ts", "--output", "json");
  assert.equal(findings.status, 1, findings.stderr);
  assert.equal(findings.stderr, "");
  const report = JSON.parse(findings.stdout).data;
  assert.equal(report.diagnostics.length, 1);
  assert.equal(report.diagnostics[0].rule, "audit");
  assert.equal(report.diagnostics[0].evidence[0].at.line, 3);
  assert.equal(report.gaps.length, 1);

  await writeFile(
    join(cwd, "rules.ts"),
    'export const rules=[{id:"oops",run(){throw new Error("Rule is broken")}}]',
  );
  const failed = run("--output", "json");
  assert.equal(failed.status, 2, failed.stderr);
  assert.equal(failed.stdout, "");
  assert.equal(JSON.parse(failed.stderr).data.message, "Rule is broken");

  await writeFile(
    join(cwd, "rules.ts"),
    'export const rules=[{id:"late",async run(q){await Promise.resolve();q.symbol({file:"app.ts",name:"publish"})}}]',
  );
  const asynchronous = run("--output", "json");
  assert.equal(asynchronous.status, 2, asynchronous.stderr);
  assert.equal(asynchronous.stdout, "");
  assert.match(JSON.parse(asynchronous.stderr).data.message, /synchronously/);

  const usage = run("--bad-option");
  assert.equal(usage.status, 2);
  assert.equal(usage.stdout, "");
  assert.match(usage.stderr, /bad-option/);
});
