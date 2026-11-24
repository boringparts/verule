import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";
import { checkReportSchema } from "../../src/report-wire.ts";

const identity = { commandName: "verule", version: "0.0.0" };
const cliRequire = createRequire(import.meta.url);
const sdkPackageDir = dirname(dirname(cliRequire.resolve("@verule/sdk")));

async function captureCli(argv: readonly string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    argv: ["node", "verule", ...argv],
    cwd,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

function createTempHostProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-fact-providers-"));
  mkdirSync(join(root, "node_modules", "@verule"), { recursive: true });
  symlinkSync(
    realpathSync(sdkPackageDir),
    join(root, "node_modules", "@verule", "sdk"),
    "dir",
  );
  writeFileSync(
    join(root, "tsconfig.json"),
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
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

const SHARED_CONTRACT_MODULE = [
  'import { defineFactType } from "@verule/sdk";',
  "",
  "export const ValidatorContractFact = defineFactType({",
  '  id: "thirdparty.validator.contract",',
  '  description: "Input field requirements extracted by any validator provider.",',
  '  subjectKind: "call",',
  "  merge: (existing, incoming) => {",
  "    const mergedFields = { ...existing.value.fields };",
  "    for (const [name, incomingField] of Object.entries(incoming.value.fields)) {",
  "      const existingField = mergedFields[name];",
  "      if (!existingField) {",
  "        mergedFields[name] = incomingField;",
  "        continue;",
  "      }",
  "      if (existingField.requirement !== incomingField.requirement) {",
  "        return {",
  "          ok: false,",
  "          conflict: {",
  '            message: `Conflicting requirement for "${name}": ${existingField.requirement} vs ${incomingField.requirement}`,',
  "            existingConclusion: `${name}=${existingField.requirement}`,",
  "            incomingConclusion: `${name}=${incomingField.requirement}`,",
  "            existingEvidence: existingField.evidence ?? existing.evidence,",
  "            incomingEvidence: incomingField.evidence ?? incoming.evidence,",
  "          },",
  "        };",
  "      }",
  "    }",
  "    const requiredFields = Object.keys(mergedFields)",
  '      .filter((k) => mergedFields[k].requirement === "required")',
  "      .toSorted();",
  "    return {",
  "      ok: true,",
  "      value: {",
  "        schemaName: existing.value.schemaName ?? incoming.value.schemaName,",
  "        fields: mergedFields,",
  "        requiredFields,",
  "        hasDynamicFields: Boolean(existing.value.hasDynamicFields || incoming.value.hasDynamicFields),",
  "      },",
  "    };",
  "  },",
  "});",
  "",
].join("\n");

const UNCHANGED_RULE_MODULE = [
  'import { defineRule } from "@verule/sdk";',
  'import { ValidatorContractFact } from "./validator-contract.mjs";',
  "",
  "export const requireAgeRule = defineRule({",
  '  id: "require-age-validator",',
  "  run: async (ctx) => {",
  "    const facts = await ctx.facts(ValidatorContractFact);",
  "    for (const fact of facts) {",
  '      if (!fact.value.requiredFields.includes("age")) {',
  "        const rows = await ctx.syntaxOf([fact.subject], { select: { location: true } });",
  "        const at = rows[0]?.location ?? fact.evidence[0]?.at;",
  "        if (!at) continue;",
  "        ctx.report({",
  "          at,",
  '          message: `Validator "${fact.value.schemaName}" is missing required field "age" [${fact.providers.join(", ")}]`,',
  '          findingKey: "missing-age",',
  "          basis: [fact],",
  "        });",
  "      }",
  "    }",
  "  },",
  "});",
  "",
].join("\n");

void test("verule check supports provider replacement without rule changes and explicit providerId filtering", async () => {
  const root = createTempHostProject({
    "src/app.ts": [
      "declare function parseWithAlpha(input: unknown): unknown;",
      "declare function parseWithBeta(input: unknown): unknown;",
      "export function submitAlpha(input: unknown) {",
      "  return parseWithAlpha(input);",
      "}",
      "export function submitBeta(input: unknown) {",
      "  return parseWithBeta(input);",
      "}",
      "",
    ].join("\n"),
    "validator-contract.mjs": SHARED_CONTRACT_MODULE,
    "shared-rule.mjs": UNCHANGED_RULE_MODULE,
    "providers.mjs": [
      'import { defineAdapter, defineFactProvider } from "@verule/sdk";',
      'import { ValidatorContractFact } from "./validator-contract.mjs";',
      "",
      "export const alphaProvider = defineAdapter({",
      '  id: "alpha-validator",',
      "  provides: [",
      "    defineFactProvider(ValidatorContractFact, async (ctx) => {",
      '      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));",
      "      const out = [];",
      "      for (const [idx, call] of calls.entries()) {",
      '        if (!call.text.startsWith("parseWithAlpha(")) continue;',
      "        out.push({",
      "          subject: resolved[idx].call,",
      "          value: {",
      '            schemaName: "alphaSchema",',
      '            fields: { id: { requirement: "required" } },',
      '            requiredFields: ["id"],',
      "            hasDynamicFields: false,",
      "          },",
      "          evidence: [{",
      '            kind: "source",',
      '            message: "alpha-validator extracted alphaSchema",',
      "            at: call.location,",
      "          }],",
      "        });",
      "      }",
      "      return out;",
      "    }),",
      "  ],",
      "});",
      "",
      "export const betaProvider = defineAdapter({",
      '  id: "beta-validator",',
      "  provides: [",
      "    defineFactProvider(ValidatorContractFact, async (ctx) => {",
      '      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));",
      "      const out = [];",
      "      for (const [idx, call] of calls.entries()) {",
      '        if (!call.text.startsWith("parseWithBeta(")) continue;',
      "        out.push({",
      "          subject: resolved[idx].call,",
      "          value: {",
      '            schemaName: "betaSchema",',
      '            fields: { email: { requirement: "required" } },',
      '            requiredFields: ["email"],',
      "            hasDynamicFields: false,",
      "          },",
      "          evidence: [{",
      '            kind: "source",',
      '            message: "beta-validator extracted betaSchema",',
      "            at: call.location,",
      "          }],",
      "        });",
      "      }",
      "      return out;",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "verule.alpha.config.mjs": [
      'import { defineConfig } from "@verule/sdk";',
      'import { alphaProvider } from "./providers.mjs";',
      'import { requireAgeRule } from "./shared-rule.mjs";',
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [alphaProvider], rules: [requireAgeRule] });',
      "",
    ].join("\n"),
    "verule.beta.config.mjs": [
      'import { defineConfig } from "@verule/sdk";',
      'import { betaProvider } from "./providers.mjs";',
      'import { requireAgeRule } from "./shared-rule.mjs";',
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [betaProvider], rules: [requireAgeRule] });',
      "",
    ].join("\n"),
    "verule.scoped.config.mjs": [
      'import { defineConfig, defineRule } from "@verule/sdk";',
      'import { ValidatorContractFact } from "./validator-contract.mjs";',
      'import { alphaProvider, betaProvider } from "./providers.mjs";',
      "const scopedRule = defineRule({",
      '  id: "beta-only-rule",',
      "  run: async (ctx) => {",
      '    const items = await ctx.facts(ValidatorContractFact, { providerId: "beta-validator" });',
      "    for (const item of items) {",
      "      const at = item.evidence[0]?.at;",
      "      if (!at) continue;",
      "      ctx.report({",
      "        at,",
      '        message: `Scoped to [${item.providers.join(", ")}]`,',
      '        findingKey: "scoped-beta",',
      "        basis: [item],",
      "      });",
      "    }",
      "  },",
      "});",
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [alphaProvider, betaProvider], rules: [scopedRule] });',
      "",
    ].join("\n"),
  });

  try {
    const alphaRes = await captureCli(
      ["check", "--config", "verule.alpha.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(alphaRes.status, 1, alphaRes.stderr);
    const alphaEnv = JSON.parse(alphaRes.stdout) as {
      data: {
        diagnostics: {
          message: string;
          at: { line: number };
          evidence: { message: string }[];
        }[];
      };
    };
    assert.equal(alphaEnv.data.diagnostics.length, 1);
    assert.match(
      alphaEnv.data.diagnostics[0]!.message,
      /alphaSchema.*alpha-validator/u,
    );
    assert.equal(alphaEnv.data.diagnostics[0]!.at.line, 4);

    // Swap provider to betaProvider while shared-rule.mjs is untouched
    const betaRes = await captureCli(
      ["check", "--config", "verule.beta.config.mjs", "--output", "json"],
      root,
    );
    assert.equal(betaRes.status, 1, betaRes.stderr);
    const betaEnv = JSON.parse(betaRes.stdout) as {
      data: {
        diagnostics: {
          message: string;
          at: { line: number };
          evidence: { message: string }[];
        }[];
      };
    };
    assert.equal(betaEnv.data.diagnostics.length, 1);
    assert.match(
      betaEnv.data.diagnostics[0]!.message,
      /betaSchema.*beta-validator/u,
    );
    assert.equal(betaEnv.data.diagnostics[0]!.at.line, 7);

    // Explicit providerId filtering reflected in observation & explanation
    const scopedRes = await captureCli(
      [
        "check",
        "--config",
        "verule.scoped.config.mjs",
        "--observe",
        "detail",
        "--at",
        "src/app.ts:7:10",
        "--output",
        "json",
      ],
      root,
    );
    assert.equal(scopedRes.status, 1, scopedRes.stderr);
    const scopedEnv = JSON.parse(scopedRes.stdout) as {
      data: {
        diagnostics: { message: string }[];
        observation: { providers: string[] };
        explanation: {
          providers: string[];
          queries: { op: string; provider: string; candidateCount: number }[];
        };
      };
    };
    assert.equal(scopedEnv.data.diagnostics.length, 1);
    assert.equal(
      scopedEnv.data.diagnostics[0]!.message,
      "Scoped to [beta-validator]",
    );
    assert.equal(
      scopedEnv.data.observation.providers.includes("beta-validator"),
      true,
    );
    assert.equal(
      scopedEnv.data.observation.providers.includes("alpha-validator"),
      false,
    );
    assert.deepEqual(scopedEnv.data.explanation.providers, ["beta-validator"]);
    assert.equal(
      scopedEnv.data.explanation.queries.find((q) => q.op.startsWith("facts:"))
        ?.candidateCount,
      1,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule check merges complementary partial facts identically and exits 2 with structured FACT_CONFLICT regardless of adapter order", async () => {
  const root = createTempHostProject({
    "src/app.ts": [
      "declare function parseUser(input: unknown): unknown;",
      "export function submit(input: unknown) {",
      "  return parseUser(input);",
      "}",
      "",
    ].join("\n"),
    "validator-contract.mjs": SHARED_CONTRACT_MODULE,
    "shared-rule.mjs": UNCHANGED_RULE_MODULE,
    "providers.mjs": [
      'import { defineAdapter, defineFactProvider } from "@verule/sdk";',
      'import { ValidatorContractFact } from "./validator-contract.mjs";',
      "",
      "export const partA = defineAdapter({",
      '  id: "provider-a",',
      "  provides: [",
      "    defineFactProvider(ValidatorContractFact, async (ctx) => {",
      '      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));",
      "      return [{",
      "        subject: resolved[0].call,",
      "        value: {",
      '          schemaName: "UserSchema",',
      '          fields: { id: { requirement: "required", evidence: [{ kind: "source", message: "provider-a id=required", at: calls[0].location }] } },',
      '          requiredFields: ["id"],',
      "          hasDynamicFields: true,",
      "        },",
      '        evidence: [{ kind: "source", message: "provider-a partial schema", at: calls[0].location }],',
      '        gaps: [{ kind: "dynamic-spread", message: "provider-a dynamic spread", at: calls[0].location }],',
      "      }];",
      "    }),",
      "  ],",
      "});",
      "",
      "export const partB = defineAdapter({",
      '  id: "provider-b",',
      "  provides: [",
      "    defineFactProvider(ValidatorContractFact, async (ctx) => {",
      '      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));",
      "      return [{",
      "        subject: resolved[0].call,",
      "        value: {",
      '          schemaName: "UserSchema",',
      '          fields: { name: { requirement: "required", evidence: [{ kind: "source", message: "provider-b name=required", at: calls[0].location }] } },',
      '          requiredFields: ["name"],',
      "          hasDynamicFields: false,",
      "        },",
      '        evidence: [{ kind: "source", message: "provider-b complemented name", at: calls[0].location }],',
      "      }];",
      "    }),",
      "  ],",
      "});",
      "",
      "export const conflictC = defineAdapter({",
      '  id: "provider-c",',
      "  provides: [",
      "    defineFactProvider(ValidatorContractFact, async (ctx) => {",
      '      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));",
      "      return [{",
      "        subject: resolved[0].call,",
      "        value: {",
      '          schemaName: "UserSchema",',
      '          fields: { id: { requirement: "optional", evidence: [{ kind: "source", message: "provider-c id=optional", at: calls[0].location }] } },',
      "          requiredFields: [],",
      "          hasDynamicFields: false,",
      "        },",
      '        evidence: [{ kind: "source", message: "provider-c contradicts id", at: calls[0].location }],',
      "      }];",
      "    }),",
      "  ],",
      "});",
      "",
    ].join("\n"),
    "verule.merge.ab.mjs": [
      'import { defineConfig } from "@verule/sdk";',
      'import { partA, partB } from "./providers.mjs";',
      'import { requireAgeRule } from "./shared-rule.mjs";',
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [partA, partB], rules: [requireAgeRule] });',
      "",
    ].join("\n"),
    "verule.merge.ba.mjs": [
      'import { defineConfig } from "@verule/sdk";',
      'import { partA, partB } from "./providers.mjs";',
      'import { requireAgeRule } from "./shared-rule.mjs";',
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [partB, partA], rules: [requireAgeRule] });',
      "",
    ].join("\n"),
    "verule.conflict.ac.mjs": [
      'import { defineConfig } from "@verule/sdk";',
      'import { partA, conflictC } from "./providers.mjs";',
      'import { requireAgeRule } from "./shared-rule.mjs";',
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [partA, conflictC], rules: [requireAgeRule] });',
      "",
    ].join("\n"),
    "verule.conflict.ca.mjs": [
      'import { defineConfig } from "@verule/sdk";',
      'import { partA, conflictC } from "./providers.mjs";',
      'import { requireAgeRule } from "./shared-rule.mjs";',
      'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [conflictC, partA], rules: [requireAgeRule] });',
      "",
    ].join("\n"),
  });

  try {
    // 1. Partial merge AB vs BA -> identical exit code, diagnostics, gaps, identity
    const mergeAB = await captureCli(
      ["check", "--config", "verule.merge.ab.mjs", "--output", "json"],
      root,
    );
    const mergeBA = await captureCli(
      ["check", "--config", "verule.merge.ba.mjs", "--output", "json"],
      root,
    );
    assert.equal(
      mergeAB.status,
      1,
      `stdout=${mergeAB.stdout}\nstderr=${mergeAB.stderr}`,
    );
    assert.equal(
      mergeBA.status,
      1,
      `stdout=${mergeBA.stdout}\nstderr=${mergeBA.stderr}`,
    );
    assert.equal(mergeAB.stdout, mergeBA.stdout);

    const mergeEnv = JSON.parse(mergeAB.stdout) as {
      data: {
        diagnostics: { message: string; evidence: { message: string }[] }[];
        gaps: { kind: string }[];
      };
    };
    assert.equal(
      mergeEnv.data.diagnostics.length,
      1,
      JSON.stringify(mergeEnv.data.diagnostics),
    );
    assert.match(
      mergeEnv.data.diagnostics[0]!.message,
      /\[provider-a, provider-b\]/u,
    );
    assert.equal(mergeEnv.data.diagnostics[0]!.evidence.length, 2);
    assert.equal(mergeEnv.data.gaps.length, 1);

    // 2. Mutual exclusion conflict AC vs CA -> exit code 2 + identical structured JSON & text
    const conflictJsonAC = await captureCli(
      ["check", "--config", "verule.conflict.ac.mjs", "--output", "json"],
      root,
    );
    const conflictJsonCA = await captureCli(
      ["check", "--config", "verule.conflict.ca.mjs", "--output", "json"],
      root,
    );
    assert.equal(conflictJsonAC.status, 2);
    assert.equal(conflictJsonCA.status, 2);
    assert.equal(conflictJsonAC.stdout, "");
    assert.equal(conflictJsonCA.stdout, "");
    assert.equal(conflictJsonAC.stderr, conflictJsonCA.stderr);

    const errEnv = JSON.parse(conflictJsonAC.stderr) as {
      kind: string;
      variant: string;
      data: {
        reportVersion: string;
        code: string;
        message: string;
        conflict?: {
          factTypeId: string;
          parties: {
            providerId: string;
            conclusionSummary: string;
            evidence: { message: string }[];
          }[];
        };
      };
    };
    assert.equal(errEnv.kind, "failure");
    assert.equal(errEnv.variant, "failed");
    assert.equal(errEnv.data.code, "FACT_CONFLICT");
    assert.ok(errEnv.data.conflict);
    assert.equal(
      errEnv.data.conflict.factTypeId,
      "thirdparty.validator.contract",
    );
    assert.deepEqual(
      errEnv.data.conflict.parties.map((p) => p.providerId),
      ["provider-a", "provider-c"],
    );
    assert.deepEqual(
      errEnv.data.conflict.parties.map((p) => p.conclusionSummary),
      ["id=required", "id=optional"],
    );
    assert.equal(
      errEnv.data.conflict.parties[0]!.evidence[0]!.message,
      "provider-a id=required",
    );
    assert.equal(
      errEnv.data.conflict.parties[1]!.evidence[0]!.message,
      "provider-c id=optional",
    );

    const conflictTextAC = await captureCli(
      ["check", "--config", "verule.conflict.ac.mjs"],
      root,
    );
    const conflictTextCA = await captureCli(
      ["check", "--config", "verule.conflict.ca.mjs"],
      root,
    );
    assert.equal(conflictTextAC.status, 2);
    assert.equal(conflictTextCA.status, 2);
    assert.equal(conflictTextAC.stderr, conflictTextCA.stderr);
    assert.match(conflictTextAC.stderr, /Check failed \[FACT_CONFLICT\]/u);
    assert.match(conflictTextAC.stderr, /provider-a/u);
    assert.match(conflictTextAC.stderr, /provider-c/u);
    assert.match(conflictTextAC.stderr, /provider-a id=required/u);
    assert.match(conflictTextAC.stderr, /provider-c id=optional/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("verule check --at surfaces blocked_by_gap, localGaps (unresolved and resolved_by_override), and skipped providers in JSON and text output", async () => {
  const root = createTempHostProject({
    "src/source.ts": [
      "export function defineSpec(name: string, fields: Record<string, string>) {",
      "  return { name, fields };",
      "}",
      "declare function dynamicSpec(): string;",
      'export const orderSpec = defineSpec("order", {',
      '  orderId: "required",',
      "  couponCode: dynamicSpec(),",
      "});",
      "",
    ].join("\n"),
    "src/consumer.ts": [
      'import { orderSpec } from "./source.js";',
      "export function useSpec(spec: unknown, overrides?: Record<string, string>) {",
      "  return { spec, overrides };",
      "}",
      "export const rawConsumer = useSpec(orderSpec);",
      'export const overriddenConsumer = useSpec(orderSpec, { couponCode: "defaulted" });',
      "",
    ].join("\n"),
    "verule.local-gaps.config.mjs": [
      'import { defineAdapter, defineConfig, defineFactProvider, defineFactType, defineRule } from "@verule/sdk";',
      'const SourceFact = defineFactType({ id: "cli.explain.source", subjectKind: "syntax" });',
      'const ConsumerFact = defineFactType({ id: "cli.explain.consumer", subjectKind: "syntax" });',
      'const UnusedFact = defineFactType({ id: "cli.explain.unused", subjectKind: "syntax" });',
      "const adapterA = defineAdapter({",
      '  id: "cli-adapter-a",',
      "  provides: [",
      "    defineFactProvider(SourceFact, async (ctx, req) => {",
      '      const calls = await ctx.findSyntax({ files: ["src/source.ts"], kinds: ["CallExpression"] });',
      '      const spec = calls.find((c) => c.text.startsWith("defineSpec("));',
      '      const dyn = calls.find((c) => c.text.startsWith("dynamicSpec("));',
      "      if (!spec || !dyn) return [];",
      '      const gap = { kind: "unresolved-field", message: "Field couponCode is dynamic.", at: dyn.location };',
      "      return [{",
      "        subject: spec.ref,",
      '        value: { fields: { orderId: "required" }, unknownFields: ["couponCode"] },',
      "        gaps: [gap],",
      "        ...(req.explain ? { explainTrace: { localGaps: [{",
      '          status: "unresolved",',
      "          factTypeId: SourceFact.id,",
      '          providerId: "cli-adapter-a",',
      '          field: "couponCode",',
      "          gap,",
      "          subjectLocation: spec.location,",
      "        }] } } : {}),",
      "      }];",
      "    }),",
      "  ],",
      "});",
      "const adapterB = defineAdapter({",
      '  id: "cli-adapter-b",',
      "  provides: [",
      "    defineFactProvider(ConsumerFact, async (ctx, req) => {",
      '      const srcCalls = await ctx.findSyntax({ files: ["src/source.ts"], kinds: ["CallExpression"] });',
      '      const srcTarget = srcCalls.find((c) => c.text.startsWith("defineSpec("));',
      "      if (!srcTarget) return [];",
      "      const srcFacts = await ctx.facts(SourceFact, { targets: [srcTarget.ref] });",
      "      const factA = srcFacts[0];",
      "      if (!factA) return [];",
      '      const calls = await ctx.findSyntax({ files: ["src/consumer.ts"], kinds: ["CallExpression"] });',
      "      return calls",
      '        .filter((c) => c.text.startsWith("useSpec("))',
      "        .map((call) => {",
      '          const isOverridden = call.text.includes("defaulted");',
      "          const initialGap = factA.gaps[0];",
      "          return {",
      "            subject: call.ref,",
      "            value: {",
      "              consumerName: isOverridden ? 'overridden' : 'raw',",
      "              fields: isOverridden ? { orderId: 'required', couponCode: 'defaulted' } : { orderId: 'required' },",
      "              unknownFields: isOverridden ? [] : ['couponCode'],",
      "            },",
      "            evidence: [{ kind: 'source', message: 'derived', at: call.location }],",
      "            gaps: isOverridden ? [] : factA.gaps,",
      "            ...(req.explain && initialGap ? { explainTrace: { localGaps: [{",
      "              status: isOverridden ? 'resolved_by_override' : 'unresolved',",
      "              factTypeId: SourceFact.id,",
      "              providerId: 'cli-adapter-a',",
      "              field: 'couponCode',",
      "              gap: initialGap,",
      "              subjectLocation: call.location,",
      "              ...(isOverridden ? { resolvedBy: { providerId: 'cli-adapter-b', operation: 'override', conclusion: 'couponCode=defaulted', at: call.location } } : {}),",
      "            }] } } : {}),",
      "          };",
      "        });",
      "    }),",
      "  ],",
      "});",
      "const unusedAdapter = defineAdapter({",
      '  id: "cli-adapter-unused",',
      "  provides: [defineFactProvider(UnusedFact, () => [])],",
      "});",
      "const couponRule = defineRule({",
      '  id: "cli-coupon-rule",',
      "  run: async (ctx) => {",
      "    const facts = await ctx.facts(ConsumerFact);",
      "    for (const fact of facts) {",
      '      if (fact.value.unknownFields.includes("couponCode")) continue;',
      '      if (fact.value.fields.couponCode === "defaulted") {',
      "        ctx.report({ at: fact.evidence[0].at, message: 'coupon defaulted', basis: [fact] });",
      "      }",
      "    }",
      "  },",
      "});",
      "export default defineConfig({",
      '  tsconfig: "tsconfig.json",',
      "  adapters: [adapterA, adapterB, unusedAdapter],",
      "  rules: [couponRule],",
      "});",
      "",
    ].join("\n"),
  });

  try {
    const blockedJson = await captureCli(
      [
        "check",
        "--config",
        "verule.local-gaps.config.mjs",
        "--at",
        "src/consumer.ts:5:28",
        "--output",
        "json",
      ],
      root,
    );
    assert.equal(blockedJson.status, 1, blockedJson.stderr);
    const blockedParsed = checkReportSchema.parse(
      (JSON.parse(blockedJson.stdout) as { readonly data: unknown }).data,
    );
    assert.equal(blockedParsed.gaps.length, 1);
    assert.equal(blockedParsed.explanation?.status, "blocked_by_gap");
    assert.equal(blockedParsed.explanation?.gaps.length, 1);
    assert.equal(blockedParsed.explanation?.localGaps[0]?.status, "unresolved");
    assert.equal(blockedParsed.explanation?.localGaps[0]?.field, "couponCode");
    assert.ok(
      blockedParsed.explanation?.providerEvaluations.some(
        (ev) =>
          ev.providerId === "cli-adapter-unused" && ev.status === "skipped",
      ),
    );

    const overriddenText = await captureCli(
      [
        "check",
        "--config",
        "verule.local-gaps.config.mjs",
        "--at",
        "src/consumer.ts:6:35",
      ],
      root,
    );
    assert.equal(overriddenText.status, 1, overriddenText.stderr);
    assert.match(
      overriddenText.stdout,
      /localGap \[resolved_by_override\] cli\.explain\.source \(cli-adapter-a\) field=couponCode/u,
    );
    assert.match(
      overriddenText.stdout,
      /resolved_by cli-adapter-b \(override: couponCode=defaulted/u,
    );
    assert.match(
      overriddenText.stdout,
      /provider \[skipped\] cli-adapter-unused/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
