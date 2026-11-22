import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  QueryRowProjectionFact,
  createDrizzleAdapter,
  createRustDrizzleAdapter,
  drizzleAdapter,
  rustDrizzleAdapter,
  type QueryRowProjectionFactValue,
} from "@verule/adapter-drizzle";
import {
  VeruleExecutionError,
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
  const root = mkdtempSync(join(tmpdir(), "verule-drizzle-facts-"));
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

const DRIZZLE_STUB = [
  "export type Column<T = unknown> = {",
  "  readonly _type: T;",
  "  notNull: () => Column<T>;",
  "  primaryKey: () => Column<T>;",
  "  default: (v: T) => Column<T>;",
  "  $defaultFn: (fn: () => T) => Column<T>;",
  "  references: (fn: () => unknown) => Column<T>;",
  "};",
  "declare const col: Column<any>;",
  "export const integer = (_name?: string, _opts?: unknown) => col;",
  "export const text = (_name?: string) => col;",
  "export const serial = (_name?: string) => col;",
  "export const varchar = (_name?: string, _opts?: unknown) => col;",
  "export type TableDef<Cols extends Record<string, unknown>> = Cols & { readonly _: { columns: Cols } };",
  "export function sqliteTable<Cols extends Record<string, unknown>>(_name: string, cols: Cols): TableDef<Cols> {",
  "  return cols as TableDef<Cols>;",
  "}",
  "export function pgTable<Cols extends Record<string, unknown>>(_name: string, cols: Cols): TableDef<Cols> {",
  "  return cols as TableDef<Cols>;",
  "}",
  "export function mysqlTable<Cols extends Record<string, unknown>>(_name: string, cols: Cols): TableDef<Cols> {",
  "  return cols as TableDef<Cols>;",
  "}",
  "export function relations<T>(_table: T, _cb: (helpers: { one: any; many: any }) => Record<string, unknown>) {",
  "  return {};",
  "}",
  "export function eq(_a: unknown, _b: unknown) { return {}; }",
  "export function getTableColumns<Cols extends Record<string, unknown>>(t: TableDef<Cols>): Cols { return t; }",
  "export type SelectChain = {",
  "  from: (table: unknown) => SelectChain;",
  "  where: (cond: unknown) => SelectChain;",
  "  limit: (n: number) => SelectChain;",
  "  get: () => Promise<Record<string, unknown> | undefined>;",
  "  all: () => Promise<Record<string, unknown>[]>;",
  "};",
  "export type RelationalQueryBuilder = {",
  "  findFirst: (opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;",
  "  findMany: (opts?: Record<string, unknown>) => Promise<Record<string, unknown>[]>;",
  "};",
  "export type DbClient = {",
  "  select: (fields?: Record<string, unknown>) => SelectChain;",
  "  query: Record<string, RelationalQueryBuilder>;",
  "};",
  "export declare const db: DbClient;",
  "",
].join("\n");

void describe("@verule/adapter-drizzle", () => {
  void it("extracts explicit .select({...}) and full-table .select().from(table) projections preserving TS property names vs SQL column names", async () => {
    const root = createTempProject({
      "src/drizzle-stub.ts": DRIZZLE_STUB,
      "src/schema.ts": [
        'import { integer, pgTable, serial, sqliteTable, text } from "./drizzle-stub.js";',
        "",
        'export const users = sqliteTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  fullName: text("full_name").notNull(),',
        '  age: integer("user_age"),',
        "});",
        "",
        'export const workspace = pgTable("workspace", {',
        '  id: serial("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  name: text("display_name"),',
        '  plan: text("plan").notNull().default("free"),',
        "});",
        "",
      ].join("\n"),
      "src/queries.ts": [
        'import { db, eq } from "./drizzle-stub.js";',
        'import { users, workspace } from "./schema.js";',
        "",
        "export async function getUserBrief() {",
        "  return await db",
        "    .select({",
        "      id: users.id,",
        "      displayName: users.fullName,",
        "    })",
        "    .from(users)",
        "    .get();",
        "}",
        "",
        "export async function getWorkspaceFull(workspaceId: number) {",
        "  return await db",
        "    .select()",
        "    .from(workspace)",
        "    .where(eq(workspace.id, workspaceId))",
        "    .get();",
        "}",
        "",
      ].join("\n"),
    });

    let facts: readonly FactResult<
      "syntax" | "call" | "declaration",
      QueryRowProjectionFactValue
    >[] = [];

    const inspectRule = defineRule({
      id: "inspect-drizzle",
      run: async (ctx) => {
        facts = await ctx.facts(QueryRowProjectionFact);
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [drizzleAdapter],
          rules: [inspectRule],
        }),
      });
      assert.equal(report.status, "clean");
      assert.equal(facts.length, 2);

      const userBrief = facts.find(
        (f) =>
          f.value.queryKind === "select" &&
          f.value.projectedColumns.includes("displayName"),
      );
      assert.ok(userBrief, "Expected explicit select projection fact");
      assert.equal(userBrief.value.library, "drizzle");
      assert.equal(userBrief.value.cardinality, "single");
      assert.equal(userBrief.value.tableName, "users");
      assert.deepEqual(userBrief.value.projectedColumns, ["displayName", "id"]);
      assert.equal(userBrief.value.columns.displayName?.sqlName, "full_name");
      assert.equal(userBrief.value.columns.id?.sqlName, "id");
      assert.equal(userBrief.value.hasDynamicColumns, false);
      assert.ok(
        userBrief.evidence.some((ev) => ev.at?.file === "src/queries.ts"),
      );
      assert.ok(
        userBrief.evidence.some((ev) => ev.at?.file === "src/schema.ts"),
      );

      const wsFull = facts.find((f) => f.value.tableName === "workspace");
      assert.ok(wsFull, "Expected full-table select projection fact");
      assert.equal(wsFull.value.cardinality, "single");
      // Must use TS property names (`name`, not SQL column name `display_name`)!
      assert.deepEqual(wsFull.value.projectedColumns, [
        "id",
        "name",
        "plan",
        "slug",
      ]);
      assert.equal(wsFull.value.columns.name?.sqlName, "display_name");
      assert.equal(wsFull.value.hasDynamicColumns, false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("extracts relational db.query.*.findFirst/findMany with whitelist, blacklist, omitted columns, and nested with relations", async () => {
    const root = createTempProject({
      "src/drizzle-stub.ts": DRIZZLE_STUB,
      "src/schema.ts": [
        'import { integer, relations, sqliteTable, text } from "./drizzle-stub.js";',
        "",
        'export const workspace = sqliteTable("workspace", {',
        '  id: integer("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  secretToken: text("secret_token").notNull(),',
        "});",
        "",
        'export const page = sqliteTable("page", {',
        '  id: integer("id").primaryKey(),',
        '  workspaceId: integer("workspace_id").notNull(),',
        '  slug: text("slug").notNull(),',
        '  customDomain: text("custom_domain"),',
        '  passwordHash: text("password_hash"),',
        "});",
        "",
        "export const pageRelations = relations(page, ({ one }) => ({",
        "  workspace: one(workspace),",
        "}));",
        "",
        "export const workspaceRelations = relations(workspace, ({ many }) => ({",
        "  pages: many(page),",
        "}));",
        "",
      ].join("\n"),
      "src/queries.ts": [
        'import { db } from "./drizzle-stub.js";',
        "",
        "export async function getGatePage() {",
        "  return await db.query.page.findFirst({",
        "    columns: {",
        "      slug: true,",
        "      customDomain: true,",
        "    },",
        "    with: {",
        "      workspace: true,",
        "    },",
        "  });",
        "}",
        "",
        "export async function listPublicPages() {",
        "  return await db.query.page.findMany({",
        "    columns: {",
        "      passwordHash: false,",
        "    },",
        "    with: {",
        "      workspace: {",
        "        columns: { id: true, slug: true },",
        "      },",
        "    },",
        "  });",
        "}",
        "",
        "export async function getAllWorkspaces() {",
        "  return await db.query.workspace.findMany();",
        "}",
        "",
      ].join("\n"),
    });

    let facts: readonly FactResult<
      "syntax" | "call" | "declaration",
      QueryRowProjectionFactValue
    >[] = [];

    const rule = defineRule({
      id: "inspect-relational",
      run: async (ctx) => {
        facts = await ctx.facts(QueryRowProjectionFact);
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [drizzleAdapter],
          rules: [rule],
        }),
      });
      assert.equal(report.status, "clean");
      assert.equal(facts.length, 3);

      const gate = facts.find(
        (f) => f.value.cardinality === "single" && f.value.tableName === "page",
      );
      assert.ok(gate);
      assert.deepEqual(gate.gaps, []);
      assert.equal(gate.value.queryKind, "relational");
      assert.deepEqual(gate.value.projectedColumns, [
        "customDomain",
        "slug",
        "workspace",
      ]);
      assert.deepEqual(Object.keys(gate.value.columns).toSorted(), [
        "customDomain",
        "slug",
      ]);
      assert.ok(gate.value.relations.workspace);
      assert.equal(gate.value.relations.workspace.cardinality, "single");
      assert.deepEqual(gate.value.relations.workspace.columns, [
        "id",
        "secretToken",
        "slug",
      ]);

      const publicPages = facts.find(
        (f) => f.value.cardinality === "many" && f.value.tableName === "page",
      );
      assert.ok(publicPages);
      assert.deepEqual(Object.keys(publicPages.value.columns).toSorted(), [
        "customDomain",
        "id",
        "slug",
        "workspaceId",
      ]);
      assert.deepEqual(publicPages.value.relations.workspace?.columns, [
        "id",
        "slug",
      ]);

      const allWorkspaces = facts.find(
        (f) => f.value.tableName === "workspace",
      );
      assert.ok(allWorkspaces);
      assert.deepEqual(allWorkspaces.value.projectedColumns, [
        "id",
        "secretToken",
        "slug",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("preserves known projected columns and emits location-aware Gaps for dynamic columns, supports getTableColumns, and checks caching/merge/types", async () => {
    const root = createTempProject({
      "src/drizzle-stub.ts": DRIZZLE_STUB,
      "src/schema.ts": [
        'import { integer, sqliteTable, text } from "./drizzle-stub.js";',
        "",
        'export const users = sqliteTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  name: text("name").notNull(),',
        '  age: integer("age"),',
        "});",
        "",
      ].join("\n"),
      "src/queries.ts": [
        'import { db, getTableColumns } from "./drizzle-stub.js";',
        'import { users } from "./schema.js";',
        "",
        "declare function extraCols(): Record<string, unknown>;",
        'const dynKey = "x" as string;',
        "",
        "export function queryMixed() {",
        "  return db.select({ id: users.id, ...extraCols(), [dynKey]: users.age }).from(users).get();",
        "}",
        "",
        "export function queryAllHelper() {",
        "  return db.select({ ...getTableColumns(users) }).from(users).get();",
        "}",
        "",
      ].join("\n"),
    });

    let extractCount = 0;
    const tracked = createDrizzleAdapter({
      onExtract: () => {
        extractCount += 1;
      },
    });

    const session = await openSession({
      cwd: root,
      config: defineConfig({
        tsconfig: "tsconfig.json",
        adapters: [tracked],
        rules: [
          defineRule({
            id: "no-facts",
            run: async (ctx) => {
              await ctx.findSyntax({ kinds: ["CallExpression"] });
            },
          }),
        ],
      }),
    });

    try {
      const unqueried = await session.check({ observe: "detail" });
      assert.equal(extractCount, 0);
      assert.equal(unqueried.observation?.providers.includes("drizzle"), false);

      let ruleAFacts: readonly FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[] = [];
      let ruleBFacts: readonly FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[] = [];

      const shared = await session.check({
        observe: "detail",
        rulesOverride: [
          defineRule({
            id: "rule-a",
            run: async (ctx) => {
              ruleAFacts = await ctx.facts(QueryRowProjectionFact);
            },
          }),
          defineRule({
            id: "rule-b",
            run: async (ctx) => {
              ruleBFacts = await ctx.facts(QueryRowProjectionFact);
            },
          }),
        ],
      });
      assert.equal(extractCount, 1);
      assert.equal(ruleAFacts.length, 2);
      assert.equal(ruleBFacts.length, 2);
      assert.ok(shared.observation?.providers.includes("drizzle"));

      const mixed = ruleAFacts.find((f) => f.value.hasDynamicColumns);
      assert.ok(mixed);
      assert.deepEqual(mixed.value.projectedColumns, ["id"]);
      assert.ok(
        mixed.gaps.some(
          (g) =>
            g.kind === "dynamic-query-projection" &&
            g.at?.file === "src/queries.ts",
        ),
      );

      const helper = ruleAFacts.find((f) => !f.value.hasDynamicColumns);
      assert.ok(helper);
      assert.deepEqual(helper.value.projectedColumns, ["age", "id", "name"]);

      // Update schema.ts and re-check -> new snapshotId and updated columns
      writeFileSync(
        join(root, "src", "schema.ts"),
        [
          'import { integer, sqliteTable, text } from "./drizzle-stub.js";',
          "",
          'export const users = sqliteTable("users", {',
          '  id: integer("id").primaryKey(),',
          '  name: text("name").notNull(),',
          '  age: integer("age"),',
          '  email: text("email"),',
          "});",
          "",
        ].join("\n"),
        "utf8",
      );
      await session.update({ changed: ["src/schema.ts"] });
      await session.check({
        rulesOverride: [
          defineRule({
            id: "rule-after-update",
            run: async (ctx) => {
              ruleAFacts = await ctx.facts(QueryRowProjectionFact);
            },
          }),
        ],
      });
      const helperAfter = ruleAFacts.find((f) => !f.value.hasDynamicColumns);
      assert.deepEqual(helperAfter?.value.projectedColumns, [
        "age",
        "email",
        "id",
        "name",
      ]);

      // Verify FactType.merge conflict detection between two providers
      const conflictAdapterA = defineAdapter({
        id: "provider-a",
        provides: [
          {
            factType: QueryRowProjectionFact,
            extract: async (ctx) => {
              const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
              const target = calls.find((c) =>
                c.text.includes("getTableColumns"),
              );
              if (!target) return [];
              return [
                {
                  subject: target.ref,
                  value: {
                    library: "drizzle",
                    queryKind: "select",
                    cardinality: "single",
                    projectedColumns: ["id"],
                    columns: {
                      id: { name: "id", sqlName: "id", kind: "tableColumn" },
                    },
                    relations: {},
                    hasDynamicColumns: false,
                  },
                },
              ];
            },
          },
        ],
      });
      const conflictAdapterB = defineAdapter({
        id: "provider-b",
        provides: [
          {
            factType: QueryRowProjectionFact,
            extract: async (ctx) => {
              const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
              const target = calls.find((c) =>
                c.text.includes("getTableColumns"),
              );
              if (!target) return [];
              return [
                {
                  subject: target.ref,
                  value: {
                    library: "drizzle",
                    queryKind: "select",
                    cardinality: "single",
                    projectedColumns: ["id"],
                    columns: {
                      id: {
                        name: "id",
                        sqlName: "user_id",
                        kind: "tableColumn",
                      },
                    },
                    relations: {},
                    hasDynamicColumns: false,
                  },
                },
              ];
            },
          },
        ],
      });

      await assert.rejects(
        () =>
          runCheck({
            cwd: root,
            config: defineConfig({
              tsconfig: "tsconfig.json",
              adapters: [conflictAdapterA, conflictAdapterB],
              rules: [
                defineRule({
                  id: "trigger-conflict",
                  run: async (ctx) => {
                    await ctx.facts(QueryRowProjectionFact);
                  },
                }),
              ],
            }),
          }),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "FACT_CONFLICT",
      );
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("compiles an external TypeScript consumer against built @verule/sdk and @verule/adapter-drizzle .d.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "verule-drizzle-type-contract-"));
    try {
      for (const pkg of [
        { name: "@verule/sdk", dir: sdkRoot },
        { name: "@verule/adapter-drizzle", dir: packageRoot },
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
          'import { QueryRowProjectionFact, createRustDrizzleAdapter, drizzleAdapter, rustDrizzleAdapter } from "@verule/adapter-drizzle";',
          "",
          "const customRust = createRustDrizzleAdapter({ id: 'custom-rust' });",
          "const rule = defineRule({",
          '  id: "consumer-drizzle-rule",',
          "  run: async (ctx) => {",
          '    const rows = await ctx.facts(QueryRowProjectionFact, { condition: { library: "drizzle" }, providerId: "drizzle-rust" });',
          "    for (const row of rows) {",
          "      void row.value.projectedColumns;",
          "      void row.value.relations;",
          "    }",
          "  },",
          "});",
          "",
          'export default defineConfig({ tsconfig: "tsconfig.json", adapters: [drizzleAdapter, rustDrizzleAdapter, customRust], rules: [rule] });',
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

  void it("extracts identical QueryRowProjectionFact values, evidence, and gaps via rustDrizzleAdapter (id: drizzle-rust) and supports zero-extraction when unqueried", async () => {
    const root = createTempProject({
      "src/drizzle-stub.ts": DRIZZLE_STUB,
      "src/schema.ts": [
        'import { integer, pgTable, relations, serial, sqliteTable, text } from "./drizzle-stub.js";',
        "",
        'export const users = sqliteTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  fullName: text("full_name").notNull(),',
        '  age: integer("user_age"),',
        "});",
        "",
        'export const workspace = pgTable("workspace", {',
        '  id: serial("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  name: text("display_name"),',
        '  plan: text("plan").notNull().default("free"),',
        "});",
        "",
        'export const page = sqliteTable("page", {',
        '  id: integer("id").primaryKey(),',
        '  workspaceId: integer("workspace_id").notNull(),',
        '  slug: text("slug").notNull(),',
        '  customDomain: text("custom_domain"),',
        "});",
        "",
        "export const pageRelations = relations(page, ({ one }) => ({",
        "  workspace: one(workspace),",
        "}));",
        "",
      ].join("\n"),
      "src/queries.ts": [
        'import { db, eq, getTableColumns } from "./drizzle-stub.js";',
        'import { users, workspace } from "./schema.js";',
        "",
        "declare function extraCols(): Record<string, unknown>;",
        "",
        "export async function getUserBrief() {",
        "  return await db",
        "    .select({",
        "      id: users.id,",
        "      displayName: users.fullName,",
        "    })",
        "    .from(users)",
        "    .get();",
        "}",
        "",
        "export async function getWorkspaceFull(workspaceId: number) {",
        "  return await db",
        "    .select()",
        "    .from(workspace)",
        "    .where(eq(workspace.id, workspaceId))",
        "    .get();",
        "}",
        "",
        "export async function getGatePage() {",
        "  return await db.query.page.findFirst({",
        "    columns: {",
        "      slug: true,",
        "      customDomain: true,",
        "    },",
        "    with: {",
        "      workspace: true,",
        "    },",
        "  });",
        "}",
        "",
        "export function getMixedAndHelper() {",
        "  const a = db.select({ id: users.id, ...extraCols() }).from(users).get();",
        "  const b = db.select({ ...getTableColumns(users) }).from(users).get();",
        "  return { a, b };",
        "}",
        "",
      ].join("\n"),
    });

    try {
      let tsFacts: readonly FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[] = [];
      let rustFacts: readonly FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[] = [];

      const tsReport = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [drizzleAdapter],
          rules: [
            defineRule({
              id: "collect-ts",
              run: async (ctx) => {
                tsFacts = await ctx.facts(QueryRowProjectionFact);
              },
            }),
          ],
        }),
        observe: "detail",
      });
      assert.equal(tsReport.status, "clean");

      let rustOnExtractCount = 0;
      const trackedRust = createRustDrizzleAdapter({
        onExtract: () => {
          rustOnExtractCount += 1;
        },
      });
      assert.equal(rustDrizzleAdapter.id, "drizzle-rust");

      const rustReport = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [trackedRust],
          rules: [
            defineRule({
              id: "collect-rust",
              run: async (ctx) => {
                rustFacts = await ctx.facts(QueryRowProjectionFact);
              },
            }),
          ],
        }),
        observe: "detail",
      });
      assert.equal(rustReport.status, "clean");
      assert.equal(rustOnExtractCount, 1);
      assert.ok(rustReport.observation?.providers.includes("drizzle-rust"));
      assert.equal(
        rustReport.observation?.engineExtractions?.["drizzle-rust"]
          ?.extractions,
        1,
      );

      assert.equal(rustFacts.length, tsFacts.length);
      const normalizeFact = (
        f: FactResult<
          "syntax" | "call" | "declaration",
          QueryRowProjectionFactValue
        >,
      ) => ({
        handleId: f.subject.handleId,
        value: f.value,
        evidence: f.evidence,
        gaps: f.gaps,
      });

      const sortKey = (v: QueryRowProjectionFactValue) =>
        [
          v.queryKind,
          v.tableName ?? "",
          v.cardinality,
          v.projectedColumns.join(","),
          String(v.hasDynamicColumns),
        ].join("|");
      const tsNormalized = tsFacts
        .map(normalizeFact)
        .toSorted((a, b) => sortKey(a.value).localeCompare(sortKey(b.value)));
      const rustNormalized = rustFacts
        .map(normalizeFact)
        .toSorted((a, b) => sortKey(a.value).localeCompare(sortKey(b.value)));

      assert.equal(rustNormalized.length, 5);
      for (let i = 0; i < tsNormalized.length; i += 1) {
        assert.deepEqual(rustNormalized[i]!.value, tsNormalized[i]!.value);
        assert.deepEqual(
          rustNormalized[i]!.evidence,
          tsNormalized[i]!.evidence,
        );
        assert.deepEqual(rustNormalized[i]!.gaps, tsNormalized[i]!.gaps);
      }

      // Unqueried check: rust extraction count MUST be 0
      rustOnExtractCount = 0;
      const unqueriedReport = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [trackedRust],
          rules: [
            defineRule({
              id: "no-fact-query",
              run: async (ctx) => {
                await ctx.findSyntax({ kinds: ["CallExpression"] });
              },
            }),
          ],
        }),
        observe: "detail",
      });
      assert.equal(unqueriedReport.status, "clean");
      assert.equal(rustOnExtractCount, 0);
      assert.equal(
        unqueriedReport.observation?.providers.includes("drizzle-rust"),
        false,
      );
      assert.equal(
        unqueriedReport.observation?.engineExtractions?.["drizzle-rust"]
          ?.extractions ?? 0,
        0,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
