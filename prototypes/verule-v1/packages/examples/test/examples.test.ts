import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Report } from "@verule/sdk";

void test("consumer rules share registrations, retain evidence and distinguish killed values from gaps", (t) => {
  const cwd = mkdtempSync(join(process.cwd(), ".example-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  cpSync(new URL("../fixture/", import.meta.url), cwd, { recursive: true });
  const cli = fileURLToPath(import.meta.resolve("@verule/cli/bin"));
  const inspect = () => {
    const result = spawnSync(
      process.execPath,
      [cli, "check", "--output", "json"],
      { cwd, encoding: "utf8" },
    );
    assert.ok(result.status === 0 || result.status === 1, result.stderr);
    const { data } = JSON.parse(result.stdout) as { data: Report };
    assert.equal(result.status, data.diagnostics.length ? 1 : 0);
    return data;
  };
  const original = inspect();
  assert.deepEqual(
    original.diagnostics.map((d) => d.rule),
    ["commands/duplicate", "commands/declared", "orders/preview-id"],
  );
  assert.equal(original.gaps.length, 0);
  const preview = original.diagnostics.at(-1)!;
  assert.ok(preview.evidence.some((e) => e.at.file === "helpers.ts"));
  assert.ok(preview.evidence.some((e) => e.kind === "model"));
  assert.ok(preview.evidence.some((e) => e.kind === "approximation"));

  const app = join(cwd, "app.ts");
  writeFileSync(
    app,
    readFileSync(app, "utf8")
      .replace('register("serve");', "")
      .replace('register("oops");', 'register("build");'),
  );
  const afterRegistrations = inspect();
  assert.deepEqual(
    afterRegistrations.diagnostics.map((d) => d.id),
    [preview.id],
  );

  const helper = join(cwd, "helpers.ts");
  const forwarding = readFileSync(helper, "utf8");
  writeFileSync(
    helper,
    forwarding.replace("return id;", "return id + '-copy';"),
  );
  assert.deepEqual(inspect().diagnostics, []);
  writeFileSync(helper, forwarding);
  // A conditional write can leave the old value intact. A direct caller in
  // another file can supply a preview ID to a sink inside the helper.
  const beforeConditional = readFileSync(app, "utf8");
  writeFileSync(
    helper,
    forwarding +
      '\nimport {submit} from "./api.ts";\nexport function send(id:string){ submit(id); }\n',
  );
  writeFileSync(
    app,
    beforeConditional +
      '\nimport {send} from "./helpers.ts";\nsend(preview());\nlet maybe=preview();\nMath.random()>0.5 && (maybe="live");\nsubmit(maybe);\nmaybe ??= "fallback";\nsubmit(maybe);\n',
  );
  const variants = inspect();
  const previewLocations = variants.diagnostics
    .filter((d) => d.rule === "orders/preview-id")
    .map((d) => d.at.file);
  assert.deepEqual(previewLocations, [
    "app.ts",
    "app.ts",
    "app.ts",
    "helpers.ts",
  ]);
  writeFileSync(app, beforeConditional);
  writeFileSync(helper, forwarding);
  const config = join(cwd, "verule.config.ts");
  writeFileSync(
    config,
    readFileSync(config, "utf8").replace(
      /models:\s*exampleModels/u,
      "models: []",
    ),
  );
  const withoutModel = inspect();
  assert.deepEqual(withoutModel.diagnostics, []);
  assert.ok(withoutModel.gaps.some((g) => g.rule === "orders/preview-id"));
});

void test("contract identity follows an invocation field written through a local alias", (t) => {
  const cwd = mkdtempSync(join(process.cwd(), ".contract-"));
  t.after(() => rmSync(cwd, { force: true, recursive: true }));
  mkdirSync(join(cwd, "src"));
  writeFileSync(
    join(cwd, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { strict: true }, include: ["src"] }),
  );
  writeFileSync(
    join(cwd, "verule.config.ts"),
    'import {contractIdentity,contractModels} from "@verule/examples"; export default {tsconfig:"tsconfig.json",rules:[contractIdentity],models:contractModels};',
  );
  writeFileSync(
    join(cwd, "src/index.ts"),
    [
      "export declare function defineCli(): (options:object)=>object;",
      "export declare function parseCliInvocation(contract:object): object;",
      "export declare function executeCli(contract:object, options:{invocation:object}):void;",
    ].join("\n"),
  );
  const prefix = [
    'import {defineCli,parseCliInvocation,executeCli} from "./index";',
    "const first=defineCli()({}), second=defineCli()({});",
    "const options = {invocation:parseCliInvocation(first)};",
    "const alias=options;",
    "alias.invocation=parseCliInvocation(second);",
  ].join("\n");
  for (const [target, expected] of [
    ["second", 0],
    ["first", 1],
  ] as const) {
    writeFileSync(
      join(cwd, "src/use.ts"),
      prefix + `\nexecuteCli(${target},options);\n`,
    );
    const bin = fileURLToPath(import.meta.resolve("@verule/cli/bin"));
    const result = spawnSync(
      process.execPath,
      [bin, "check", "--output", "json"],
      { cwd, encoding: "utf8" },
    );
    assert.equal(result.status, expected, result.stderr);
    const { data } = JSON.parse(result.stdout) as { data: Report };
    assert.equal(data.diagnostics.length, expected);
    assert.deepEqual(data.gaps, []);
  }
});
