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
  DrizzleTableColumnsFact,
  QueryRowProjectionFact,
  buildDrizzleTableColumnsValue,
  type DrizzleTableColumnsFactValue,
  type QueryRowProjectionFactValue,
} from "@verule/adapter-drizzle";
import {
  VeruleExecutionError,
  defineAdapter,
  defineConfig,
  defineFactProvider,
  defineRule,
  runCheck,
  type FactResult,
} from "@verule/sdk";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const drizzleOrmRoot = join(packageRoot, "node_modules", "drizzle-orm");

function createTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-drizzle-table-columns-"));
  mkdirSync(join(root, "node_modules", "@verule"), { recursive: true });
  symlinkSync(
    packageRoot,
    join(root, "node_modules", "@verule", "adapter-drizzle"),
    "dir",
  );
  symlinkSync(drizzleOrmRoot, join(root, "node_modules", "drizzle-orm"), "dir");
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

void describe("@verule/adapter-drizzle table columns facts", () => {
  void it("extracts column nullability, primary keys, defaults, and SQL names from real drizzle-orm tables alongside QueryRowProjectionFact", async () => {
    const root = createTempProject({
      "src/schema.ts": [
        'import { pgTable, serial, text, timestamp } from "drizzle-orm/pg-core";',
        'import { sqliteTable } from "drizzle-orm/sqlite-core";',
        'import { int, mysqlTable, varchar } from "drizzle-orm/mysql-core";',
        'import type { PgDatabase } from "drizzle-orm/pg-core";',
        "",
        'export const users = pgTable("users", {',
        '  id: serial("id").primaryKey(),',
        '  email: text("email").notNull(),',
        '  displayName: text("display_name"),',
        '  role: text("role").notNull().default("member"),',
        '  createdAt: timestamp("created_at").defaultNow().notNull(),',
        '  externalId: text("external_id").$defaultFn(() => "gen"),',
        "});",
        "",
        'export const sessions = sqliteTable("sessions", (t) => ({',
        '  id: t.integer("id").primaryKey(),',
        '  token: t.text("token").notNull(),',
        "}));",
        "",
        'export const auditLogs = mysqlTable("audit_logs", {',
        '  id: int("id").primaryKey(),',
        '  note: varchar("note", { length: 255 }),',
        "});",
        "",
        "declare const db: PgDatabase<never>;",
        "export function listUserEmails() {",
        "  return db.select({ id: users.id, email: users.email }).from(users);",
        "}",
        "",
      ].join("\n"),
    });

    try {
      let allTables: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let filteredTables: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let projections: readonly FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[] = [];

      const rule = defineRule({
        id: "inspect-drizzle-tables",
        run: async (ctx) => {
          allTables = await ctx.facts(DrizzleTableColumnsFact);
          filteredTables = await ctx.facts(DrizzleTableColumnsFact, {
            condition: { tableName: "users" },
          });
          projections = await ctx.facts(QueryRowProjectionFact, {
            condition: { library: "drizzle" },
          });
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
      assert.equal(allTables.length, 3);
      assert.equal(filteredTables.length, 1);

      const usersFact = filteredTables[0];
      assert.ok(usersFact);
      assert.equal(usersFact.value.library, "drizzle");
      assert.equal(usersFact.value.tableName, "users");
      assert.equal(usersFact.value.sqlTableName, "users");
      assert.equal(usersFact.value.hasDynamicColumns, false);
      assert.deepEqual(usersFact.value.columnNames, [
        "createdAt",
        "displayName",
        "email",
        "externalId",
        "id",
        "role",
      ]);

      assert.deepEqual(
        {
          sqlName: usersFact.value.columns.id?.sqlName,
          nullable: usersFact.value.columns.id?.nullable,
          primaryKey: usersFact.value.columns.id?.primaryKey,
          hasDefault: usersFact.value.columns.id?.hasDefault,
        },
        { sqlName: "id", nullable: false, primaryKey: true, hasDefault: false },
      );
      assert.deepEqual(
        {
          sqlName: usersFact.value.columns.email?.sqlName,
          nullable: usersFact.value.columns.email?.nullable,
          primaryKey: usersFact.value.columns.email?.primaryKey,
          hasDefault: usersFact.value.columns.email?.hasDefault,
        },
        {
          sqlName: "email",
          nullable: false,
          primaryKey: false,
          hasDefault: false,
        },
      );
      assert.deepEqual(
        {
          sqlName: usersFact.value.columns.displayName?.sqlName,
          nullable: usersFact.value.columns.displayName?.nullable,
          primaryKey: usersFact.value.columns.displayName?.primaryKey,
          hasDefault: usersFact.value.columns.displayName?.hasDefault,
        },
        {
          sqlName: "display_name",
          nullable: true,
          primaryKey: false,
          hasDefault: false,
        },
      );
      assert.deepEqual(
        {
          sqlName: usersFact.value.columns.role?.sqlName,
          nullable: usersFact.value.columns.role?.nullable,
          primaryKey: usersFact.value.columns.role?.primaryKey,
          hasDefault: usersFact.value.columns.role?.hasDefault,
        },
        {
          sqlName: "role",
          nullable: false,
          primaryKey: false,
          hasDefault: true,
        },
      );
      assert.deepEqual(
        {
          sqlName: usersFact.value.columns.createdAt?.sqlName,
          nullable: usersFact.value.columns.createdAt?.nullable,
          primaryKey: usersFact.value.columns.createdAt?.primaryKey,
          hasDefault: usersFact.value.columns.createdAt?.hasDefault,
        },
        {
          sqlName: "created_at",
          nullable: false,
          primaryKey: false,
          hasDefault: true,
        },
      );
      assert.deepEqual(
        {
          sqlName: usersFact.value.columns.externalId?.sqlName,
          nullable: usersFact.value.columns.externalId?.nullable,
          primaryKey: usersFact.value.columns.externalId?.primaryKey,
          hasDefault: usersFact.value.columns.externalId?.hasDefault,
        },
        {
          sqlName: "external_id",
          nullable: true,
          primaryKey: false,
          hasDefault: true,
        },
      );

      assert.ok(
        usersFact.evidence.some(
          (item) => item.kind === "source" && item.at?.file === "src/schema.ts",
        ),
      );
      assert.ok(
        usersFact.value.columns.email?.evidence?.some(
          (item) => item.kind === "source" && item.at?.file === "src/schema.ts",
        ),
      );

      const sessionsFact = allTables.find(
        (fact) => fact.value.tableName === "sessions",
      );
      assert.ok(sessionsFact);
      assert.equal(sessionsFact.value.columns.id?.primaryKey, true);
      assert.equal(sessionsFact.value.columns.id?.nullable, false);
      assert.equal(sessionsFact.value.columns.token?.nullable, false);

      const auditFact = allTables.find(
        (fact) => fact.value.tableName === "auditLogs",
      );
      assert.ok(auditFact);
      assert.equal(auditFact.value.sqlTableName, "audit_logs");
      assert.equal(auditFact.value.columns.id?.primaryKey, true);
      assert.equal(auditFact.value.columns.note?.nullable, true);

      assert.equal(projections.length, 1);
      assert.deepEqual(projections[0]?.value.projectedColumns, ["email", "id"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("preserves static columns and emits dynamic-table-columns gaps for dynamic spreads and computed keys while keeping dynamic-query-projection for select queries", async () => {
    const root = createTempProject({
      "src/dynamic-tables.ts": [
        'import { pgTable, serial, text, timestamp, type PgDatabase } from "drizzle-orm/pg-core";',
        "",
        "const sharedTimestamps = {",
        '  createdAt: timestamp("created_at").defaultNow().notNull(),',
        "};",
        "",
        "declare function extraColumns(): Record<string, ReturnType<typeof text>>;",
        'const dynamicColKey: string = "extra";',
        "",
        'export const events = pgTable("events", {',
        '  id: serial("id").primaryKey(),',
        "  ...sharedTimestamps,",
        "  ...extraColumns(),",
        '  [dynamicColKey]: text("extra"),',
        "});",
        "",
        "declare const db: PgDatabase<never>;",
        "export function queryEvents() {",
        "  return db.select({ id: events.id, [dynamicColKey]: events.createdAt }).from(events);",
        "}",
        "",
      ].join("\n"),
    });

    try {
      let tableFacts: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let queryFacts: readonly FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[] = [];

      const rule = defineRule({
        id: "inspect-dynamic-drizzle",
        run: async (ctx) => {
          tableFacts = await ctx.facts(DrizzleTableColumnsFact);
          queryFacts = await ctx.facts(QueryRowProjectionFact, {
            condition: { library: "drizzle" },
          });
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
      assert.equal(tableFacts.length, 1);
      const eventsFact = tableFacts[0];
      assert.ok(eventsFact);
      assert.equal(eventsFact.value.tableName, "events");
      assert.equal(eventsFact.value.hasDynamicColumns, true);
      assert.deepEqual(eventsFact.value.columnNames, ["createdAt", "id"]);
      assert.equal(eventsFact.value.columns.createdAt?.nullable, false);
      assert.equal(eventsFact.value.columns.createdAt?.hasDefault, true);
      assert.equal(eventsFact.gaps.length, 2);
      assert.ok(
        eventsFact.gaps.every((gap) => gap.kind === "dynamic-table-columns"),
      );

      assert.equal(queryFacts.length, 1);
      assert.equal(queryFacts[0]?.value.hasDynamicColumns, true);
      assert.deepEqual(queryFacts[0]?.value.projectedColumns, ["id"]);
      assert.ok(
        queryFacts[0]?.gaps.some(
          (gap) => gap.kind === "dynamic-query-projection",
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("resolves cross-package Drizzle table declarations for untargeted scans and targeted DeclarationRef and SyntaxRef queries", async () => {
    const root = createTempProject({
      "packages/data/package.json": JSON.stringify(
        {
          name: "@acme/data",
          version: "0.0.0",
          type: "module",
          exports: {
            ".": {
              source: "./src/index.ts",
              types: "./src/index.ts",
              default: "./src/index.ts",
            },
          },
        },
        null,
        2,
      ),
      "packages/data/src/schema.ts": [
        'import { pgTable, serial, text } from "drizzle-orm/pg-core";',
        "",
        'export const accounts = pgTable("accounts", {',
        '  id: serial("id").primaryKey(),',
        '  ownerEmail: text("owner_email").notNull(),',
        '  nickname: text("nickname").default("anon"),',
        "});",
        "",
      ].join("\n"),
      "packages/data/src/index.ts": 'export { accounts } from "./schema.ts";\n',
      "packages/app/tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2024",
            module: "NodeNext",
            moduleResolution: "NodeNext",
            customConditions: ["source"],
            skipLibCheck: true,
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "packages/app/src/consumer.ts": [
        'import { accounts } from "@acme/data";',
        "",
        "function registerTable(_table: unknown): void {}",
        "function registerOther(_value: unknown): void {}",
        'const notATable = { label: "hello" };',
        "",
        "export function init() {",
        "  registerTable(accounts);",
        "  registerOther(notATable);",
        "}",
        "",
      ].join("\n"),
    });
    mkdirSync(join(root, "node_modules", "@acme"), { recursive: true });
    symlinkSync(
      join(root, "packages", "data"),
      join(root, "node_modules", "@acme", "data"),
      "dir",
    );

    try {
      let untargetedFacts: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let bySyntaxRef: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let byDeclRef: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let byUnrelatedRef: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      let expectedArgHandleId = "";
      let expectedDeclHandleId = "";

      const rule = defineRule({
        id: "cross-package-targeted-drizzle-tables",
        run: async (ctx) => {
          untargetedFacts = await ctx.facts(DrizzleTableColumnsFact);

          const calls = await ctx.findSyntax({
            files: ["packages/app/src/consumer.ts"],
            kinds: ["CallExpression"],
          });
          const registerTableNode = calls.find((node) =>
            node.text.startsWith("registerTable("),
          );
          const registerOtherNode = calls.find((node) =>
            node.text.startsWith("registerOther("),
          );
          const tableArgRef = registerTableNode?.arguments?.[0];
          const otherArgRef = registerOtherNode?.arguments?.[0];
          assert.ok(tableArgRef);
          assert.ok(otherArgRef);
          expectedArgHandleId = tableArgRef.handleId;

          const declRows = await ctx.resolveDeclarations([tableArgRef]);
          const tableDeclRef = declRows[0]?.declaration;
          assert.ok(tableDeclRef);
          expectedDeclHandleId = tableDeclRef.handleId;

          bySyntaxRef = await ctx.facts(DrizzleTableColumnsFact, {
            targets: [tableArgRef],
          });
          byDeclRef = await ctx.facts(DrizzleTableColumnsFact, {
            targets: [tableDeclRef],
          });
          byUnrelatedRef = await ctx.facts(DrizzleTableColumnsFact, {
            targets: [otherArgRef],
          });
        },
      });

      const report = await runCheck({
        cwd: root,
        adapterResolutionRoot: root,
        config: defineConfig({
          tsconfig: "packages/app/tsconfig.json",
          adapters: ["@verule/adapter-drizzle"],
          rules: [rule],
        }),
      });

      assert.equal(report.status, "clean");
      assert.equal(untargetedFacts.length, 1);
      assert.equal(untargetedFacts[0]?.value.tableName, "accounts");

      assert.equal(bySyntaxRef.length, 1);
      assert.equal(bySyntaxRef[0]?.subject.handleId, expectedArgHandleId);
      assert.equal(bySyntaxRef[0]?.value.tableName, "accounts");
      assert.equal(bySyntaxRef[0]?.value.sqlTableName, "accounts");
      assert.deepEqual(bySyntaxRef[0]?.value.columnNames, [
        "id",
        "nickname",
        "ownerEmail",
      ]);
      assert.equal(bySyntaxRef[0]?.value.columns.ownerEmail?.nullable, false);
      assert.equal(bySyntaxRef[0]?.value.columns.nickname?.nullable, true);
      assert.equal(bySyntaxRef[0]?.value.columns.nickname?.hasDefault, true);
      assert.ok(
        bySyntaxRef[0]?.evidence.some(
          (item) => item.at?.file === "packages/data/src/schema.ts",
        ),
      );

      assert.equal(byDeclRef.length, 1);
      assert.equal(byDeclRef[0]?.subject.handleId, expectedDeclHandleId);
      assert.equal(byDeclRef[0]?.value.tableName, "accounts");
      assert.deepEqual(byDeclRef[0]?.value.columnNames, [
        "id",
        "nickname",
        "ownerEmail",
      ]);

      assert.equal(byUnrelatedRef.length, 0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("merges complementary DrizzleTableColumnsFact contributions and raises FACT_CONFLICT on column disagreements", async () => {
    const root = createTempProject({
      "src/app.ts": "export const placeholder = 1;\n",
    });

    try {
      const makeProvider = (id: string, nullable: boolean, extraCol?: string) =>
        defineAdapter({
          id,
          version: "0.0.0",
          provides: [
            defineFactProvider(DrizzleTableColumnsFact, async (ctx) => {
              const nodes = await ctx.findSyntax({
                files: ["src/app.ts"],
                kinds: ["VariableDeclaration"],
              });
              const target = nodes[0]?.ref;
              if (!target) {
                return [];
              }
              return [
                {
                  subject: target,
                  value: buildDrizzleTableColumnsValue({
                    tableName: "users",
                    sqlTableName: "users",
                    hasDynamicColumns: false,
                    columns: {
                      email: {
                        name: "email",
                        sqlName: "email",
                        nullable,
                        primaryKey: false,
                        hasDefault: false,
                      },
                      ...(extraCol !== undefined
                        ? {
                            [extraCol]: {
                              name: extraCol,
                              sqlName: extraCol,
                              nullable: true,
                              primaryKey: false,
                              hasDefault: false,
                            },
                          }
                        : {}),
                    },
                  }),
                  evidence: [],
                  gaps: [],
                },
              ];
            }),
          ],
        });

      let mergedFacts: readonly FactResult<
        "syntax" | "declaration" | "call",
        DrizzleTableColumnsFactValue
      >[] = [];
      const mergeReport = await runCheck({
        cwd: root,
        adapterResolutionRoot: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [
            makeProvider("provider-a", false),
            makeProvider("provider-b", false, "bio"),
          ],
          rules: [
            defineRule({
              id: "read-merged",
              run: async (ctx) => {
                mergedFacts = await ctx.facts(DrizzleTableColumnsFact);
              },
            }),
          ],
        }),
      });
      assert.equal(mergeReport.status, "clean");
      assert.equal(mergedFacts.length, 1);
      assert.deepEqual(mergedFacts[0]?.value.columnNames, ["bio", "email"]);

      await assert.rejects(
        () =>
          runCheck({
            cwd: root,
            adapterResolutionRoot: root,
            config: defineConfig({
              tsconfig: "tsconfig.json",
              adapters: [
                makeProvider("provider-a", false),
                makeProvider("provider-b", true),
              ],
              rules: [
                defineRule({
                  id: "read-conflict",
                  run: async (ctx) => {
                    await ctx.facts(DrizzleTableColumnsFact);
                  },
                }),
              ],
            }),
          }),
        (error: unknown) =>
          error instanceof VeruleExecutionError &&
          error.code === "FACT_CONFLICT",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
