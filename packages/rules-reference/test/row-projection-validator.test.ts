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

import { drizzleAdapter } from "@verule/adapter-drizzle";
import { zodAdapter } from "@verule/adapter-zod";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";
import { defineConfig, openSession, runCheck } from "@verule/sdk";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const sdkRoot = join(packageRoot, "node_modules", "@verule", "sdk");
const adapterZodRoot = join(
  packageRoot,
  "node_modules",
  "@verule",
  "adapter-zod",
);
const adapterDrizzleRoot = join(
  packageRoot,
  "node_modules",
  "@verule",
  "adapter-drizzle",
);
const tscBin = join(packageRoot, "node_modules", ".bin", "tsc");

const DRIZZLE_AND_ZOD_STUBS = {
  "packages/db/package.json": JSON.stringify({
    name: "@fixture/db",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./src/index.ts" },
  }),
  "packages/db/src/drizzle.ts": [
    "export type Column<T = unknown> = {",
    "  readonly _type: T;",
    "  notNull: () => Column<T>;",
    "  primaryKey: () => Column<T>;",
    "  default: (v: T) => Column<T>;",
    "};",
    "declare const col: Column<any>;",
    "export const integer = (_name?: string) => col;",
    "export const text = (_name?: string) => col;",
    "export function sqliteTable<Cols extends Record<string, unknown>>(_name: string, cols: Cols): Cols {",
    "  return cols;",
    "}",
    "export function relations<T>(_table: T, _cb: (h: { one: any; many: any }) => Record<string, unknown>) { return {}; }",
    "export function eq(_a: unknown, _b: unknown) { return {}; }",
    "export function createSelectSchema(_table: unknown): any { return {}; }",
    "export type SelectChain = {",
    "  from: (t: unknown) => SelectChain;",
    "  where: (c: unknown) => SelectChain;",
    "  get: () => Promise<Record<string, unknown> | undefined>;",
    "};",
    "export type RelQuery = {",
    "  findFirst: (opts?: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;",
    "};",
    "export declare const db: {",
    "  select: (fields?: Record<string, unknown>) => SelectChain;",
    "  query: Record<string, RelQuery>;",
    "};",
    "",
  ].join("\n"),
  "packages/validators/package.json": JSON.stringify({
    name: "@fixture/validators",
    version: "1.0.0",
    type: "module",
    exports: { ".": "./src/index.ts" },
  }),
  "packages/validators/src/zod.ts": [
    "export type ZodAnyType = {",
    "  optional: () => ZodAnyType;",
    "  nullish: () => ZodAnyType;",
    "  nullable: () => ZodAnyType;",
    "  default: (v: unknown) => ZodAnyType;",
    "  prefault: (v: unknown) => ZodAnyType;",
    "  catch: (v: unknown) => ZodAnyType;",
    "  transform: (fn: (v: never) => unknown) => ZodAnyType;",
    "  extend: (shape: Record<string, unknown>) => ZodAnyType;",
    "  pick: (mask: Record<string, boolean>) => ZodAnyType;",
    "  parse: (v: unknown) => unknown;",
    "  safeParse: (v: unknown) => { success: boolean; data?: unknown };",
    "};",
    "declare const node: ZodAnyType;",
    "export const z = {",
    "  string: () => node,",
    "  number: () => node,",
    "  enum: (_values: readonly string[]) => node,",
    "  object: (_shape: Record<string, unknown>) => node,",
    "};",
    "",
  ].join("\n"),
};

function createMonorepoFixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-rules-ref-"));
  const allFiles: Record<string, string> = {
    ...DRIZZLE_AND_ZOD_STUBS,
    ...files,
  };
  for (const [relPath, content] of Object.entries(allFiles)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }

  writeFileSync(
    join(root, "packages/db/tsconfig.json"),
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
    join(root, "packages/validators/tsconfig.json"),
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
    join(root, "packages/api/tsconfig.json"),
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

  mkdirSync(join(root, "node_modules/@fixture"), { recursive: true });
  symlinkSync(
    join(root, "packages/db"),
    join(root, "node_modules/@fixture/db"),
    "dir",
  );
  symlinkSync(
    join(root, "packages/validators"),
    join(root, "node_modules/@fixture/validators"),
    "dir",
  );

  return root;
}

void describe("@verule/rules-reference rowProjectionSatisfiesValidatorRule", () => {
  void it("covers cross-package missing field (a), complete row pass (b), defaulted field pass (c), and unrelated input non-report", async () => {
    const root = createMonorepoFixture({
      "packages/db/src/schema.ts": [
        'import { integer, sqliteTable, text } from "./drizzle.js";',
        "",
        'export const users = sqliteTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  name: text("name").notNull(),',
        '  age: integer("age").notNull(),',
        "});",
        "",
      ].join("\n"),
      "packages/db/src/queries.ts": [
        'import { db, eq } from "./drizzle.js";',
        'import { users } from "./schema.js";',
        "",
        "export async function fetchUserBrief(userId: number) {",
        "  return await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).get();",
        "}",
        "",
        "export async function fetchUserFull(userId: number) {",
        "  return await db.select({ id: users.id, name: users.name, age: users.age }).from(users).where(eq(users.id, userId)).get();",
        "}",
        "",
      ].join("\n"),
      "packages/db/src/index.ts": [
        'export { users } from "./schema.js";',
        'export { fetchUserBrief, fetchUserFull } from "./queries.js";',
        "",
      ].join("\n"),
      "packages/validators/src/index.ts": [
        'import { z } from "./zod.js";',
        "",
        "export const strictUserSchema = z.object({",
        "  id: z.number(),",
        "  name: z.string(),",
        "  age: z.number(),",
        "});",
        "",
        "export const defaultedAgeSchema = z.object({",
        "  id: z.number(),",
        "  name: z.string(),",
        "  age: z.number().prefault(18),",
        "});",
        "",
      ].join("\n"),
      "packages/api/src/handler.ts": [
        'import { fetchUserBrief, fetchUserFull } from "@fixture/db";',
        'import { defaultedAgeSchema, strictUserSchema } from "@fixture/validators";',
        "",
        "export async function handleRequests(userId: number, externalPayload: unknown) {",
        "  const brief = await fetchUserBrief(userId);",
        "  const full = await fetchUserFull(userId);",
        "",
        "  // (a) Missing age -> MUST report here with evidence to packages/db and packages/validators",
        "  const invalid = brief ? strictUserSchema.parse(brief) : null;",
        "  // (b) Complete row -> MUST pass",
        "  const valid = full ? strictUserSchema.parse(full) : null;",
        "  // (c) Defaulted/prefaulted age -> MUST pass",
        "  const defaulted = brief ? defaultedAgeSchema.parse(brief) : null;",
        "  // Unrelated input not originating from Drizzle query -> MUST NOT report",
        "  const unrelated = strictUserSchema.parse(externalPayload);",
        "",
        "  return { invalid, valid, defaulted, unrelated };",
        "}",
        "",
      ].join("\n"),
    });

    try {
      const report = await runCheck({
        cwd: root,
        adapterResolutionRoot: packageRoot,
        config: defineConfig({
          projects: [
            "packages/db/tsconfig.json",
            "packages/validators/tsconfig.json",
            "packages/api/tsconfig.json",
          ],
          adapters: [drizzleAdapter, zodAdapter],
          rules: [rowProjectionSatisfiesValidatorRule],
        }),
      });

      assert.equal(report.status, "findings");
      assert.equal(report.diagnostics.length, 1);

      const diag = report.diagnostics[0]!;
      assert.equal(diag.ruleId, "row-projection-satisfies-validator");
      assert.equal(diag.at.file, "packages/api/src/handler.ts");
      assert.equal(diag.at.line, 9);
      assert.ok(
        diag.message.includes("age"),
        `Unexpected message: ${diag.message}`,
      );

      // Evidence must trace back to Drizzle projection in packages/db, value propagation, and Zod schema in packages/validators
      assert.ok(
        diag.evidence.some(
          (ev) => ev.at?.file === "packages/db/src/queries.ts",
        ),
        "Expected evidence pointing to packages/db/src/queries.ts",
      );
      assert.ok(
        diag.evidence.some(
          (ev) => ev.at?.file === "packages/validators/src/index.ts",
        ),
        "Expected evidence pointing to packages/validators/src/index.ts",
      );
      assert.ok(
        diag.evidence.some(
          (ev) => ev.at?.file === "packages/api/src/handler.ts",
        ),
        "Expected evidence along propagation path in packages/api/src/handler.ts",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("handles dynamic query columns (d) and relational createSelectSchema + rest destructuring + live edit revocation (e)", async () => {
    const root = createMonorepoFixture({
      "packages/db/src/schema.ts": [
        'import { integer, relations, sqliteTable, text } from "./drizzle.js";',
        "",
        'export const workspace = sqliteTable("workspace", {',
        '  id: integer("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  name: text("name"),',
        '  plan: text("plan").notNull().default("free"),',
        "});",
        "",
        'export const page = sqliteTable("page", {',
        '  id: integer("id").primaryKey(),',
        '  workspaceId: integer("workspace_id").notNull(),',
        '  slug: text("slug").notNull(),',
        '  customDomain: text("custom_domain"),',
        '  password: text("password"),',
        "});",
        "",
        "export const pageRelations = relations(page, ({ one }) => ({",
        "  workspace: one(workspace),",
        "}));",
        "",
      ].join("\n"),
      "packages/db/src/validation.ts": [
        'import { createSelectSchema } from "./drizzle.js";',
        'import { page, workspace } from "./schema.js";',
        'import { z } from "../../validators/src/zod.js";',
        "",
        "export const selectWorkspaceSchema = createSelectSchema(workspace)",
        "  .extend({",
        '    plan: z.enum(["free", "pro"]).nullable().prefault("free"),',
        "    usage: z.object({ count: z.number() }).nullish(),",
        "  })",
        "  .transform((v: Record<string, unknown>) => ({ ...v }));",
        "",
        "export const selectPageSchema = createSelectSchema(page).extend({",
        '  password: z.string().nullable().prefault(""),',
        "});",
        "",
      ].join("\n"),
      "packages/db/src/index.ts": [
        'export { db, eq } from "./drizzle.js";',
        'export { page, pageRelations, workspace } from "./schema.js";',
        'export { selectPageSchema, selectWorkspaceSchema } from "./validation.js";',
        "",
      ].join("\n"),
      "packages/validators/src/index.ts": [
        'import { z } from "./zod.js";',
        "",
        "export const userAgeSchema = z.object({",
        "  id: z.number(),",
        "  age: z.number(),",
        "});",
        "",
      ].join("\n"),
      "packages/api/src/routes.ts": [
        'import { db, page, selectPageSchema, selectWorkspaceSchema } from "@fixture/db";',
        'import { userAgeSchema } from "@fixture/validators";',
        "",
        "declare function extraFields(): Record<string, unknown>;",
        "",
        "const gateFieldsSchema = selectPageSchema.pick({",
        "  slug: true,",
        "  customDomain: true,",
        "  password: true,",
        "});",
        "",
        "export async function getGate() {",
        "  const _page = await db.query.page.findFirst({",
        "    columns: {",
        "      slug: true,",
        "      customDomain: true,",
        "    },",
        "    with: { workspace: true },",
        "  });",
        "  if (!_page) return null;",
        "  const ws = selectWorkspaceSchema.safeParse(_page.workspace);",
        "  const { workspace: _ws, ...rest } = _page;",
        "  const gate = gateFieldsSchema.parse(rest);",
        "  return { ws, gate };",
        "}",
        "",
        "export async function checkDynamicAndStripped() {",
        "  const dynRow = await db.select({ id: page.id, ...extraFields() }).from(page).get();",
        "  const maybeOk = dynRow ? userAgeSchema.parse(dynRow) : null;",
        "  const { age: _strippedAge, ...withoutAge } = dynRow ?? {};",
        "  const definitelyMissing = userAgeSchema.parse(withoutAge);",
        "  return { maybeOk, definitelyMissing };",
        "}",
        "",
      ].join("\n"),
    });

    const session = await openSession({
      cwd: root,
      adapterResolutionRoot: packageRoot,
      config: defineConfig({
        projects: ["packages/db/tsconfig.json", "packages/api/tsconfig.json"],
        adapters: [drizzleAdapter, zodAdapter],
        rules: [rowProjectionSatisfiesValidatorRule],
      }),
    });

    try {
      const initial = await session.check();
      // Dynamic spread `maybeOk` has Gap (no false positive on maybeOk),
      // while `withoutAge` explicitly stripped `age` via rest destructuring -> reports at line 31!
      // Both `selectWorkspaceSchema.safeParse(_page.workspace)` and `gateFieldsSchema.parse(rest)` pass!
      assert.equal(initial.diagnostics.length, 1);
      assert.equal(
        initial.diagnostics[0]!.at.file,
        "packages/api/src/routes.ts",
      );
      assert.equal(initial.diagnostics[0]!.at.line, 31);
      assert.ok(initial.diagnostics[0]!.message.includes("age"));
      assert.ok(
        initial.gaps.some((g) => g.kind === "dynamic-query-projection"),
        "Expected dynamic-query-projection Gap to be preserved",
      );

      // Edit routes.ts: remove `slug: true,` from findFirst columns -> triggers diagnostic ONLY on gateFieldsSchema.parse(rest), NOT on selectWorkspaceSchema.safeParse(_page.workspace)!
      const routesPath = join(root, "packages/api/src/routes.ts");
      const originalRoutes = readFileSync(routesPath, "utf8");
      const brokenRoutes = originalRoutes.replace("      slug: true,\n", "");
      writeFileSync(routesPath, brokenRoutes, "utf8");
      await session.update({ changed: ["packages/api/src/routes.ts"] });

      const afterDelete = await session.check();
      const gateDiag = afterDelete.diagnostics.find(
        (d) =>
          d.at.file === "packages/api/src/routes.ts" &&
          d.message.includes("slug"),
      );
      assert.ok(
        gateDiag,
        "Expected missing slug diagnostic after deleting slug: true",
      );
      assert.equal(gateDiag.at.line, 22);
      assert.equal(
        afterDelete.diagnostics.some((d) => d.at.line === 20),
        false,
        "_page.workspace validation must NOT report when page.slug is removed",
      );

      // Restore `slug: true,` -> slug diagnostic is revoked!
      writeFileSync(routesPath, originalRoutes, "utf8");
      await session.update({ changed: ["packages/api/src/routes.ts"] });
      const afterRestore = await session.check();
      assert.equal(
        afterRestore.diagnostics.some((d) => d.message.includes("slug")),
        false,
      );
    } finally {
      await session.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("compiles an external TypeScript consumer against built @verule/rules-reference, @verule/adapter-drizzle, @verule/adapter-zod, and @verule/sdk .d.ts", () => {
    const root = mkdtempSync(join(tmpdir(), "verule-rules-ref-typecheck-"));
    try {
      for (const pkg of [
        { name: "@verule/sdk", dir: sdkRoot },
        { name: "@verule/adapter-zod", dir: adapterZodRoot },
        { name: "@verule/adapter-drizzle", dir: adapterDrizzleRoot },
        { name: "@verule/rules-reference", dir: packageRoot },
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
          'import { defineConfig } from "@verule/sdk";',
          'import { drizzleAdapter } from "@verule/adapter-drizzle";',
          'import { zodAdapter } from "@verule/adapter-zod";',
          'import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";',
          "",
          "export default defineConfig({",
          '  tsconfig: "tsconfig.json",',
          "  adapters: [drizzleAdapter, zodAdapter],",
          "  rules: [rowProjectionSatisfiesValidatorRule],",
          "});",
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
});
