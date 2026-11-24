import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  ValidatorSchemaFieldsFact,
  type ValidatorSchemaFieldsFactValue,
  type ValidatorSchemaSubjectKind,
} from "@verule/adapter-drizzle";
import {
  defineConfig,
  defineRule,
  runCheck,
  type FactResult,
} from "@verule/sdk";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const drizzleOrmRoot = join(packageRoot, "node_modules", "drizzle-orm");
const drizzleZodRoot = join(packageRoot, "node_modules", "drizzle-zod");
const zodRoot = join(packageRoot, "node_modules", "zod");

function createTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-drizzle-zod-"));
  mkdirSync(join(root, "node_modules", "@verule"), { recursive: true });
  symlinkSync(
    packageRoot,
    join(root, "node_modules", "@verule", "adapter-drizzle"),
    "dir",
  );
  symlinkSync(drizzleOrmRoot, join(root, "node_modules", "drizzle-orm"), "dir");
  symlinkSync(drizzleZodRoot, join(root, "node_modules", "drizzle-zod"), "dir");
  symlinkSync(zodRoot, join(root, "node_modules", "zod"), "dir");

  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2024",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          skipLibCheck: true,
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

void describe("@verule/adapter-drizzle drizzle-zod conversion", () => {
  void it("recognizes createSelectSchema and createSchemaFactory via real drizzle-zod provenance and rejects fake same-named functions", async () => {
    const root = createTempProject({
      "packages/reexport/package.json": JSON.stringify({
        name: "@acme/drizzle-helpers",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts" },
      }),
      "packages/reexport/src/index.ts": [
        'export { createSelectSchema as barrelSelect } from "drizzle-zod";',
        "",
      ].join("\n"),
      "src/local-fake.ts": [
        'import type { createSchemaFactory } from "drizzle-zod";',
        'import { z } from "zod";',
        "",
        "export function createSelectSchema(_table: unknown) {",
        "  return z.object({ localOnly: z.string() });",
        "}",
        "export const fakeFactory = {} as ReturnType<typeof createSchemaFactory>;",
        "",
      ].join("\n"),
      "src/schemas.ts": [
        'import { pgTable, serial, text } from "drizzle-orm/pg-core";',
        'import { createSchemaFactory, createSelectSchema, createSelectSchema as aliasedSelect } from "drizzle-zod";',
        'import * as dz from "drizzle-zod";',
        'import { barrelSelect } from "@acme/drizzle-helpers";',
        'import { createSelectSchema as fakeSelect, fakeFactory } from "./local-fake.js";',
        "",
        'export const accounts = pgTable("accounts", {',
        '  id: serial("id").primaryKey(),',
        '  email: text("email").notNull(),',
        '  bio: text("bio"),',
        "});",
        "",
        "const factory = createSchemaFactory();",
        "const { createSelectSchema: destructuredSelect } = createSchemaFactory();",
        "",
        "export const directSchema = createSelectSchema(accounts);",
        "export const aliasedSchema = aliasedSelect(accounts);",
        "export const namespaceSchema = dz.createSelectSchema(accounts);",
        "export const barrelSchema = barrelSelect(accounts);",
        "export const chainedFactorySchema = createSchemaFactory().createSelectSchema(accounts);",
        "export const methodFactorySchema = factory.createSelectSchema(accounts);",
        "export const destructuredFactorySchema = destructuredSelect(accounts);",
        "export const fakeDirectSchema = fakeSelect(accounts);",
        "export const fakeFactorySchema = fakeFactory.createSelectSchema(accounts);",
        "",
      ].join("\n"),
    });
    mkdirSync(join(root, "node_modules", "@acme"), { recursive: true });
    symlinkSync(
      join(root, "packages", "reexport"),
      join(root, "node_modules", "@acme", "drizzle-helpers"),
      "dir",
    );

    try {
      let schemaFacts: readonly FactResult<
        ValidatorSchemaSubjectKind,
        ValidatorSchemaFieldsFactValue
      >[] = [];

      const rule = defineRule({
        id: "inspect-drizzle-zod-provenance",
        run: async (ctx) => {
          schemaFacts = await ctx.facts(ValidatorSchemaFieldsFact);
        },
      });

      const report = await runCheck({
        cwd: root,
        adapterResolutionRoot: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-drizzle"],
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      // Exactly 7 real drizzle-zod calls; neither fakeSelect nor fakeFactory.createSelectSchema emits ValidatorSchemaFieldsFact.
      assert.equal(schemaFacts.length, 7, JSON.stringify(schemaFacts));
      for (const fact of schemaFacts) {
        assert.equal(fact.value.library, "drizzle-zod");
        assert.equal(fact.value.hasDynamicFields, false);
        assert.deepEqual(Object.keys(fact.value.fields).toSorted(), [
          "bio",
          "email",
          "id",
        ]);
        assert.equal(fact.value.fields.id?.resolved, true);
        assert.equal(fact.value.fields.id?.nullable, false);
        assert.equal(fact.value.fields.email?.nullable, false);
        assert.equal(fact.value.fields.bio?.nullable, true);
        assert.ok(fact.evidence.some((ev) => ev.at?.file === "src/schemas.ts"));
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("preserves unrefined columns and emits field-level and shape-level gaps when refinements or tables cannot be resolved standalone", async () => {
    const root = createTempProject({
      "src/table.ts": [
        'import { integer, pgTable, text } from "drizzle-orm/pg-core";',
        "",
        'export const users = pgTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  name: text("name").notNull(),',
        '  age: integer("age").notNull(),',
        '  nickname: text("nickname"),',
        "});",
        "",
      ].join("\n"),
      "src/schemas.ts": [
        'import { createSelectSchema } from "drizzle-zod";',
        'import { z } from "zod";',
        'import { users } from "./table.js";',
        "",
        "declare function extraRefines(): Record<string, z.ZodType>;",
        'const dynKey: string = "extra";',
        "",
        "export const refinedWithoutZodProvider = createSelectSchema(users, {",
        "  age: z.number().default(18),",
        "  ...extraRefines(),",
        "  [dynKey]: z.string(),",
        "});",
        "",
        "declare const externalTable: typeof users;",
        "export const unresolvedTableSchema = createSelectSchema(externalTable);",
        "",
      ].join("\n"),
    });

    try {
      let schemaFacts: readonly FactResult<
        ValidatorSchemaSubjectKind,
        ValidatorSchemaFieldsFactValue
      >[] = [];

      const rule = defineRule({
        id: "inspect-standalone-gaps",
        run: async (ctx) => {
          schemaFacts = await ctx.facts(ValidatorSchemaFieldsFact);
        },
      });

      const report = await runCheck({
        cwd: root,
        adapterResolutionRoot: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-drizzle"],
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      assert.equal(schemaFacts.length, 2);

      const refined = schemaFacts.find((f) => "id" in f.value.fields);
      const unresolvedTable = schemaFacts.find(
        (f) => !("id" in f.value.fields),
      );
      assert.ok(refined && unresolvedTable);

      assert.equal(refined.value.hasDynamicFields, true);
      assert.equal(refined.value.fields.id?.resolved, true);
      assert.equal(refined.value.fields.name?.resolved, true);
      assert.equal(refined.value.fields.nickname?.resolved, true);
      assert.equal(refined.value.fields.nickname?.nullable, true);
      // Without a validator provider enabled, refined `age` is marked unresolved while other columns stay intact
      assert.equal(refined.value.fields.age?.resolved, false);
      assert.ok(
        refined.value.fields.age?.gaps?.some(
          (g) => g.kind === "unresolved-schema-field",
        ),
      );
      assert.ok(refined.gaps.some((g) => g.kind === "dynamic-schema-spread"));
      assert.ok(refined.gaps.some((g) => g.kind === "dynamic-schema-field"));

      assert.equal(unresolvedTable.value.hasDynamicFields, true);
      assert.ok(
        unresolvedTable.gaps.some((g) => g.kind === "unresolved-drizzle-table"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
