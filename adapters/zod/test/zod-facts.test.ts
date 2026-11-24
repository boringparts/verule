import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ValidatorFieldFact,
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
  type ValidatorFieldFactValue,
  type ValidatorInputFieldsFactValue,
  type ValidatorOutputFieldsFactValue,
} from "@verule/adapter-zod";
import {
  defineAdapter,
  defineConfig,
  defineRule,
  openSession,
  runCheck,
  type FactResult,
} from "@verule/sdk";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkRoot = join(packageRoot, "node_modules", "@verule", "sdk");
const tscBin = join(packageRoot, "node_modules", ".bin", "tsc");

function createTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-zod-facts-"));
  mkdirSync(join(root, "node_modules", "@verule"), { recursive: true });
  symlinkSync(
    packageRoot,
    join(root, "node_modules", "@verule", "adapter-zod"),
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

const ZOD_POLYFILL_STUB = [
  "export type ZodAnyType = {",
  "  optional: () => ZodAnyType;",
  "  nullish: () => ZodAnyType;",
  "  nullable: () => ZodAnyType;",
  "  default: (v: unknown) => ZodAnyType;",
  "  prefault: (v: unknown) => ZodAnyType;",
  "  catch: (v: unknown) => ZodAnyType;",
  "  nonoptional: () => ZodAnyType;",
  "  transform: (fn: (v: never) => unknown) => ZodAnyType;",
  "  refine: (fn: (v: never) => boolean) => ZodAnyType;",
  "  superRefine: (fn: (v: never, ctx: unknown) => void) => ZodAnyType;",
  "  pipe: (target: ZodAnyType) => ZodAnyType;",
  "  openapi: (meta: unknown) => ZodAnyType;",
  "  extend: (shape: Record<string, unknown>) => ZodObjectType;",
  "  merge: (other: ZodObjectType) => ZodObjectType;",
  "  pick: (mask: Record<string, boolean>) => ZodObjectType;",
  "  omit: (mask: Record<string, boolean>) => ZodObjectType;",
  "  partial: (mask?: Record<string, boolean>) => ZodObjectType;",
  "  required: (mask?: Record<string, boolean>) => ZodObjectType;",
  "  parse: (v: unknown) => unknown;",
  "  safeParse: (v: unknown) => { success: boolean; data?: unknown };",
  "  parseAsync: (v: unknown) => Promise<unknown>;",
  "  safeParseAsync: (v: unknown) => Promise<{ success: boolean; data?: unknown }>;",
  "  shape: Record<string, ZodAnyType>;",
  "};",
  "export type ZodObjectType = ZodAnyType;",
  "declare const zodNode: ZodAnyType;",
  "export const z = {",
  "  string: () => zodNode,",
  "  number: () => zodNode,",
  "  boolean: () => zodNode,",
  "  enum: (_values: readonly string[]) => zodNode,",
  "  array: (_item: ZodAnyType) => zodNode,",
  "  any: () => zodNode,",
  "  unknown: () => zodNode,",
  "  record: (_k: ZodAnyType, _v?: ZodAnyType) => zodNode,",
  "  object: (_shape: Record<string, unknown>) => zodNode,",
  "  strictObject: (_shape: Record<string, unknown>) => zodNode,",
  "  looseObject: (_shape: Record<string, unknown>) => zodNode,",
  "  union: (_items: readonly ZodAnyType[]) => zodNode,",
  "  discriminatedUnion: (_k: string, _items: readonly ZodAnyType[]) => zodNode,",
  "  intersection: (_a: ZodAnyType, _b: ZodAnyType) => zodNode,",
  "};",
  "",
].join("\n");

void describe("@verule/adapter-zod", () => {
  void it("extracts basic z.object schemas and .parse/.safeParse/.parseAsync/.safeParseAsync calls while ignoring non-Zod .parse", async () => {
    const root = createTempProject({
      "src/zod-stub.ts": ZOD_POLYFILL_STUB,
      "src/handlers.ts": [
        'import { z } from "./zod-stub.js";',
        "",
        "export const userSchema = z.object({",
        "  id: z.string(),",
        "  age: z.number(),",
        "  bio: z.string().optional(),",
        "});",
        "",
        "export async function handleAll(raw: string, input: unknown) {",
        "  const json = JSON.parse(raw);",
        "  const a = userSchema.parse(input);",
        "  const b = userSchema.safeParse(input);",
        "  const c = await userSchema.parseAsync(input);",
        "  const d = await userSchema.safeParseAsync(input);",
        "  return { json, a, b, c, d };",
        "}",
        "",
      ].join("\n"),
    });

    let inputFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];
    let outputFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorOutputFieldsFactValue
    >[] = [];

    const inspectRule = defineRule({
      id: "inspect-zod",
      run: async (ctx) => {
        inputFacts = await ctx.facts(ValidatorInputFieldsFact);
        outputFacts = await ctx.facts(ValidatorOutputFieldsFact);
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [inspectRule],
        }),
      });
      assert.equal(report.status, "clean");

      const calls = inputFacts.filter((f) => f.value.siteKind === "call");
      assert.equal(calls.length, 4);
      const methods = calls
        .map((c) => c.value.validatorMethod ?? "")
        .toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      assert.deepEqual(methods, [
        "parse",
        "parseAsync",
        "safeParse",
        "safeParseAsync",
      ]);
      for (const callFact of calls) {
        assert.deepEqual(callFact.value.requiredFields, ["age", "id"]);
        assert.deepEqual(callFact.value.optionalFields, ["bio"]);
        assert.deepEqual(callFact.value.defaultedFields, []);
        assert.equal(callFact.value.hasDynamicFields, false);
        assert.ok(
          callFact.evidence.some(
            (ev) => ev.at?.file === "src/handlers.ts" && ev.at.line === 3,
          ),
        );
      }

      const schemas = inputFacts.filter((f) => f.value.siteKind === "schema");
      assert.equal(schemas.length, 1);
      assert.equal(schemas[0]!.value.schemaName, "userSchema");
      assert.deepEqual(schemas[0]!.value.requiredFields, ["age", "id"]);

      const outCalls = outputFacts.filter((f) => f.value.siteKind === "call");
      assert.equal(outCalls.length, 4);
      assert.deepEqual(outCalls[0]!.value.presentFields, ["age", "id"]);
      assert.deepEqual(outCalls[0]!.value.optionalFields, ["bio"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("distinguishes .nullable(), .optional(), .nullish(), v3 .default(), v4 .prefault()/.catch(), and unwraps outer chains", async () => {
    const root = createTempProject({
      "src/zod-stub.ts": ZOD_POLYFILL_STUB,
      "src/modifiers.ts": [
        'import { z } from "./zod-stub.js";',
        "",
        'const workspacePlans = ["free", "pro"] as const;',
        "",
        "export const accountSchema = z",
        "  .object({",
        "    id: z.string(),",
        "    homepageUrl: z.string().nullable(),",
        "    nickname: z.string().optional(),",
        "    customTheme: z.string().nullish(),",
        '    plan: z.enum(workspacePlans).nullable().default("free").transform((p) => p).openapi({ description: "plan" }),',
        '    password: z.string().nullable().prefault(""),',
        '    timezone: z.string().catch("UTC"),',
        "    fallbackTheme: z.string().nullish().catch(null),",
        "  })",
        "  .refine((v) => Boolean(v.id))",
        "  .superRefine(() => {})",
        "  .transform((v) => ({ ...v }))",
        '  .openapi("Account");',
        "",
        "export const pipedSchema = z",
        "  .object({",
        "    rawId: z.string(),",
        '    role: z.string().default("member"),',
        "  })",
        "  .pipe(",
        "    z.object({",
        "      rawId: z.string(),",
        "      role: z.string(),",
        "    }),",
        "  );",
        "",
        "export function validate(input: unknown) {",
        "  return {",
        "    account: accountSchema.parse(input),",
        "    piped: pipedSchema.safeParse(input),",
        "  };",
        "}",
        "",
      ].join("\n"),
    });

    let inputFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];
    let outputFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorOutputFieldsFactValue
    >[] = [];

    const rule = defineRule({
      id: "check-modifiers",
      run: async (ctx) => {
        inputFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
        outputFacts = await ctx.facts(ValidatorOutputFieldsFact, {
          condition: { scope: "calls" },
        });
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");

      const accountIn = inputFacts.find(
        (f) => f.value.schemaName === "accountSchema",
      );
      assert.ok(accountIn);
      // homepageUrl has .nullable() ONLY -> still required on input!
      assert.deepEqual(accountIn.value.requiredFields, ["homepageUrl", "id"]);
      assert.equal(accountIn.value.fields.homepageUrl?.nullable, true);
      assert.deepEqual(accountIn.value.defaultedFields, [
        "fallbackTheme",
        "password",
        "plan",
        "timezone",
      ]);
      assert.deepEqual(accountIn.value.optionalFields, [
        "customTheme",
        "fallbackTheme",
        "nickname",
        "password",
        "plan",
        "timezone",
      ]);

      const accountOut = outputFacts.find(
        (f) => f.value.schemaName === "accountSchema",
      );
      assert.ok(accountOut);
      // On output, defaulted/prefaulted/caught fields ARE guaranteed present!
      assert.deepEqual(accountOut.value.presentFields, [
        "fallbackTheme",
        "homepageUrl",
        "id",
        "password",
        "plan",
        "timezone",
      ]);
      assert.deepEqual(accountOut.value.optionalFields, [
        "customTheme",
        "nickname",
      ]);
      assert.deepEqual(accountOut.value.defaultedFields, [
        "fallbackTheme",
        "password",
        "plan",
        "timezone",
      ]);

      const pipedIn = inputFacts.find(
        (f) => f.value.schemaName === "pipedSchema",
      );
      assert.ok(pipedIn);
      assert.deepEqual(pipedIn.value.requiredFields, ["rawId"]);
      assert.deepEqual(pipedIn.value.defaultedFields, ["role"]);

      const pipedOut = outputFacts.find(
        (f) => f.value.schemaName === "pipedSchema",
      );
      assert.ok(pipedOut);
      assert.deepEqual(pipedOut.value.presentFields, ["rawId", "role"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("resolves .extend, .merge, .pick, .omit, .partial, .required across files and re-extracts after session.update()", async () => {
    const root = createTempProject({
      "src/zod-stub.ts": ZOD_POLYFILL_STUB,
      "src/schemas.ts": [
        'import { z } from "./zod-stub.js";',
        "",
        "export const basePageSchema = z.object({",
        "  id: z.string(),",
        "  slug: z.string(),",
        "  title: z.string(),",
        "  password: z.string().nullable(),",
        "});",
        "",
        "export const extraMetaSchema = z.object({",
        '  locale: z.string().prefault("en"),',
        "  secret: z.string(),",
        "});",
        "",
      ].join("\n"),
      "src/routes.ts": [
        'import { basePageSchema, extraMetaSchema } from "./schemas.js";',
        "",
        "const extendedPage = basePageSchema",
        "  .extend({",
        "    password: basePageSchema.shape ? basePageSchema.shape.password! : basePageSchema,",
        "    customDomain: z.string().nullable(),",
        "  })",
        "  .merge(extraMetaSchema);",
        "",
        "const pickedGate = basePageSchema.pick({ slug: true, title: true });",
        "const omittedPage = extraMetaSchema.omit({ secret: true });",
        "const partialGate = pickedGate.partial();",
        "const requiredAgain = partialGate.required({ slug: true });",
        "",
        "export function runRoute(input: unknown) {",
        "  const a = extendedPage.parse(input);",
        "  const b = pickedGate.parse(input);",
        "  const c = omittedPage.parse(input);",
        "  const d = partialGate.parse(input);",
        "  const e = requiredAgain.parse(input);",
        "  return { a, b, c, d, e };",
        "}",
        "",
      ].join("\n"),
    });

    // Fix extendedPage password line to use z.string().nullable().prefault("") cleanly
    writeFileSync(
      join(root, "src", "routes.ts"),
      [
        'import { z } from "./zod-stub.js";',
        'import { basePageSchema, extraMetaSchema } from "./schemas.js";',
        "",
        "const extendedPage = basePageSchema",
        "  .extend({",
        '    password: z.string().nullable().prefault(""),',
        "    customDomain: z.string().nullable(),",
        "  })",
        "  .merge(extraMetaSchema);",
        "",
        "const pickedGate = basePageSchema.pick({ slug: true, title: true });",
        "const omittedPage = extraMetaSchema.omit({ secret: true });",
        "const partialGate = pickedGate.partial();",
        "const requiredAgain = partialGate.required({ slug: true });",
        "",
        "export function runRoute(input: unknown) {",
        "  const a = extendedPage.parse(input);",
        "  const b = pickedGate.parse(input);",
        "  const c = omittedPage.parse(input);",
        "  const d = partialGate.parse(input);",
        "  const e = requiredAgain.parse(input);",
        "  return { a, b, c, d, e };",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );

    let callFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];

    const rule = defineRule({
      id: "check-compositions",
      run: async (ctx) => {
        callFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
      },
    });

    const session = await openSession({
      cwd: root,
      config: defineConfig({
        tsconfig: "tsconfig.json",
        adapters: ["@verule/adapter-zod"],
        rules: [rule],
      }),
    });

    try {
      await session.check();

      const bySchema = (name: string) =>
        callFacts.find((f) => f.value.schemaName === name);

      assert.deepEqual(bySchema("extendedPage")?.value.requiredFields, [
        "customDomain",
        "id",
        "secret",
        "slug",
        "title",
      ]);
      assert.deepEqual(bySchema("extendedPage")?.value.defaultedFields, [
        "locale",
        "password",
      ]);
      // Evidence points back into src/schemas.ts!
      assert.ok(
        bySchema("extendedPage")?.evidence.some(
          (ev) => ev.at?.file === "src/schemas.ts",
        ),
      );

      assert.deepEqual(bySchema("pickedGate")?.value.requiredFields, [
        "slug",
        "title",
      ]);
      assert.deepEqual(bySchema("omittedPage")?.value.requiredFields, []);
      assert.deepEqual(bySchema("omittedPage")?.value.defaultedFields, [
        "locale",
      ]);
      assert.deepEqual(bySchema("partialGate")?.value.requiredFields, []);
      assert.deepEqual(bySchema("partialGate")?.value.optionalFields, [
        "slug",
        "title",
      ]);
      assert.deepEqual(bySchema("requiredAgain")?.value.requiredFields, [
        "slug",
      ]);
      assert.deepEqual(bySchema("requiredAgain")?.value.optionalFields, [
        "title",
      ]);

      // Modify src/schemas.ts and update session -> pickedGate/extendedPage facts & evidence update!
      writeFileSync(
        join(root, "src", "schemas.ts"),
        [
          'import { z } from "./zod-stub.js";',
          "",
          "export const basePageSchema = z.object({",
          "  id: z.string(),",
          "  slug: z.string().optional(),",
          "  title: z.string(),",
          "  password: z.string().nullable(),",
          "});",
          "",
          "export const extraMetaSchema = z.object({",
          '  locale: z.string().prefault("en"),',
          "  secret: z.string(),",
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      await session.update({ changed: ["src/schemas.ts"] });
      await session.check();

      assert.deepEqual(bySchema("pickedGate")?.value.requiredFields, ["title"]);
      assert.deepEqual(bySchema("pickedGate")?.value.optionalFields, ["slug"]);
      assert.equal(bySchema("pickedGate")?.snapshotId, session.snapshotId);
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("preserves known deterministic fields and emits location-aware Gaps for dynamic constructs", async () => {
    const root = createTempProject({
      "src/zod-stub.ts": ZOD_POLYFILL_STUB,
      "src/dynamic.ts": [
        'import { z } from "./zod-stub.js";',
        "",
        "declare function dynamicShape(): Record<string, typeof z.string>;",
        'const dynKey = Math.random() > 0.5 ? "a" : "b";',
        "",
        "export const mixedSchema = z.object({",
        "  id: z.string(),",
        "  ...dynamicShape(),",
        "  [dynKey]: z.string(),",
        "  extra: z.any(),",
        "  meta: z.unknown(),",
        "});",
        "",
        "export const dictSchema = z.record(z.string(), z.number());",
        "",
        "export function parseDynamic(input: unknown) {",
        "  return {",
        "    mixed: mixedSchema.parse(input),",
        "    dict: dictSchema.parse(input),",
        "  };",
        "}",
        "",
      ].join("\n"),
    });

    let inputFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];

    const rule = defineRule({
      id: "inspect-dynamic",
      run: async (ctx) => {
        inputFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");

      const mixed = inputFacts.find(
        (f) => f.value.schemaName === "mixedSchema",
      );
      assert.ok(mixed);
      assert.equal(mixed.value.hasDynamicFields, true);
      // Known deterministic fields preserved!
      assert.deepEqual(mixed.value.requiredFields, ["extra", "id", "meta"]);
      assert.ok(
        mixed.gaps.some(
          (g) => g.kind === "dynamic-schema-spread" && g.at?.line === 8,
        ),
      );
      assert.ok(
        mixed.gaps.some(
          (g) => g.kind === "dynamic-schema-field" && g.at?.line === 9,
        ),
      );
      assert.ok(
        mixed.gaps.some(
          (g) => g.kind === "dynamic-schema-field" && g.at?.line === 10,
        ),
      );
      assert.ok(
        mixed.gaps.some(
          (g) => g.kind === "dynamic-schema-field" && g.at?.line === 11,
        ),
      );

      const dict = inputFacts.find((f) => f.value.schemaName === "dictSchema");
      assert.ok(dict);
      assert.equal(dict.value.hasDynamicFields, true);
      assert.ok(
        dict.gaps.some(
          (g) => g.kind === "dynamic-schema-shape" && g.at?.line === 14,
        ),
      );

      // Report gaps also contain the dynamic gaps!
      assert.ok(report.gaps.length >= 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("loads the native package only when queried and shares cached facts across rules", async () => {
    const root = createTempProject({
      "src/zod-stub.ts": ZOD_POLYFILL_STUB,
      "src/app.ts": [
        'import { z } from "./zod-stub.js";',
        "export const itemSchema = z.object({ id: z.string(), count: z.number().default(1) });",
        "export function submit(input: unknown) {",
        "  return itemSchema.parse(input);",
        "}",
        "",
      ].join("\n"),
    });

    const unqueriedRule = defineRule({
      id: "rule-no-facts",
      run: async (ctx) => {
        await ctx.findSyntax({ kinds: ["CallExpression"] });
      },
    });

    try {
      // An installed package remains unobserved when no rule queries its facts.
      const unqueriedReport = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [unqueriedRule],
        }),
        observe: "detail",
      });
      assert.equal(
        unqueriedReport.observation?.providers.includes("zod"),
        false,
      );

      // 2. Two rules querying the same fact -> computed once, reused once!
      let ruleACount = 0;
      let ruleBCount = 0;
      const ruleA = defineRule({
        id: "rule-a",
        run: async (ctx) => {
          const facts = await ctx.facts(ValidatorInputFieldsFact, {
            condition: { scope: "calls" },
          });
          ruleACount = facts.length;
        },
      });
      const ruleB = defineRule({
        id: "rule-b",
        run: async (ctx) => {
          const facts = await ctx.facts(ValidatorInputFieldsFact, {
            condition: { scope: "calls" },
          });
          ruleBCount = facts.length;
        },
      });

      const sharedReport = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [ruleA, ruleB],
        }),
        observe: "detail",
        at: "src/app.ts:4:10",
      });
      assert.equal(ruleACount, 1);
      assert.equal(ruleBCount, 1);

      assert.ok(sharedReport.observation);
      assert.ok(sharedReport.observation.providers.includes("zod"));
      const details = sharedReport.observation.details ?? [];
      const aEntry = details.find(
        (d) =>
          d.kind === "query" && d.ruleId === "rule-a" && d.provider === "zod",
      );
      const bEntry = details.find(
        (d) =>
          d.kind === "query" && d.ruleId === "rule-b" && d.provider === "zod",
      );
      assert.equal(aEntry?.cacheStatus, "computed");
      assert.equal(aEntry?.candidateCount, 1);
      assert.equal(bEntry?.cacheStatus, "reused");
      assert.equal(bEntry?.candidateCount, 1);

      const explainA = sharedReport.explanations?.find(
        (e) => e.ruleId === "rule-a",
      );
      const explainB = sharedReport.explanations?.find(
        (e) => e.ruleId === "rule-b",
      );
      assert.ok(explainA?.providers.includes("zod"));
      assert.ok(explainB?.providers.includes("zod"));
      assert.equal(explainA?.queries[0]?.cacheStatus, "computed");
      assert.equal(explainB?.queries[0]?.cacheStatus, "reused");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("compiles an external TypeScript consumer against built @verule/sdk and @verule/adapter-zod .d.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "verule-zod-type-contract-"));
    try {
      for (const pkg of [
        { name: "@verule/sdk", dir: sdkRoot },
        { name: "@verule/adapter-zod", dir: packageRoot },
      ]) {
        const pkgOut = join(root, "node_modules", ...pkg.name.split("/"));
        mkdirSync(pkgOut, { recursive: true });
        const distSrc = join(pkg.dir, "dist");
        const distDst = join(pkgOut, "dist");
        assert.equal(
          existsSync(join(distSrc, "index.d.ts")),
          true,
          `Missing built dist/index.d.ts for ${pkg.name}`,
        );
        cpSync(distSrc, distDst, { recursive: true });
        const raw = JSON.parse(
          readFileSync(join(pkg.dir, "package.json"), "utf8"),
        ) as {
          readonly name: string;
          readonly version: string;
          readonly type: string;
          readonly publishConfig?: { readonly exports?: unknown };
        };
        writeFileSync(
          join(pkgOut, "package.json"),
          JSON.stringify(
            {
              name: raw.name,
              version: raw.version,
              type: raw.type,
              exports: raw.publishConfig?.exports ?? {
                ".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
              },
            },
            null,
            2,
          ),
          "utf8",
        );
      }

      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify(
          {
            compilerOptions: {
              strict: true,
              exactOptionalPropertyTypes: true,
              noUncheckedIndexedAccess: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
              types: [],
              noEmit: true,
            },
            include: ["src/**/*.ts"],
          },
          null,
          2,
        ),
        "utf8",
      );
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "consumer.ts"),
        [
          'import { defineConfig, defineRule } from "@verule/sdk";',
          'import { ValidatorInputFieldsFact, ValidatorOutputFieldsFact, zodAdapter } from "@verule/adapter-zod";',
          "",
          "const rule = defineRule({",
          '  id: "consumer-zod-rule",',
          "  run: async (ctx) => {",
          '    const inputs = await ctx.facts(ValidatorInputFieldsFact, { providerId: "zod" });',
          "    const outputs = await ctx.facts(ValidatorOutputFieldsFact);",
          "    for (const item of inputs) {",
          "      void item.value.requiredFields;",
          "      void item.value.defaultedFields;",
          "    }",
          "    for (const item of outputs) {",
          "      void item.value.presentFields;",
          "    }",
          "  },",
          "});",
          "",
          'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [zodAdapter], rules: [rule] });',
          "",
        ].join("\n"),
        "utf8",
      );

      execFileSync(
        tscBin,
        ["-p", join(root, "tsconfig.json"), "--pretty", "false"],
        { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("extracts real zod v4 schemas (.prefault, .catch, .default, .nullable, .transform, .pipe) and allows alternative providers to implement the same FactType", async () => {
    const root = createTempProject({
      "src/real-zod.ts": [
        'import { z } from "zod";',
        "",
        "export const realSchema = z",
        "  .object({",
        "    id: z.string(),",
        "    nullableKey: z.string().nullable(),",
        "    optKey: z.string().optional(),",
        '    prefaulted: z.string().nullable().prefault(""),',
        '    caught: z.string().catch("fallback"),',
        '    defaulted: z.string().default("v3"),',
        "  })",
        "  .transform((row) => ({ ...row }));",
        "",
        "export function validateReal(payload: unknown) {",
        "  return realSchema.safeParse(payload);",
        "}",
        "",
      ].join("\n"),
    });
    mkdirSync(join(root, "node_modules"), { recursive: true });
    symlinkSync(
      join(packageRoot, "node_modules", "zod"),
      join(root, "node_modules", "zod"),
      "dir",
    );

    let inputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];
    let outputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorOutputFieldsFactValue
    >[] = [];

    const genericValidatorRule = defineRule({
      id: "generic-validator-rule",
      run: async (ctx) => {
        inputResults = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
        outputResults = await ctx.facts(ValidatorOutputFieldsFact, {
          condition: { scope: "calls" },
        });
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [genericValidatorRule],
        }),
      });
      assert.equal(report.status, "clean");
      assert.equal(inputResults.length, 1);
      assert.deepEqual(inputResults[0]!.value.requiredFields, [
        "id",
        "nullableKey",
      ]);
      assert.deepEqual(inputResults[0]!.value.defaultedFields, [
        "caught",
        "defaulted",
        "prefaulted",
      ]);
      assert.deepEqual(outputResults[0]!.value.presentFields, [
        "caught",
        "defaulted",
        "id",
        "nullableKey",
        "prefaulted",
      ]);
      assert.deepEqual(outputResults[0]!.value.optionalFields, ["optKey"]);

      // Same rule works unchanged when an alternative validator implements ValidatorInputFieldsFact
      const altAdapter = defineAdapter({
        id: "alt-validator",
        provides: [
          {
            factType: ValidatorInputFieldsFact,
            extract: async (ctx) => {
              const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
              const safeParseCall = calls.find((c) =>
                c.text.includes("realSchema.safeParse("),
              );
              if (!safeParseCall) return [];
              return [
                {
                  subject: safeParseCall.ref,
                  value: {
                    siteKind: "call",
                    validatorMethod: "safeParse",
                    requiredFields: ["altOnly"],
                    optionalFields: [],
                    defaultedFields: [],
                    fields: {
                      altOnly: {
                        name: "altOnly",
                        requirement: "required",
                        nullable: false,
                      },
                    },
                    hasDynamicFields: false,
                  },
                },
              ];
            },
          },
        ],
      });

      await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [altAdapter],
          rules: [genericValidatorRule],
        }),
      });
      assert.equal(inputResults.length, 1);
      assert.deepEqual(inputResults[0]!.value.requiredFields, ["altOnly"]);
      assert.deepEqual(inputResults[0]!.providers, ["alt-validator"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("retains explicit .extend/.default/.pick conclusions on single-Zod drizzle-zod schemas while surfacing unresolved-schema for base table fields", async () => {
    const root = createTempProject({
      "packages/db/package.json": JSON.stringify({
        name: "@acme/db",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "packages/db/src/page.ts": [
        'import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";',
        "",
        'export const page = sqliteTable("page", {',
        '  id: integer("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  customDomain: text("custom_domain"),',
        '  password: text("password"),',
        '  accessType: text("access_type").notNull().default("public"),',
        "});",
        "",
      ].join("\n"),
      "packages/db/src/validation.ts": [
        'import { createSelectSchema } from "drizzle-zod";',
        'import { z } from "zod";',
        'import { page } from "./page.js";',
        "",
        "export const selectPageSchema = createSelectSchema(page)",
        "  .extend({",
        '    password: z.string().nullable().prefault(""),',
        '    accessType: z.enum(["public", "private"]).prefault("public"),',
        "  })",
        "  .transform((v: Record<string, unknown>) => ({ ...v }));",
        "",
      ].join("\n"),
      "packages/db/src/index.ts": [
        'export { page } from "./page.js";',
        'export { selectPageSchema } from "./validation.js";',
        "",
      ].join("\n"),
      "src/router.ts": [
        'import { selectPageSchema } from "@acme/db";',
        "",
        "const gateFieldsSchema = selectPageSchema.pick({",
        "  slug: true,",
        "  customDomain: true,",
        "  password: true,",
        "  accessType: true,",
        "});",
        "",
        "export function parseGate(input: unknown) {",
        "  return gateFieldsSchema.parse(input);",
        "}",
        "",
      ].join("\n"),
    });

    mkdirSync(join(root, "node_modules", "@acme"), { recursive: true });
    symlinkSync(
      join(root, "packages", "db"),
      join(root, "node_modules", "@acme", "db"),
      "dir",
    );
    symlinkSync(
      join(packageRoot, "node_modules", "drizzle-orm"),
      join(root, "node_modules", "drizzle-orm"),
      "dir",
    );
    symlinkSync(
      join(packageRoot, "node_modules", "drizzle-zod"),
      join(root, "node_modules", "drizzle-zod"),
      "dir",
    );
    symlinkSync(
      join(packageRoot, "node_modules", "zod"),
      join(root, "node_modules", "zod"),
      "dir",
    );

    let inputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];
    let outputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorOutputFieldsFactValue
    >[] = [];

    const rule = defineRule({
      id: "inspect-create-select-schema-single-zod",
      run: async (ctx) => {
        inputResults = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
        outputResults = await ctx.facts(ValidatorOutputFieldsFact, {
          condition: { scope: "calls" },
        });
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");
      assert.equal(inputResults.length, 1);

      const gateIn = inputResults[0]!;
      assert.equal(gateIn.value.schemaName, "gateFieldsSchema");
      // Without @verule/adapter-drizzle, base createSelectSchema(page) fields are unknown,
      // while explicit .extend() defaults/prefaults and .pick() filtering are retained!
      assert.deepEqual(gateIn.value.requiredFields, []);
      assert.deepEqual(gateIn.value.defaultedFields, [
        "accessType",
        "password",
      ]);
      assert.deepEqual(gateIn.value.optionalFields, ["accessType", "password"]);
      assert.equal(gateIn.value.hasDynamicFields, true);
      assert.ok(
        gateIn.gaps.some(
          (gap) =>
            gap.kind === "unresolved-schema" &&
            gap.at?.file === "packages/db/src/validation.ts" &&
            gap.at.line === 5,
        ),
        JSON.stringify(gateIn.gaps),
      );
      assert.ok(
        gateIn.evidence.some(
          (ev) => ev.at?.file === "packages/db/src/validation.ts",
        ),
      );

      const gateOut = outputResults[0]!;
      assert.deepEqual(gateOut.value.presentFields, ["accessType", "password"]);
      assert.deepEqual(gateOut.value.defaultedFields, [
        "accessType",
        "password",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("tracks runtime field validators as field-scoped unknowns (not requiredFields), clears superseded gaps on .extend(), and extracts ValidatorFieldFact", async () => {
    const root = createTempProject({
      "src/runtime.ts": [
        'import { z } from "zod";',
        "",
        "declare function runtimeAgeValidator(): z.ZodType<number>;",
        "const helpers = {",
        "  makeValidator: (): z.ZodType<string> => z.string(),",
        "};",
        "",
        "export const partialUnknownSchema = z.object({",
        "  id: z.string(),",
        "  age: runtimeAgeValidator(),",
        "  extra: helpers.makeValidator(),",
        "});",
        "",
        "export const overriddenSchema = partialUnknownSchema.extend({",
        "  age: z.number().default(18),",
        "  extra: z.string().optional(),",
        "});",
        "",
        "export const callbackProbe = {",
        "  directReplace: z.number().default(18),",
        "  nullableReplace: z.string().nullable(),",
        "  unknownReplace: runtimeAgeValidator(),",
        "  cbDefault: (s: z.ZodType<number>) => s.default(18),",
        "  cbOptional: (s: z.ZodType<string>) => s.optional(),",
        "  cbNullable: (s: z.ZodType<string>) => { return s.nullable(); },",
        "};",
        "",
        "export function validate(input: unknown) {",
        "  return {",
        "    partial: partialUnknownSchema.parse(input),",
        "    overridden: overriddenSchema.parse(input),",
        "  };",
        "}",
        "",
      ].join("\n"),
    });
    symlinkSync(
      join(packageRoot, "node_modules", "zod"),
      join(root, "node_modules", "zod"),
      "dir",
    );

    let inputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];
    let outputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorOutputFieldsFactValue
    >[] = [];
    let fieldFacts: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorFieldFactValue
    >[] = [];

    const rule = defineRule({
      id: "inspect-runtime-unknowns-and-field-facts",
      run: async (ctx) => {
        inputResults = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
        outputResults = await ctx.facts(ValidatorOutputFieldsFact, {
          condition: { scope: "calls" },
        });
        const props = await ctx.findSyntax({
          files: ["src/runtime.ts"],
          kinds: ["PropertyAssignment"],
        });
        const targetNames = [
          "directReplace",
          "nullableReplace",
          "unknownReplace",
          "cbDefault",
          "cbOptional",
          "cbNullable",
        ];
        const initRefs = props
          .filter((p) =>
            targetNames.some((name) => p.text.startsWith(`${name}:`)),
          )
          .map((p) => p.initializer!)
          .filter(Boolean);
        fieldFacts = await ctx.facts(ValidatorFieldFact, {
          targets: initRefs,
        });
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");

      const partialIn = inputResults.find(
        (f) => f.value.schemaName === "partialUnknownSchema",
      );
      assert.ok(partialIn);
      assert.equal(partialIn.value.hasDynamicFields, true);
      // Runtime validators MUST NOT become requiredFields!
      assert.deepEqual(partialIn.value.requiredFields, ["id"]);
      assert.equal(partialIn.value.fields.age, undefined);
      assert.equal(partialIn.value.fields.extra, undefined);
      assert.equal(partialIn.gaps.length, 2);
      assert.ok(
        partialIn.gaps.every((g) => g.kind === "unresolved-schema-field"),
      );

      const overriddenIn = inputResults.find(
        (f) => f.value.schemaName === "overriddenSchema",
      );
      const overriddenOut = outputResults.find(
        (f) => f.value.schemaName === "overriddenSchema",
      );
      assert.ok(overriddenIn && overriddenOut);
      assert.equal(overriddenIn.value.hasDynamicFields, false);
      assert.deepEqual(overriddenIn.gaps, []);
      assert.deepEqual(overriddenIn.value.requiredFields, ["id"]);
      assert.deepEqual(overriddenIn.value.defaultedFields, ["age"]);
      assert.deepEqual(overriddenIn.value.optionalFields, ["age", "extra"]);
      assert.deepEqual(overriddenOut.value.presentFields, ["age", "id"]);
      assert.deepEqual(overriddenOut.value.optionalFields, ["extra"]);

      assert.equal(fieldFacts.length, 6);
      const syntaxItems = fieldFacts;
      const byResolved = syntaxItems.filter((f) => f.value.resolved);
      const byUnresolved = syntaxItems.filter((f) => !f.value.resolved);
      assert.equal(byResolved.length, 5);
      assert.equal(byUnresolved.length, 1);
      assert.ok(
        byUnresolved[0]!.gaps.some((g) => g.kind === "unresolved-schema-field"),
      );
      assert.ok(
        byResolved.some(
          (f) =>
            f.value.mode === "callback" &&
            f.value.requirement === "defaulted" &&
            f.value.fromDefault === true &&
            f.value.nullabilityExplicit === false,
        ),
      );
      assert.ok(
        byResolved.some(
          (f) =>
            f.value.mode === "callback" &&
            f.value.requirement === "required" &&
            f.value.nullable === true &&
            f.value.nullabilityExplicit === true,
        ),
      );

      // Same-snapshot targeted explain locates unresolved field on partialUnknownSchema
      // and resolved_by_override on overriddenSchema.
      const explainSession = await openSession({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-zod"],
          rules: [rule],
        }),
      });
      try {
        await explainSession.check();
        const partialExplain = await explainSession.explain({
          ruleId: "inspect-runtime-unknowns-and-field-facts",
          at: "src/runtime.ts:30:14",
        });
        assert.ok(
          partialExplain.explanation.localGaps.some(
            (lg) =>
              lg.status === "unresolved" &&
              lg.field === "age" &&
              lg.gap.kind === "unresolved-schema-field",
          ),
          JSON.stringify(partialExplain.explanation.localGaps),
        );

        const overriddenExplain = await explainSession.explain({
          ruleId: "inspect-runtime-unknowns-and-field-facts",
          at: "src/runtime.ts:31:17",
        });
        assert.ok(
          overriddenExplain.explanation.localGaps.some(
            (lg) =>
              lg.status === "resolved_by_override" &&
              lg.field === "age" &&
              lg.resolvedBy?.operation === ".extend()" &&
              lg.resolvedBy.providerId === "zod",
          ),
          JSON.stringify(overriddenExplain.explanation.localGaps),
        );
      } finally {
        await explainSession.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("records resolved_by_override localGaps for runtimeFieldValidator().default(21), .and(), and .pipe() overrides", async () => {
    const root = createTempProject({
      "src/combinators.ts": [
        'import { z } from "zod";',
        "",
        "declare function runtimeFieldValidator(): z.ZodType<number>;",
        "",
        "export const modifierOverrideSchema = z.object({",
        "  id: z.string(),",
        "  age: runtimeFieldValidator().default(21),",
        "});",
        "",
        "export const andBaseSchema = z.object({",
        "  id: z.string(),",
        "  age: runtimeFieldValidator(),",
        "});",
        "",
        "export const andOverrideSchema = andBaseSchema.and(",
        "  z.object({ age: z.number().default(21) }),",
        ");",
        "",
        "export const pipeOverrideSchema = andBaseSchema.pipe(",
        "  z.object({ id: z.string(), age: z.number().default(21) }),",
        ");",
        "",
        "export function validateCombinators(input: unknown) {",
        "  return {",
        "    modifier: modifierOverrideSchema.parse(input),",
        "    and: andOverrideSchema.parse(input),",
        "    pipe: pipeOverrideSchema.parse(input),",
        "  };",
        "}",
        "",
      ].join("\n"),
    });
    symlinkSync(
      join(packageRoot, "node_modules", "zod"),
      join(root, "node_modules", "zod"),
      "dir",
    );

    let inputResults: readonly FactResult<
      "syntax" | "call" | "declaration",
      ValidatorInputFieldsFactValue
    >[] = [];

    const rule = defineRule({
      id: "inspect-modifier-and-combinator-overrides",
      run: async (ctx) => {
        inputResults = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
      },
    });

    const session = await openSession({
      cwd: root,
      config: defineConfig({
        tsconfig: "tsconfig.json",
        adapters: ["@verule/adapter-zod"],
        rules: [rule],
      }),
    });

    try {
      const checkReport = await session.check();
      assert.equal(checkReport.status, "clean");
      assert.deepEqual(checkReport.gaps, []);

      for (const schemaName of [
        "modifierOverrideSchema",
        "andOverrideSchema",
        "pipeOverrideSchema",
      ]) {
        const fact = inputResults.find(
          (f) => f.value.schemaName === schemaName,
        );
        assert.ok(fact, `Expected fact for ${schemaName}`);
        assert.deepEqual(fact.gaps, []);
        assert.deepEqual(fact.value.defaultedFields, ["age"]);
      }

      const modExplain = await session.explain({
        ruleId: "inspect-modifier-and-combinator-overrides",
        at: "src/combinators.ts:25:15",
      });
      assert.ok(
        modExplain.explanation.localGaps.some(
          (lg) =>
            lg.status === "resolved_by_override" &&
            lg.field === "age" &&
            lg.gap.at?.line === 7 &&
            lg.resolvedBy?.providerId === "zod" &&
            lg.resolvedBy.operation === ".default()" &&
            lg.resolvedBy.at?.line === 7,
        ),
        JSON.stringify(modExplain.explanation.localGaps),
      );

      const andExplain = await session.explain({
        ruleId: "inspect-modifier-and-combinator-overrides",
        at: "src/combinators.ts:26:10",
      });
      assert.ok(
        andExplain.explanation.localGaps.some(
          (lg) =>
            lg.status === "resolved_by_override" &&
            lg.field === "age" &&
            lg.gap.at?.line === 12 &&
            lg.resolvedBy?.providerId === "zod" &&
            lg.resolvedBy.operation === ".and()" &&
            lg.resolvedBy.at?.line === 16,
        ),
        JSON.stringify(andExplain.explanation.localGaps),
      );

      const pipeExplain = await session.explain({
        ruleId: "inspect-modifier-and-combinator-overrides",
        at: "src/combinators.ts:27:11",
      });
      assert.ok(
        pipeExplain.explanation.localGaps.some(
          (lg) =>
            lg.status === "resolved_by_override" &&
            lg.field === "age" &&
            lg.gap.at?.line === 12 &&
            lg.resolvedBy?.providerId === "zod" &&
            lg.resolvedBy.operation === ".pipe()" &&
            lg.resolvedBy.at?.line === 20,
        ),
        JSON.stringify(pipeExplain.explanation.localGaps),
      );
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
