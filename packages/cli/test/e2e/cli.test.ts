import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
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
  assert.match(help.stdout, /watch/u);
  assert.match(help.stdout, /session/u);

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
  using branchHost = mkdtempDisposableSync(
    join(tmpdir(), "verule-branch-host-"),
  );
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
  writeFileSync(
    join(branchHost.path, "src", "routes.ts"),
    routesSource,
    "utf8",
  );

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
  assert.match(
    branchFindingsText.stdout,
    /Found 2 violation\(s\) \(1 gap\(s\)\)/u,
  );

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

  // 2c. Deployed CLI explain + observation overhead comparison & truncation
  const explainMarkerPath = join(host.path, "checkpoint-detail-marker.txt");
  const explainConfigPath = join(host.path, "verule.explain.config.ts");
  writeFileSync(
    explainConfigPath,
    [
      'import { appendFileSync } from "node:fs";',
      'import { defineConfig, defineRule } from "@verule/sdk";',
      `const markerPath = ${JSON.stringify(explainMarkerPath)};`,
      "const explainableRule = defineRule({",
      '  id: "host-explainable-string",',
      "  run: async (ctx) => {",
      '    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      '    const sinks = calls.filter((c) => c.text.startsWith("sink("));',
      "    const targets = sinks.map((c) => c.arguments?.[1]).filter((x) => x !== undefined);",
      "    if (targets.length === 0) return;",
      "    const types = await ctx.typeAt(targets);",
      "    for (const [i, ty] of types.entries()) {",
      "      const call = sinks[i]!;",
      '      if (ty.typeText === "string") {',
      '        ctx.checkpoint("require-string-arg", call, "pass", () => {',
      '          appendFileSync(markerPath, "eval\\n");',
      "          return { actualType: ty.typeText };",
      "        });",
      "        ctx.report({",
      "          at: call.location,",
      '          message: "sink() received narrowed string",',
      '          findingKey: "narrowed-string",',
      "        });",
      "      } else {",
      '        ctx.checkpoint("require-string-arg", call, "exclude", () => {',
      '          appendFileSync(markerPath, "eval\\n");',
      '          return { actualType: ty.typeText, expected: "string" };',
      "        });",
      "      }",
      "    }",
      "  },",
      "});",
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      "  rules: [explainableRule],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const offStartMs = performance.now();
  const offExplainRes = invoke(
    host.path,
    "check",
    "--config",
    explainConfigPath,
    "--output",
    "json",
  );
  const offWallMs = performance.now() - offStartMs;
  assert.equal(offExplainRes.status, 1, offExplainRes.stderr);
  const offExplainEnv = JSON.parse(offExplainRes.stdout) as {
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal("observation" in offExplainEnv.data, false);
  assert.equal(existsSync(explainMarkerPath), false);

  const detailStartMs = performance.now();
  const detailExplainRes = invoke(
    host.path,
    "check",
    "--config",
    explainConfigPath,
    "--observe",
    "detail",
    "--output",
    "json",
  );
  const detailWallMs = performance.now() - detailStartMs;
  assert.equal(detailExplainRes.status, 1, detailExplainRes.stderr);
  const detailExplainEnv = JSON.parse(detailExplainRes.stdout) as {
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(existsSync(explainMarkerPath), true);
  assert.equal(detailExplainEnv.data.status, offExplainEnv.data.status);
  assert.deepEqual(
    detailExplainEnv.data.diagnostics,
    offExplainEnv.data.diagnostics,
  );
  assert.deepEqual(detailExplainEnv.data.gaps, offExplainEnv.data.gaps);
  assert.ok(detailExplainEnv.data.observation);
  assert.equal(detailExplainEnv.data.observation.mode, "detail");
  assert.ok(detailExplainEnv.data.observation.rpc.batches >= 2);
  assert.ok(detailExplainEnv.data.observation.rpc.bytesSent > 0);
  assert.ok(detailExplainEnv.data.observation.rpc.bytesReceived > 0);
  assert.ok(detailExplainEnv.data.observation.overhead.checkpointMs >= 0);
  assert.ok(detailExplainEnv.data.observation.overhead.encodeMs >= 0);
  assert.ok(detailExplainEnv.data.observation.overhead.writeMs >= 0);
  t.diagnostic(
    `Deployed CLI observe off=${offWallMs.toFixed(2)}ms vs detail=${detailWallMs.toFixed(2)}ms (checkpoint=${detailExplainEnv.data.observation.overhead.checkpointMs}ms, encode=${detailExplainEnv.data.observation.overhead.encodeMs}ms, write=${detailExplainEnv.data.observation.overhead.writeMs}ms)`,
  );

  // Truncation visibility with --observe-limit 1
  const truncatedRes = invoke(
    host.path,
    "check",
    "--config",
    explainConfigPath,
    "--observe",
    "detail",
    "--observe-limit",
    "1",
    "--output",
    "json",
  );
  assert.equal(truncatedRes.status, 1, truncatedRes.stderr);
  const truncatedEnv = JSON.parse(truncatedRes.stdout) as {
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(truncatedEnv.data.observation?.truncated, true);
  assert.ok((truncatedEnv.data.observation?.droppedCount ?? 0) >= 1);
  assert.equal(truncatedEnv.data.observation?.details?.length, 1);

  // Targeted explain for excluded location at line 10
  const explainedRes = invoke(
    host.path,
    "check",
    "--config",
    explainConfigPath,
    "--rule",
    "host-explainable-string",
    "--at",
    "src/handlers.ts:10:12",
    "--output",
    "json",
  );
  assert.equal(explainedRes.status, 1, explainedRes.stderr);
  const explainedEnv = JSON.parse(explainedRes.stdout) as {
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(explainedEnv.data.explanation?.status, "excluded_by_checkpoint");
  assert.equal(explainedEnv.data.explanation?.inCandidates, true);
  assert.equal(
    explainedEnv.data.explanation?.excludedByCheckpoint?.name,
    "require-string-arg",
  );

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

  // 4. Multi-project aggregate + divergent @runtime resolution + merged diagnostics via deployed CLI
  using multiHost = mkdtempDisposableSync(
    join(tmpdir(), "verule-multiproj-host-"),
  );
  mkdirSync(join(multiHost.path, "packages/shared"), { recursive: true });
  mkdirSync(join(multiHost.path, "packages/web/src"), { recursive: true });
  mkdirSync(join(multiHost.path, "packages/node/src"), { recursive: true });
  mkdirSync(join(multiHost.path, "node_modules/@verule"), { recursive: true });
  symlinkSync(
    deployedSdkPackageDir,
    join(multiHost.path, "node_modules/@verule/sdk"),
    "dir",
  );

  writeFileSync(
    join(multiHost.path, "packages/shared/shared.ts"),
    [
      'import { mode } from "@runtime";',
      "function sink(v: string): string { return v; }",
      "export const out = sink(mode);",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(multiHost.path, "packages/web/src/web.ts"),
    'export const mode = "web" as const;\n',
    "utf8",
  );
  writeFileSync(
    join(multiHost.path, "packages/node/src/node.ts"),
    'export const mode = "node" as const;\n',
    "utf8",
  );
  writeFileSync(
    join(multiHost.path, "packages/web/tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        baseUrl: ".",
        paths: { "@runtime": ["./src/web.ts"] },
      },
      include: ["src/**/*.ts", "../shared/shared.ts"],
    }),
    "utf8",
  );
  writeFileSync(
    join(multiHost.path, "packages/node/tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        composite: true,
        strict: false,
        allowJs: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        baseUrl: ".",
        paths: { "@runtime": ["./src/node.ts"] },
      },
      include: ["src/**/*.ts", "../shared/shared.ts"],
    }),
    "utf8",
  );
  writeFileSync(
    join(multiHost.path, "tsconfig.json"),
    JSON.stringify({
      files: [],
      references: [{ path: "./packages/web" }, { path: "./packages/node" }],
    }),
    "utf8",
  );

  const multiConfigPath = join(multiHost.path, "verule.config.ts");
  writeFileSync(
    multiConfigPath,
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      "  rules: [",
      "    defineRule({",
      '      id: "e2e-runtime-scope",',
      "      run: async (ctx) => {",
      '        const calls = await ctx.findSyntax({ files: ["packages/shared/shared.ts"], kinds: ["CallExpression"] });',
      '        for (const call of calls.filter((c) => c.text.startsWith("sink("))) {',
      "          const arg = call.arguments?.[0];",
      "          if (!arg) continue;",
      "          const [ty] = await ctx.typeAt([arg]);",
      "          if (!ty) continue;",
      "          ctx.report({",
      "            at: call.location,",
      "            message: `Runtime=${ty.typeText}`,",
      '            findingKey: "runtime-mode",',
      '            evidence: [{ kind: "type", message: `type=${ty.typeText}`, at: call.location }],',
      "          });",
      "          ctx.report({",
      "            at: call.location,",
      '            message: "Shared sink call",',
      '            findingKey: "shared-call",',
      '            evidence: [{ kind: "source", message: "shared", at: call.location }],',
      "          });",
      "        }",
      "      },",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const multiJson = invoke(multiHost.path, "check", "--output", "json");
  assert.equal(multiJson.status, 1, multiJson.stderr);
  const multiEnvelope = JSON.parse(multiJson.stdout) as {
    kind: string;
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(multiEnvelope.kind, "data");
  assert.equal(multiEnvelope.variant, "findings");
  assert.equal(multiEnvelope.data.projects.length, 3);
  assert.equal(multiEnvelope.data.diagnostics.length, 3);
  assert.deepEqual(
    multiEnvelope.data.diagnostics.find((d) => d.message === "Shared sink call")
      ?.projects,
    ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
  );

  const multiText = invoke(multiHost.path, "check");
  assert.equal(multiText.status, 1);
  assert.match(
    multiText.stdout,
    /tsconfig\.json -> packages\/web\/tsconfig\.json/u,
  );
  assert.match(
    multiText.stdout,
    /\[projects: packages\/node\/tsconfig\.json, packages\/web\/tsconfig\.json\]/u,
  );

  const multiConfigMod = (await import(
    pathToFileURL(multiConfigPath).href
  )) as {
    default: import("@verule/sdk").VeruleConfig;
  };
  const multiSdkReport = await sdk.runCheck({
    cwd: multiHost.path,
    config: multiConfigMod.default,
  });
  assert.deepEqual(multiEnvelope.data, multiSdkReport);

  // 4b. Deployed `verule check` on mixed TS -> JS -> TS (allowJs: true, checkJs: false) with JSDoc and dynamic gaps
  using mixedHost = mkdtempDisposableSync(join(tmpdir(), "verule-mixed-host-"));
  mkdirSync(join(mixedHost.path, "src"), { recursive: true });
  mkdirSync(join(mixedHost.path, "node_modules/@verule"), { recursive: true });
  symlinkSync(
    deployedSdkPackageDir,
    join(mixedHost.path, "node_modules/@verule/sdk"),
    "dir",
  );
  writeFileSync(
    join(mixedHost.path, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        allowJs: true,
        checkJs: false,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      files: ["src/entry.ts"],
    }),
    "utf8",
  );
  writeFileSync(
    join(mixedHost.path, "src/sink.ts"),
    'export function deliver(_mode: "alpha" | "beta", received: string): string {\n  return received;\n}\n',
    "utf8",
  );
  writeFileSync(
    join(mixedHost.path, "src/bridge.js"),
    [
      'import { deliver } from "./sink.js";',
      "/**",
      ' * @param {"alpha" | "beta"} mode',
      " * @param {string} payload",
      " */",
      "export function forwardBridge(mode, payload) {",
      "  return deliver(mode, payload);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(mixedHost.path, "src/entry.ts"),
    [
      'import { forwardBridge } from "./bridge.js";',
      'function makeOrigin(): string { return "origin"; }',
      "export function main(useDyn: boolean, cb: (x: string) => string): string {",
      "  const origin = makeOrigin();",
      '  const out = forwardBridge("alpha", origin);',
      "  if (useDyn) return cb(origin);",
      "  return out;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(mixedHost.path, "verule.config.ts"),
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      "const rule = defineRule({",
      '  id: "host-mixed-ts-js-flow",',
      "  run: async (ctx) => {",
      '    const calls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["CallExpression"] });',
      '    const forwardCall = calls.find((c) => c.text.startsWith("forwardBridge("));',
      '    const dynCall = calls.find((c) => c.text.startsWith("cb("));',
      "    if (forwardCall && dynCall) {",
      "      const resolved = await ctx.resolveCalls([forwardCall.ref, dynCall.ref], { select: { instantiatedParameterTypes: [0] } });",
      '      if (resolved[0]?.instantiatedParameterTypes[0]?.type.typeText !== "\\"alpha\\" | \\"beta\\"") {',
      '        throw new Error("Expected JSDoc union type from bridge.js");',
      "      }",
      "      await ctx.calleesOf([resolved[1]!.call!]);",
      "    }",
      '    const varDecls = await ctx.findSyntax({ files: ["src/entry.ts"], kinds: ["VariableDeclaration"] });',
      '    const originInit = varDecls.find((d) => d.text.startsWith("origin ="))?.initializer;',
      '    const outDecl = varDecls.find((d) => d.text.startsWith("out ="));',
      "    if (originInit && outDecl) {",
      "      const [outRes] = await ctx.resolveDeclarations([outDecl.ref]);",
      '      const prop = await ctx.valuePropagation({ propagation: "value", from: originInit, to: [outRes!.declaration!] });',
      "      if (prop.results[0]?.reachable) {",
      "        ctx.report({",
      "          at: outDecl.location,",
      '          message: "Origin propagates through JS bridge to TS sink",',
      "          evidence: prop.results[0].evidence,",
      "        });",
      "      }",
      "    }",
      "  },",
      "});",
      'export default defineConfig({ tsconfig: "tsconfig.json", rules: [rule] });',
      "",
    ].join("\n"),
    "utf8",
  );

  const mixedHostJson = invoke(mixedHost.path, "check", "--output", "json");
  assert.equal(mixedHostJson.status, 1, mixedHostJson.stderr);
  const mixedHostEnv = JSON.parse(mixedHostJson.stdout) as {
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(mixedHostEnv.variant, "findings");
  assert.equal(mixedHostEnv.data.diagnostics.length, 1);
  assert.ok(
    mixedHostEnv.data.diagnostics[0]!.evidence.some(
      (e) => e.at?.file === "src/bridge.js",
    ),
  );
  assert.ok(
    mixedHostEnv.data.diagnostics[0]!.evidence.some(
      (e) => e.at?.file === "src/sink.ts",
    ),
  );
  assert.equal(mixedHostEnv.data.gaps.length, 1);
  assert.equal(mixedHostEnv.data.gaps[0]!.kind, "dynamic-callee");
  assert.equal("observation" in mixedHostEnv.data, false);

  // 5. Deployed `verule watch --output ndjson` over real file edits, recovery, and SIGINT shutdown
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

  const watchChild = spawn(
    process.execPath,
    [entry, "watch", "--config", rulesConfigPath, "--output", "ndjson"],
    {
      cwd: host.path,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const watchRecords: Record<string, unknown>[] = [];
  let watchStderr = "";
  let watchBuffer = "";
  let recordWaiters: (() => void)[] = [];

  watchChild.stdout.setEncoding("utf8");
  watchChild.stdout.on("data", (chunk: string) => {
    watchBuffer += chunk;
    while (true) {
      const idx = watchBuffer.indexOf("\n");
      if (idx === -1) break;
      const line = watchBuffer.slice(0, idx).trim();
      watchBuffer = watchBuffer.slice(idx + 1);
      if (line.length > 0) {
        watchRecords.push(JSON.parse(line) as Record<string, unknown>);
        const pending = recordWaiters;
        recordWaiters = [];
        for (const wake of pending) wake();
      }
    }
  });
  watchChild.stderr.setEncoding("utf8");
  watchChild.stderr.on("data", (chunk: string) => {
    watchStderr += chunk;
  });

  async function waitForWatchRecord(
    predicate: (item: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 10_000;
    let cursor = 0;
    while (true) {
      while (cursor < watchRecords.length) {
        const item = watchRecords[cursor]!;
        cursor += 1;
        if (predicate(item)) return item;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for deployed watch record. Records=${JSON.stringify(watchRecords)} stderr=${watchStderr}`,
        );
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 200);
        recordWaiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }

  try {
    await waitForWatchRecord((r) => r.kind === "stream");
    const rec1 = await waitForWatchRecord(
      (r) =>
        r.kind === "record" &&
        r.variant === "report" &&
        (r.data as { sequence?: number }).sequence === 1,
    );
    const rec1Data = rec1.data as Record<string, unknown>;
    assert.equal(rec1Data.status, "findings");

    // Edit src/handlers.ts to clean state -> watch emits clean report matching cold check
    const handlersPath = join(host.path, "src", "handlers.ts");
    writeFileSync(
      handlersPath,
      "export function safeOnly(): string {\n  return 'ok';\n}\n",
      "utf8",
    );
    const rec2 = await waitForWatchRecord(
      (r) =>
        r.kind === "record" &&
        r.variant === "report" &&
        (r.data as { sequence?: number }).sequence === 2,
    );
    const rec2Data = rec2.data as Record<string, unknown>;
    assert.equal(rec2Data.status, "clean");
    const coldClean = invoke(
      host.path,
      "check",
      "--config",
      rulesConfigPath,
      "--output",
      "json",
    );
    assert.equal(coldClean.status, 0, coldClean.stderr);
    const coldCleanData = (
      JSON.parse(coldClean.stdout) as { data: Record<string, unknown> }
    ).data;
    assert.deepEqual(rec2Data.diagnostics, coldCleanData.diagnostics);
    assert.deepEqual(rec2Data.identity, coldCleanData.identity);

    // Break config temporarily -> failed record without exit, then restore -> recovers
    const validRulesConfig = readFileSync(rulesConfigPath, "utf8");
    writeFileSync(rulesConfigPath, "export default { broken(", "utf8");
    const rec3 = await waitForWatchRecord(
      (r) =>
        r.kind === "record" &&
        r.variant === "failed" &&
        (r.data as { sequence?: number }).sequence === 3,
    );
    assert.equal((rec3.data as { code?: string }).code, "INVALID_CONFIG");

    writeFileSync(rulesConfigPath, validRulesConfig, "utf8");
    const rec4 = await waitForWatchRecord(
      (r) =>
        r.kind === "record" &&
        r.variant === "report" &&
        (r.data as { sequence?: number }).sequence === 4,
    );
    assert.equal((rec4.data as { status?: string }).status, "clean");

    // SIGINT triggers clean shutdown with streamSuccess and exit code 0
    watchChild.kill("SIGINT");
    const exitResult = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      watchChild.once("exit", (code, sig) =>
        resolveExit({ code, signal: sig }),
      );
    });
    assert.equal(exitResult.code, 0, watchStderr);
    assert.equal(watchStderr, "");
    assert.equal(watchRecords.at(-1)?.kind, "streamSuccess");
  } finally {
    if (watchChild.exitCode === null && watchChild.signalCode === null) {
      watchChild.kill("SIGKILL");
    }
  }

  // 6. Deployed `verule session` + cross-process `verule check --session <socketPath>`
  using sessionSocketDir = mkdtempDisposableSync(
    join(tmpdir(), "verule-e2e-sock-"),
  );
  const sharedSocketPath = join(sessionSocketDir.path, "verule.sock");
  const sessionChild = spawn(
    process.execPath,
    [
      entry,
      "session",
      "--config",
      rulesConfigPath,
      "--socket",
      sharedSocketPath,
      "--output",
      "ndjson",
    ],
    {
      cwd: host.path,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const sessionRecords: Record<string, unknown>[] = [];
  let sessionStderr = "";
  let sessionBuffer = "";
  let sessionWaiters: (() => void)[] = [];

  sessionChild.stdout.setEncoding("utf8");
  sessionChild.stdout.on("data", (chunk: string) => {
    sessionBuffer += chunk;
    while (true) {
      const idx = sessionBuffer.indexOf("\n");
      if (idx === -1) break;
      const line = sessionBuffer.slice(0, idx).trim();
      sessionBuffer = sessionBuffer.slice(idx + 1);
      if (line.length > 0) {
        sessionRecords.push(JSON.parse(line) as Record<string, unknown>);
        const pending = sessionWaiters;
        sessionWaiters = [];
        for (const wake of pending) wake();
      }
    }
  });
  sessionChild.stderr.setEncoding("utf8");
  sessionChild.stderr.on("data", (chunk: string) => {
    sessionStderr += chunk;
  });

  async function waitForSessionRecord(
    predicate: (item: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 10_000;
    let cursor = 0;
    while (true) {
      while (cursor < sessionRecords.length) {
        const item = sessionRecords[cursor]!;
        cursor += 1;
        if (predicate(item)) return item;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for deployed session record. Records=${JSON.stringify(sessionRecords)} stderr=${sessionStderr}`,
        );
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 100);
        sessionWaiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }

  function invokeAndCompareShared(label: string, expectedStatus: 0 | 1) {
    const t0 = performance.now();
    const sharedRes = invoke(
      tmpdir(),
      "check",
      "--session",
      sharedSocketPath,
      "--output",
      "json",
    );
    const sharedMs = performance.now() - t0;
    t.diagnostic(
      `Deployed cross-process check --session (${label}): ${sharedMs.toFixed(2)} ms`,
    );
    assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);

    const coldRes = invoke(
      host.path,
      "check",
      "--config",
      rulesConfigPath,
      "--output",
      "json",
    );
    assert.equal(coldRes.status, expectedStatus, coldRes.stderr);

    const sharedData = (
      JSON.parse(sharedRes.stdout) as {
        data: import("@verule/sdk").CheckReport;
      }
    ).data;
    const coldData = (
      JSON.parse(coldRes.stdout) as { data: import("@verule/sdk").CheckReport }
    ).data;
    assert.deepEqual(sharedData, coldData);
    return sharedData;
  }

  try {
    await waitForSessionRecord((r) => r.kind === "stream");
    const readyRec = await waitForSessionRecord(
      (r) => r.kind === "record" && r.variant === "ready",
    );
    assert.equal(
      (readyRec.data as { endpoint?: string }).endpoint,
      sharedSocketPath,
    );
    assert.equal(existsSync(sharedSocketPath), true);

    // (2) Initial clean report via second process
    invokeAndCompareShared("initial-clean", 0);

    // (3) Introduce violation -> immediately query from second process (0ms sleep)
    const handlersPath = join(host.path, "src", "handlers.ts");
    writeFileSync(handlersPath, hostSource, "utf8");
    const findingsReport = invokeAndCompareShared("immediate-violation", 1);
    assert.equal(findingsReport.diagnostics.length, 2);

    // (4) Fix violation -> immediately query from second process (0ms sleep) -> retracted
    writeFileSync(
      handlersPath,
      "export function safeOnly(): string {\n  return 'ok';\n}\n",
      "utf8",
    );
    const cleanReport = invokeAndCompareShared("immediate-fix", 0);
    assert.equal(cleanReport.diagnostics.length, 0);

    // (5) Break config -> client gets exit 2 while session stays alive -> restore -> recovers
    const validRulesConfig = readFileSync(rulesConfigPath, "utf8");
    writeFileSync(rulesConfigPath, "export default { broken(", "utf8");
    const failedShared = invoke(
      tmpdir(),
      "check",
      "--session",
      sharedSocketPath,
      "--output",
      "json",
    );
    assert.equal(failedShared.status, 2);
    const failedEnv = JSON.parse(failedShared.stderr) as {
      kind: string;
      variant: string;
      data: { code: string };
    };
    assert.equal(failedEnv.kind, "failure");
    assert.equal(failedEnv.data.code, "INVALID_CONFIG");

    writeFileSync(rulesConfigPath, validRulesConfig, "utf8");
    invokeAndCompareShared("immediate-recover", 0);

    // (6) SIGINT closes session, cleans socket, and standalone check still matches
    sessionChild.kill("SIGINT");
    const sessionExit = await new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((resolveExit) => {
      sessionChild.once("exit", (code, sig) =>
        resolveExit({ code, signal: sig }),
      );
    });
    assert.equal(sessionExit.code, 0, sessionStderr);
    assert.equal(sessionStderr, "");
    assert.equal(sessionRecords.at(-1)?.kind, "streamSuccess");
    assert.equal(existsSync(sharedSocketPath), false);

    const postCloseStandalone = invoke(
      host.path,
      "check",
      "--config",
      rulesConfigPath,
      "--output",
      "json",
    );
    assert.equal(postCloseStandalone.status, 0, postCloseStandalone.stderr);
  } finally {
    if (sessionChild.exitCode === null && sessionChild.signalCode === null) {
      sessionChild.kill("SIGKILL");
    }
  }

  // 7. Deployed CLI E2E for inline-ignore suppression, explain, unused exit 1, and ambiguity
  using inlineHost = mkdtempDisposableSync(
    join(tmpdir(), "verule-inline-ignore-host-"),
  );
  mkdirSync(join(inlineHost.path, "src"), { recursive: true });
  mkdirSync(join(inlineHost.path, "node_modules", "@verule"), {
    recursive: true,
  });
  symlinkSync(
    deployedSdkPackageDir,
    join(inlineHost.path, "node_modules", "@verule", "sdk"),
    "dir",
  );
  writeFileSync(
    join(inlineHost.path, "tsconfig.json"),
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
  writeFileSync(
    join(inlineHost.path, "verule.config.ts"),
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      "",
      "const noLegacyCall = defineRule({",
      '  id: "no-legacy-call",',
      "  run: async (ctx) => {",
      '    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "    for (const call of calls) {",
      '      if (call.text.startsWith("legacy(")) {',
      "        ctx.report({",
      "          at: call.location,",
      '          message: "legacy() is deprecated",',
      "        });",
      "      }",
      "    }",
      "  },",
      "});",
      "",
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      "  rules: [noLegacyCall],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  writeFileSync(
    join(inlineHost.path, "src", "entry.ts"),
    [
      "declare function legacy(id: string): void;",
      "",
      "export function run(): void {",
      "  // verule-ignore-next-code-line no-legacy-call -- Approved temporary bridge.",
      '  legacy("one");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );

  const inlineClean = invoke(inlineHost.path, "check", "--output", "json");
  assert.equal(inlineClean.status, 0, inlineClean.stderr);
  const inlineCleanEnv = JSON.parse(inlineClean.stdout) as {
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(inlineCleanEnv.variant, "clean");
  assert.deepEqual(inlineCleanEnv.data.diagnostics, []);

  const inlineExplain = invoke(
    inlineHost.path,
    "check",
    "--rule",
    "no-legacy-call",
    "--at",
    "src/entry.ts:5:3",
    "--output",
    "json",
  );
  assert.equal(inlineExplain.status, 0, inlineExplain.stderr);
  const inlineExplainEnv = JSON.parse(inlineExplain.stdout) as {
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(
    inlineExplainEnv.data.explanation?.status,
    "suppressed_by_ignore",
  );
  assert.equal(
    inlineExplainEnv.data.explanation?.inlineIgnore?.reason,
    "Approved temporary bridge.",
  );

  // Fix violation while keeping directive -> exit 1 with unused directive finding
  writeFileSync(
    join(inlineHost.path, "src", "entry.ts"),
    [
      "export function run(): number {",
      "  // verule-ignore-next-code-line no-legacy-call -- Approved temporary bridge.",
      "  return 0;",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const inlineUnused = invoke(inlineHost.path, "check", "--output", "json");
  assert.equal(inlineUnused.status, 1, inlineUnused.stderr);
  const inlineUnusedEnv = JSON.parse(inlineUnused.stdout) as {
    variant: string;
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(inlineUnusedEnv.variant, "findings");
  assert.equal(inlineUnusedEnv.data.diagnostics.length, 1);
  assert.equal(
    inlineUnusedEnv.data.diagnostics[0]?.ruleId,
    sdk.INLINE_IGNORE_RULE_ID,
  );

  // Two distinct calls on same line -> ambiguous diagnostic + both violations retained
  writeFileSync(
    join(inlineHost.path, "src", "entry.ts"),
    [
      "declare function legacy(id: string): number;",
      "",
      "export function run(): number {",
      "  // verule-ignore-next-code-line no-legacy-call -- Approved temporary bridge.",
      '  return legacy("a") + legacy("b");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const inlineAmbiguous = invoke(inlineHost.path, "check", "--output", "json");
  assert.equal(inlineAmbiguous.status, 1, inlineAmbiguous.stderr);
  const inlineAmbiguousEnv = JSON.parse(inlineAmbiguous.stdout) as {
    data: import("@verule/sdk").CheckReport;
  };
  assert.equal(
    inlineAmbiguousEnv.data.diagnostics.filter(
      (d) => d.ruleId === "no-legacy-call",
    ).length,
    2,
  );
  assert.equal(
    inlineAmbiguousEnv.data.diagnostics.filter(
      (d) => d.ruleId === sdk.INLINE_IGNORE_RULE_ID,
    ).length,
    1,
  );

  // 8. Deployed CLI additional inputs: only editing allowed-packages.json updates shared session immediately
  using manifestHost = mkdtempDisposableSync(
    join(tmpdir(), "verule-manifest-host-"),
  );
  using manifestSockDir = mkdtempDisposableSync(
    join(tmpdir(), "verule-manifest-sock-"),
  );
  const manifestSocketPath = join(manifestSockDir.path, "manifest.sock");
  mkdirSync(join(manifestHost.path, "src"), { recursive: true });
  mkdirSync(join(manifestHost.path, "node_modules", "@verule"), {
    recursive: true,
  });
  symlinkSync(
    deployedSdkPackageDir,
    join(manifestHost.path, "node_modules", "@verule", "sdk"),
    "dir",
  );
  writeFileSync(
    join(manifestHost.path, "tsconfig.json"),
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
  writeFileSync(
    join(manifestHost.path, "src", "app.ts"),
    [
      "declare function usePackage(name: string): void;",
      "export function run(): void {",
      '  usePackage("zod");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  const allowlistPath = join(manifestHost.path, "allowed-packages.json");
  writeFileSync(
    allowlistPath,
    JSON.stringify({ allowed: ["zod"] }, null, 2),
    "utf8",
  );
  const manifestConfigPath = join(manifestHost.path, "verule.config.ts");
  writeFileSync(
    manifestConfigPath,
    [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      `const absAllowlist = ${JSON.stringify(allowlistPath)};`,
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      '  additionalInputs: ["./allowed-packages.json"],',
      "  rules: [",
      "    defineRule({",
      '      id: "e2e-allowlist-reader",',
      "      run: async (ctx) => {",
      '        const parsed = JSON.parse(ctx.readAdditionalInput("allowed-packages.json")) as { allowed: string[] };',
      '        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "        for (const call of calls) {",
      '          if (!call.text.startsWith("usePackage(")) continue;',
      '          const m = /usePackage\\("([^"]+)"\\)/u.exec(call.text);',
      "          const pkg = m?.[1];",
      "          if (pkg !== undefined && !parsed.allowed.includes(pkg)) {",
      "            ctx.report({",
      "              at: call.location,",
      '              message: `Disallowed package "${pkg}"`,',
      "              findingKey: `pkg:${pkg}`,",
      '              evidence: [{ kind: "source", message: `Used ${pkg}`, at: call.location }],',
      "            });",
      "          }",
      "        }",
      "      },",
      "    }),",
      "    defineRule({",
      '      id: "e2e-allowlist-auditor",',
      "      run: (ctx) => {",
      "        ctx.registerAdditionalInput(absAllowlist);",
      "      },",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const manifestSessionChild = spawn(
    process.execPath,
    [
      entry,
      "session",
      "--config",
      manifestConfigPath,
      "--socket",
      manifestSocketPath,
      "--output",
      "ndjson",
    ],
    {
      cwd: manifestHost.path,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  const manifestSessionRecords: Record<string, unknown>[] = [];
  let manifestSessionBuf = "";
  let manifestSessionStderr = "";
  let manifestWaiters: (() => void)[] = [];
  manifestSessionChild.stdout.setEncoding("utf8");
  manifestSessionChild.stdout.on("data", (chunk: string) => {
    manifestSessionBuf += chunk;
    while (true) {
      const idx = manifestSessionBuf.indexOf("\n");
      if (idx === -1) break;
      const line = manifestSessionBuf.slice(0, idx).trim();
      manifestSessionBuf = manifestSessionBuf.slice(idx + 1);
      if (line.length > 0) {
        manifestSessionRecords.push(
          JSON.parse(line) as Record<string, unknown>,
        );
        const pending = manifestWaiters;
        manifestWaiters = [];
        for (const wake of pending) wake();
      }
    }
  });
  manifestSessionChild.stderr.setEncoding("utf8");
  manifestSessionChild.stderr.on("data", (chunk: string) => {
    manifestSessionStderr += chunk;
  });

  async function waitForManifestSessionRecord(
    predicate: (item: Record<string, unknown>) => boolean,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + 10_000;
    let cursor = 0;
    while (true) {
      while (cursor < manifestSessionRecords.length) {
        const item = manifestSessionRecords[cursor]!;
        cursor += 1;
        if (predicate(item)) return item;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Timed out waiting for manifest session record. Records=${JSON.stringify(manifestSessionRecords)} stderr=${manifestSessionStderr}`,
        );
      }
      await new Promise<void>((resolveWait) => {
        const timer = setTimeout(resolveWait, 100);
        manifestWaiters.push(() => {
          clearTimeout(timer);
          resolveWait();
        });
      });
    }
  }

  function compareManifestRound(expectedStatus: 0 | 1) {
    const sharedRes = invoke(
      tmpdir(),
      "check",
      "--session",
      manifestSocketPath,
      "--output",
      "json",
    );
    assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);
    const coldRes = invoke(
      manifestHost.path,
      "check",
      "--config",
      manifestConfigPath,
      "--output",
      "json",
    );
    assert.equal(coldRes.status, expectedStatus, coldRes.stderr);
    const sharedData = (
      JSON.parse(sharedRes.stdout) as {
        data: import("@verule/sdk").CheckReport;
      }
    ).data;
    const coldData = (
      JSON.parse(coldRes.stdout) as { data: import("@verule/sdk").CheckReport }
    ).data;
    assert.deepEqual(sharedData, coldData);
    assert.deepEqual(sharedData.projects[0]?.sourceFiles, ["src/app.ts"]);
    assert.deepEqual(
      sharedData.fileOrigins.map((o) => o.file),
      ["src/app.ts"],
    );
    assert.equal(sharedData.additionalInputs.length, 1);
    assert.deepEqual(sharedData.additionalInputs[0]?.sources, [
      { kind: "config" },
      { kind: "rule", id: "e2e-allowlist-auditor" },
      { kind: "rule", id: "e2e-allowlist-reader" },
    ]);
    return sharedData;
  }

  try {
    await waitForManifestSessionRecord(
      (r) => r.kind === "record" && r.variant === "ready",
    );
    compareManifestRound(0);

    // Edit only allowed-packages.json -> immediate query -> exit 1
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["lodash"] }, null, 2),
      "utf8",
    );
    const findingsRound = compareManifestRound(1);
    assert.equal(findingsRound.diagnostics.length, 1);

    // Restore only allowed-packages.json -> immediate query -> exit 0
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["zod"] }, null, 2),
      "utf8",
    );
    const cleanRound = compareManifestRound(0);
    assert.equal(cleanRound.diagnostics.length, 0);

    manifestSessionChild.kill("SIGINT");
    const exitRes = await new Promise<{ code: number | null }>(
      (resolveExit) => {
        manifestSessionChild.once("exit", (code) => resolveExit({ code }));
      },
    );
    assert.equal(exitRes.code, 0, manifestSessionStderr);
    assert.equal(existsSync(manifestSocketPath), false);
  } finally {
    if (
      manifestSessionChild.exitCode === null &&
      manifestSessionChild.signalCode === null
    ) {
      manifestSessionChild.kill("SIGKILL");
    }
  }

  // 8. Deployed CLI verification for third-party FactType, provider replacement, providerId filtering, partial merge, and order-independent FACT_CONFLICT
  using factHost = mkdtempDisposableSync(join(tmpdir(), "verule-fact-e2e-"));
  mkdirSync(join(factHost.path, "src"), { recursive: true });
  mkdirSync(join(factHost.path, "node_modules", "@verule"), {
    recursive: true,
  });
  symlinkSync(
    deployedSdkPackageDir,
    join(factHost.path, "node_modules", "@verule", "sdk"),
    "dir",
  );
  writeFileSync(
    join(factHost.path, "tsconfig.json"),
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
  writeFileSync(
    join(factHost.path, "src", "routes.ts"),
    [
      "declare function parseInput(schema: unknown, payload: unknown): unknown;",
      "const userSchema = {};",
      "export function handle(payload: unknown) {",
      "  return parseInput(userSchema, payload);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(factHost.path, "fact-contract.mjs"),
    [
      'import { defineFactType } from "@verule/sdk";',
      "export const InputSpecFact = defineFactType({",
      '  id: "e2e.validator.input-spec",',
      '  subjectKind: "call",',
      "  merge: (existing, incoming) => {",
      "    const fields = { ...existing.value.fields };",
      "    for (const [k, v] of Object.entries(incoming.value.fields)) {",
      "      if (!fields[k]) { fields[k] = v; continue; }",
      "      if (fields[k].requirement !== v.requirement) {",
      "        return {",
      "          ok: false,",
      "          conflict: {",
      '            message: `Conflicting requirement for "${k}": ${fields[k].requirement} vs ${v.requirement}`,',
      "            existingConclusion: `${k}=${fields[k].requirement}`,",
      "            incomingConclusion: `${k}=${v.requirement}`,",
      "            existingEvidence: fields[k].evidence ?? existing.evidence,",
      "            incomingEvidence: v.evidence ?? incoming.evidence,",
      "          },",
      "        };",
      "      }",
      "    }",
      "    const required = Object.keys(fields).filter((k) => fields[k].requirement === 'required').toSorted();",
      "    return { ok: true, value: { fields, required } };",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(factHost.path, "business-rule.mjs"),
    [
      'import { defineRule } from "@verule/sdk";',
      'import { InputSpecFact } from "./fact-contract.mjs";',
      "export const requireAgeRule = defineRule({",
      '  id: "e2e-require-age",',
      "  run: async (ctx) => {",
      "    const specs = await ctx.facts(InputSpecFact);",
      "    for (const spec of specs) {",
      '      if (!spec.value.required.includes("age")) {',
      "        const rows = await ctx.syntaxOf([spec.subject], { select: { location: true } });",
      "        const at = rows[0]?.location ?? spec.evidence[0]?.at;",
      "        if (!at) continue;",
      "        ctx.report({",
      "          at,",
      '          message: `Missing required field "age" [${spec.providers.join(", ")}]`,',
      '          findingKey: "missing-age",',
      "          evidence: spec.evidence,",
      "        });",
      "      }",
      "    }",
      "  },",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    join(factHost.path, "providers.mjs"),
    [
      'import { defineAdapter, defineFactProvider } from "@verule/sdk";',
      'import { InputSpecFact } from "./fact-contract.mjs";',
      "async function firstCall(ctx) {",
      '  const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "  const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));",
      "  return { call: resolved[0].call, at: calls[0].location };",
      "}",
      "export const providerA = defineAdapter({",
      '  id: "provider-a",',
      "  provides: [defineFactProvider(InputSpecFact, async (ctx) => {",
      "    const { call, at } = await firstCall(ctx);",
      '    return [{ subject: call, value: { fields: { id: { requirement: "required", evidence: [{ kind: "source", message: "provider-a id=required", at }] } }, required: ["id"] }, evidence: [{ kind: "source", message: "provider-a extracted id", at }], gaps: [{ kind: "dynamic-spread", message: "provider-a saw dynamic spread", at }] }];',
      "  })],",
      "});",
      "export const providerB = defineAdapter({",
      '  id: "provider-b",',
      "  provides: [defineFactProvider(InputSpecFact, async (ctx) => {",
      "    const { call, at } = await firstCall(ctx);",
      '    return [{ subject: call, value: { fields: { name: { requirement: "required", evidence: [{ kind: "source", message: "provider-b name=required", at }] } }, required: ["name"] }, evidence: [{ kind: "source", message: "provider-b extracted name", at }] }];',
      "  })],",
      "});",
      "export const providerConflict = defineAdapter({",
      '  id: "provider-conflict",',
      "  provides: [defineFactProvider(InputSpecFact, async (ctx) => {",
      "    const { call, at } = await firstCall(ctx);",
      '    return [{ subject: call, value: { fields: { id: { requirement: "optional", evidence: [{ kind: "source", message: "provider-conflict id=optional", at }] } }, required: [] }, evidence: [{ kind: "source", message: "provider-conflict id=optional", at }] }];',
      "  })],",
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  for (const [name, expr] of [
    ["verule.a.mjs", "[providerA]"],
    ["verule.b.mjs", "[providerB]"],
    ["verule.ab.mjs", "[providerA, providerB]"],
    ["verule.ba.mjs", "[providerB, providerA]"],
    ["verule.conflict.ac.mjs", "[providerA, providerConflict]"],
    ["verule.conflict.ca.mjs", "[providerConflict, providerA]"],
  ] as const) {
    writeFileSync(
      join(factHost.path, name),
      [
        'import { defineConfig } from "@verule/sdk";',
        'import { providerA, providerB, providerConflict } from "./providers.mjs";',
        'import { requireAgeRule } from "./business-rule.mjs";',
        `export default defineConfig({ tsconfig: "tsconfig.json", adapters: ${expr}, rules: [requireAgeRule] });`,
        "",
      ].join("\n"),
      "utf8",
    );
  }

  const swapA = invoke(
    factHost.path,
    "check",
    "--config",
    "verule.a.mjs",
    "--output",
    "json",
  );
  const swapB = invoke(
    factHost.path,
    "check",
    "--config",
    "verule.b.mjs",
    "--output",
    "json",
  );
  assert.equal(swapA.status, 1, swapA.stderr);
  assert.equal(swapB.status, 1, swapB.stderr);
  assert.match(swapA.stdout, /\[provider-a\]/u);
  assert.match(swapB.stdout, /\[provider-b\]/u);

  const mergeAB = invoke(
    factHost.path,
    "check",
    "--config",
    "verule.ab.mjs",
    "--output",
    "json",
  );
  const mergeBA = invoke(
    factHost.path,
    "check",
    "--config",
    "verule.ba.mjs",
    "--output",
    "json",
  );
  assert.equal(mergeAB.status, 1, mergeAB.stderr);
  assert.equal(mergeBA.status, 1, mergeBA.stderr);
  assert.equal(mergeAB.stdout, mergeBA.stdout);
  assert.match(mergeAB.stdout, /\[provider-a, provider-b\]/u);

  const conflictAC = invoke(
    factHost.path,
    "check",
    "--config",
    "verule.conflict.ac.mjs",
    "--output",
    "json",
  );
  const conflictCA = invoke(
    factHost.path,
    "check",
    "--config",
    "verule.conflict.ca.mjs",
    "--output",
    "json",
  );
  assert.equal(conflictAC.status, 2);
  assert.equal(conflictCA.status, 2);
  assert.equal(conflictAC.stdout, "");
  assert.equal(conflictAC.stderr, conflictCA.stderr);
  const conflictEnv = JSON.parse(conflictAC.stderr) as {
    kind: string;
    data: {
      code: string;
      conflict: {
        parties: { providerId: string; conclusionSummary: string }[];
      };
    };
  };
  assert.equal(conflictEnv.kind, "failure");
  assert.equal(conflictEnv.data.code, "FACT_CONFLICT");
  assert.deepEqual(
    conflictEnv.data.conflict.parties.map((p) => [
      p.providerId,
      p.conclusionSummary,
    ]),
    [
      ["provider-a", "id=required"],
      ["provider-conflict", "id=optional"],
    ],
  );
});
