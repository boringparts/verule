import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempDisposableSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

function createDeployedRequire(deploymentPath: string) {
  return createRequire(join(deploymentPath, "package.json"));
}

void test("runs the independently deployed CLI with its production SDK and engine", async (t) => {
  using deployment = mkdtempDisposableSync(join(tmpdir(), "verule-cli-"));
  execFileSync(
    "pnpm",
    [
      "--filter",
      "@verule/cli",
      "deploy",
      "--prod",
      "--frozen-lockfile",
      deployment.path,
    ],
    { cwd: new URL("../../", import.meta.url), stdio: "pipe" },
  );
  const deployed = createDeployedRequire(deployment.path);
  const manifest: { bin: { verule: string }; version: string } =
    deployed("./package.json");
  const deployedSdkEntry = deployed.resolve("@verule/sdk");
  assert.ok(deployedSdkEntry.startsWith(realpathSync(deployment.path) + sep));
  const sdk: typeof import("@verule/sdk") = deployed("@verule/sdk");
  const entry = join(deployment.path, manifest.bin.verule);

  function invoke(cwd: string, ...args: string[]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      cwd,
      encoding: "utf8",
      timeout: 15_000,
    });
    if (result.error) throw result.error;
    return result;
  }

  // Root command & contract discovery behavior
  const result = invoke(tmpdir());
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(
    result.stdout,
    `verule ${manifest.version} (engine ${await sdk.getEngineVersion()})\n`,
  );

  const version = invoke(tmpdir(), "--version");
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, `verule ${manifest.version}\n`);

  const help = invoke(tmpdir(), "--help");
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /--schema/u);
  assert.match(help.stdout, /check/u);

  const schema = invoke(tmpdir(), "--schema");
  assert.equal(schema.status, 0, schema.stderr);
  assert.partialDeepStrictEqual(JSON.parse(schema.stdout), {
    command: "verule",
  });

  const invalid = invoke(tmpdir(), "--unknown");
  assert.equal(invalid.status, 2);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /--unknown/u);

  // External temporary TS host project using the deployed @verule/sdk
  using host = mkdtempDisposableSync(join(tmpdir(), "verule-host-"));
  mkdirSync(join(host.path, "src"), { recursive: true });
  mkdirSync(join(host.path, "node_modules", "@verule"), { recursive: true });
  const deployedSdkPackageDir = dirname(dirname(deployedSdkEntry));
  symlinkSync(
    deployedSdkPackageDir,
    join(host.path, "node_modules", "@verule", "sdk"),
    "dir",
  );

  writeFileSync(
    join(host.path, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const hostSource = [
    "function sink(_mode: string, value: string | number): string {",
    "  return String(value);",
    "}",
    "",
    'export function processValue(input: string | number, mode: "fast" | "safe"): string {',
    '  if (typeof input === "string") {',
    '    const _label = "中文😀"; return sink(mode, input);',
    "  }",
    '  if (mode === "fast") {',
    "    return sink(mode, input);",
    "  }",
    "  return String(input);",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(host.path, "src", "handlers.ts"), hostSource, "utf8");

  // 1. Default zero rules
  writeFileSync(
    join(host.path, "verule.config.ts"),
    [
      'import { defineConfig } from "@verule/sdk";',
      'export default defineConfig({ tsconfig: "tsconfig.json" });',
      "",
    ].join("\n"),
    "utf8",
  );

  const cleanText = invoke(host.path, "check");
  assert.equal(cleanText.status, 0, cleanText.stderr);
  assert.match(cleanText.stdout, /No violations found/u);

  const cleanJson = invoke(host.path, "check", "--output", "json");
  assert.equal(cleanJson.status, 0, cleanJson.stderr);
  const cleanEnvelope = JSON.parse(cleanJson.stdout) as {
    kind: string;
    variant: string;
    data: {
      reportVersion: string;
      status: string;
      diagnostics: unknown[];
      observation?: unknown;
      metrics?: unknown;
    };
  };
  assert.equal(cleanEnvelope.kind, "data");
  assert.equal(cleanEnvelope.variant, "clean");
  assert.equal(cleanEnvelope.data.reportVersion, "1");
  assert.equal(cleanEnvelope.data.status, "clean");
  assert.deepEqual(cleanEnvelope.data.diagnostics, []);
  assert.equal("observation" in cleanEnvelope.data, false);
  assert.equal("metrics" in cleanEnvelope.data, false);

  // 2. Two rules sharing one session + cold check E2E timing + SDK/CLI parity
  const rulesConfigPath = join(host.path, "verule.rules.config.ts");
  writeFileSync(
    rulesConfigPath,
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      "",
      "const narrowedStringRule = defineRule({",
      '  id: "host-narrowed-string",',
      "  run: async (ctx) => {",
      '    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      '    const sinks = calls.filter((c) => c.text.startsWith("sink("));',
      "    const targets = sinks.map((c) => c.arguments?.[1]).filter((x) => x !== undefined);",
      "    if (targets.length === 0) return;",
      "    const types = await ctx.typeAt(targets);",
      "    for (const [i, ty] of types.entries()) {",
      '      if (ty.typeText === "string") {',
      "        ctx.report({",
      "          at: sinks[i]!.location,",
      '          message: "sink() received narrowed string",',
      '          findingKey: "narrowed-string",',
      '          evidence: [{ kind: "type", message: `Narrowed type: ${ty.typeText}`, at: sinks[i]!.location }],',
      "        });",
      "      }",
      "    }",
      "  },",
      "});",
      "",
      "const fastModeRule = defineRule({",
      '  id: "host-fast-mode",',
      "  run: async (ctx) => {",
      '    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      '    const sinks = calls.filter((c) => c.text.startsWith("sink("));',
      "    const targets = sinks.map((c) => c.arguments?.[0]).filter((x) => x !== undefined);",
      "    if (targets.length === 0) return;",
      "    const types = await ctx.typeAt(targets);",
      "    for (const [i, ty] of types.entries()) {",
      '      if (ty.isLiteral && ty.literalValue === "fast") {',
      "        ctx.report({",
      "          at: sinks[i]!.location,",
      '          message: "sink() called in fast mode",',
      '          findingKey: "fast-mode",',
      '          evidence: [{ kind: "type", message: `Literal mode: ${ty.typeText}`, at: sinks[i]!.location }],',
      "        });",
      "      }",
      "    }",
      "  },",
      "});",
      "",
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      "  rules: [narrowedStringRule, fastModeRule],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const coldStartMs = performance.now();
  const findingsJson = invoke(
    host.path,
    "check",
    "--config",
    rulesConfigPath,
    "--output",
    "json",
  );
  const coldDurationMs = performance.now() - coldStartMs;
  t.diagnostic(
    `Cold check E2E (deployed CLI + fresh engine + 2 rules): ${coldDurationMs.toFixed(2)} ms`,
  );

  assert.equal(findingsJson.status, 1, findingsJson.stderr);
  const findingsEnvelope = JSON.parse(findingsJson.stdout) as {
    kind: string;
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(findingsEnvelope.kind, "data");
  assert.equal(findingsEnvelope.variant, "findings");
  assert.equal(findingsEnvelope.data.diagnostics.length, 2);

  const findingsText = invoke(host.path, "check", "--config", rulesConfigPath);
  assert.equal(findingsText.status, 1);
  assert.match(findingsText.stdout, /host-narrowed-string/u);
  assert.match(findingsText.stdout, /host-fast-mode/u);

  const loadedConfigModule = (await import(
    pathToFileURL(rulesConfigPath).href
  )) as {
    default: import("@verule/sdk").VeruleConfig;
  };
  const sdkReport = await sdk.runCheck({
    cwd: host.path,
    config: loadedConfigModule.default,
  });
  assert.deepEqual(findingsEnvelope.data, sdkReport);

  // 2b. Single branchCoverage project rule covering bypass, joint coverage, unreachable, and unmodeled gaps
  using branchHost = mkdtempDisposableSync(join(tmpdir(), "verule-branch-host-"));
  mkdirSync(join(branchHost.path, "src"), { recursive: true });
  mkdirSync(join(branchHost.path, "node_modules", "@verule"), {
    recursive: true,
  });
  symlinkSync(
    deployedSdkPackageDir,
    join(branchHost.path, "node_modules", "@verule", "sdk"),
    "dir",
  );
  writeFileSync(
    join(branchHost.path, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );

  const routesSource = [
    "declare function hasApiKey(req: string): boolean;",
    "declare function hasSession(req: string): boolean;",
    "declare function verifyApiKey(req: string): void;",
    "declare function verifySession(req: string): void;",
    "declare function audit(req: string): void;",
    "declare function log(err: unknown): void;",
    "declare function runAction(req: string): void;",
    "",
    "export function bypassHandler(req: string): void {",
    "  if (hasApiKey(req)) {",
    "    audit(req);",
    "  }",
    "  runAction(req);",
    "}",
    "",
    "export function jointCoveredHandler(req: string): void {",
    "  if (hasApiKey(req)) {",
    "    verifyApiKey(req);",
    "  } else if (hasSession(req)) {",
    "    verifySession(req);",
    "  } else {",
    "    return;",
    "  }",
    "  runAction(req);",
    "}",
    "",
    "export function unreachableHandler(req: string): void {",
    "  if (hasApiKey(req)) {",
    "    verifyApiKey(req);",
    "  }",
    "  return;",
    "  runAction(req);",
    "}",
    "",
    "export function unmodeledHandler(req: string): void {",
    "  try {",
    "    if (hasApiKey(req)) {",
    "      runAction(req);",
    "    }",
    "  } catch (err) {",
    "    log(err);",
    "  }",
    "}",
    "",
  ].join("\n");
  writeFileSync(join(branchHost.path, "src", "routes.ts"), routesSource, "utf8");

  const branchRuleConfigPath = join(branchHost.path, "verule.config.ts");
  writeFileSync(
    branchRuleConfigPath,
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      "",
      "const guardRule = defineRule({",
      '  id: "host-auth-branch-coverage",',
      "  run: async (ctx) => {",
      '    const fns = (await ctx.findSyntax({ kinds: ["FunctionDeclaration"] })).filter(',
      '      (fn) => !fn.text.startsWith("declare "),',
      "    );",
      '    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "    const branchGroups = await ctx.listBranches(fns.map((fn) => fn.ref));",
      "",
      "    for (const [index, fn] of fns.entries()) {",
      "      const actionCalls = calls.filter(",
      "        (call) =>",
      '          call.text.startsWith("runAction(") &&',
      "          call.location.start >= fn.location.start &&",
      "          call.location.end <= fn.location.end,",
      "      );",
      "      if (actionCalls.length === 0) continue;",
      "",
      "      const guardBranches = branchGroups[index]!.branches",
      "        .filter(",
      "          (b) =>",
      '            b.kind === "if" &&',
      '            b.direction === "true" &&',
      '            (b.conditionText === "hasApiKey(req)" ||',
      '              b.conditionText === "hasSession(req)"),',
      "        )",
      "        .map((b) => b.ref);",
      "",
      "      const coverage = await ctx.branchCoverage({",
      "        function: fn.ref,",
      "        branches: guardBranches,",
      "        targets: actionCalls.map((call) => call.ref),",
      "      });",
      "",
      "      for (const [targetIdx, item] of coverage.entries()) {",
      "        const targetCall = actionCalls[targetIdx]!;",
      '        if (item.status === "bypass") {',
      "          ctx.report({",
      "            at: targetCall.location,",
      '            message: "runAction() can bypass required authorization branch.",',
      '            findingKey: "branch-bypass",',
      "            evidence: item.evidence,",
      "          });",
      '        } else if (item.status === "unreachable") {',
      "          ctx.report({",
      "            at: targetCall.location,",
      '            message: "runAction() is unreachable from function entry and cannot be verified as covered.",',
      '            findingKey: "branch-unreachable",',
      "            evidence: item.evidence,",
      "          });",
      "        }",
      "      }",
      "    }",
      "  },",
      "});",
      "",
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      "  rules: [guardRule],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const branchFindingsJson = invoke(
    branchHost.path,
    "check",
    "--output",
    "json",
  );
  assert.equal(branchFindingsJson.status, 1, branchFindingsJson.stderr);
  const branchEnvelope = JSON.parse(branchFindingsJson.stdout) as {
    kind: string;
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(branchEnvelope.kind, "data");
  assert.equal(branchEnvelope.variant, "findings");
  assert.equal(branchEnvelope.data.diagnostics.length, 2);
  assert.deepEqual(
    branchEnvelope.data.diagnostics.map((d) => ({
      line: d.at.line,
      message: d.message,
    })),
    [
      {
        line: 13,
        message: "runAction() can bypass required authorization branch.",
      },
      {
        line: 32,
        message:
          "runAction() is unreachable from function entry and cannot be verified as covered.",
      },
    ],
  );
  assert.ok(
    branchEnvelope.data.diagnostics[0]!.evidence.some((e) =>
      e.message.includes("false branch"),
    ),
  );
  assert.equal(branchEnvelope.data.gaps.length, 1);
  assert.equal(branchEnvelope.data.gaps[0]!.kind, "unmodeled-try-catch");
  assert.equal(branchEnvelope.data.gaps[0]!.at?.line, 36);

  const branchFindingsText = invoke(branchHost.path, "check");
  assert.equal(branchFindingsText.status, 1);
  assert.match(branchFindingsText.stdout, /host-auth-branch-coverage/u);
  assert.match(branchFindingsText.stdout, /gap \[unmodeled-try-catch\]/u);
  assert.match(branchFindingsText.stdout, /Found 2 violation\(s\) \(1 gap\(s\)\)/u);

  const branchLoadedConfig = (await import(
    pathToFileURL(branchRuleConfigPath).href
  )) as {
    default: import("@verule/sdk").VeruleConfig;
  };
  const branchSdkReport = await sdk.runCheck({
    cwd: branchHost.path,
    config: branchLoadedConfig.default,
  });
  assert.deepEqual(branchEnvelope.data, branchSdkReport);

  // Clean-with-gaps check: only covered + unmodeled try/catch -> exit 0 while still reporting gaps
  writeFileSync(
    join(branchHost.path, "src", "routes.ts"),
    [
      "declare function hasApiKey(req: string): boolean;",
      "declare function hasSession(req: string): boolean;",
      "declare function verifyApiKey(req: string): void;",
      "declare function verifySession(req: string): void;",
      "declare function log(err: unknown): void;",
      "declare function runAction(req: string): void;",
      "",
      "export function jointCoveredHandler(req: string): void {",
      "  if (hasApiKey(req)) {",
      "    verifyApiKey(req);",
      "  } else if (hasSession(req)) {",
      "    verifySession(req);",
      "  } else {",
      "    return;",
      "  }",
      "  runAction(req);",
      "}",
      "",
      "export function unmodeledHandler(req: string): void {",
      "  try {",
      "    if (hasApiKey(req)) {",
      "      runAction(req);",
      "    }",
      "  } catch (err) {",
      "    log(err);",
      "  }",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const cleanWithGapJson = invoke(branchHost.path, "check", "--output", "json");
  assert.equal(cleanWithGapJson.status, 0, cleanWithGapJson.stderr);
  const cleanWithGapEnvelope = JSON.parse(cleanWithGapJson.stdout) as {
    kind: string;
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(cleanWithGapEnvelope.variant, "clean");
  assert.equal(cleanWithGapEnvelope.data.diagnostics.length, 0);
  assert.equal(cleanWithGapEnvelope.data.gaps.length, 1);
  assert.equal(cleanWithGapEnvelope.data.gaps[0]!.kind, "unmodeled-try-catch");

  const cleanWithGapText = invoke(branchHost.path, "check");
  assert.equal(cleanWithGapText.status, 0, cleanWithGapText.stderr);
  assert.match(cleanWithGapText.stdout, /No violations found.*1 gap\(s\)/u);
  assert.match(cleanWithGapText.stdout, /gap \[unmodeled-try-catch\]/u);

  // 3. Failure paths -> exit 2 in text and json modes
  const missingConfig = invoke(
    host.path,
    "check",
    "--config",
    "does-not-exist.ts",
  );
  assert.equal(missingConfig.status, 2);
  assert.match(missingConfig.stderr, /Check failed/u);

  const throwingConfigPath = join(host.path, "verule.throwing.config.ts");
  writeFileSync(
    throwingConfigPath,
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      '  rules: [defineRule({ id: "fail-rule", run: () => { throw new Error("boom"); } })],',
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  const failedJson = invoke(
    host.path,
    "check",
    "--config",
    throwingConfigPath,
    "--output",
    "json",
  );
  assert.equal(failedJson.status, 2);
  const failedEnvelope = JSON.parse(failedJson.stderr) as {
    kind: string;
    variant: string;
    data: { code: string; message: string };
  };
  assert.equal(failedEnvelope.kind, "failure");
  assert.equal(failedEnvelope.variant, "failed");
  assert.equal(failedEnvelope.data.code, "RULE_EXECUTION_ERROR");

  // Broken tsconfig.json -> exit 2
  writeFileSync(join(host.path, "tsconfig.json"), "{ invalid json", "utf8");
  const brokenTsconfigJson = invoke(host.path, "check", "--output", "json");
  assert.equal(brokenTsconfigJson.status, 2);
  const brokenEnvelope = JSON.parse(brokenTsconfigJson.stderr) as {
    kind: string;
    variant: string;
    data: { code: string };
  };
  assert.equal(brokenEnvelope.kind, "failure");
  assert.equal(brokenEnvelope.variant, "failed");
  assert.equal(brokenEnvelope.data.code, "PROJECT_LOAD_ERROR");
});
