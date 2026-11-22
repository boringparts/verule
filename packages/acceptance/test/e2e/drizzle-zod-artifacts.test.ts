import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  packWorkspaceArtifacts,
  startArtifactRegistry,
} from "@verule/acceptance";

const execFileAsync = promisify(execFile);
const maxOutputBytes = 16 * 1024 * 1024;

async function runCliCheck(
  veruleBin: string,
  hostDir: string,
): Promise<{
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  try {
    const res = await execFileAsync(
      veruleBin,
      ["check", "--observe", "detail", "--output", "json"],
      { cwd: hostDir, encoding: "utf8", maxBuffer: maxOutputBytes },
    );
    return { exitCode: 0, stdout: res.stdout, stderr: res.stderr };
  } catch (err: unknown) {
    const execErr = err as {
      readonly code?: number;
      readonly stdout?: string;
      readonly stderr?: string;
    };
    return {
      exitCode: execErr.code ?? 1,
      stdout: execErr.stdout ?? "",
      stderr: execErr.stderr ?? "",
    };
  }
}

void test("packs @verule/adapter-drizzle, @verule/adapter-zod, @verule/rules-reference with core packages, installs in an isolated multi-package host, and runs verule check", async () => {
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: [
      "@verule/adapter-zod",
      "@verule/adapter-drizzle",
      "@verule/rules-reference",
    ],
  });
  const registry = await startArtifactRegistry(bundle.artifacts);
  const hostDir = mkdtempSync(
    join(tmpdir(), "verule-drizzle-zod-packed-host-"),
  );

  try {
    for (const pkgName of [
      "@verule/adapter-drizzle",
      "@verule/rules-reference",
    ]) {
      const artifact = bundle.artifacts.find((a) => a.name === pkgName);
      assert.ok(artifact, `Expected packed ${pkgName} artifact`);
      const manifestExports = artifact.manifest.exports as
        | Record<string, Record<string, string>>
        | undefined;
      assert.equal(manifestExports?.["."]?.default, "./dist/index.js");
      assert.equal(manifestExports?.["."]?.types, "./dist/index.d.ts");
      assert.equal(manifestExports?.["."]?.source, undefined);
      const deps = artifact.manifest.dependencies as
        | Record<string, string>
        | undefined;
      assert.equal(deps?.["@verule/engine"], undefined);
    }

    writeFileSync(
      join(hostDir, "package.json"),
      JSON.stringify(
        {
          name: "isolated-drizzle-zod-monorepo",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "pnpm-workspace.yaml"),
      "packages:\n  - packages/*\n",
      "utf8",
    );
    writeFileSync(
      join(hostDir, ".npmrc"),
      `@verule:registry=${registry.url}/\n`,
      "utf8",
    );

    mkdirSync(join(hostDir, "packages/db/src"), { recursive: true });
    mkdirSync(join(hostDir, "packages/api/src"), { recursive: true });

    writeFileSync(
      join(hostDir, "packages/db/package.json"),
      JSON.stringify(
        {
          name: "@host/db",
          version: "1.0.0",
          private: true,
          type: "module",
          exports: { ".": "./src/index.ts" },
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "packages/api/package.json"),
      JSON.stringify(
        {
          name: "@host/api",
          version: "1.0.0",
          private: true,
          type: "module",
          dependencies: {
            "@host/db": "workspace:*",
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    const sdkArtifact = bundle.artifacts.find((a) => a.name === "@verule/sdk");
    assert.ok(sdkArtifact);

    await execFileAsync(
      "pnpm",
      [
        "add",
        "-w",
        "--save-dev",
        "--ignore-scripts",
        "--prefer-offline",
        `@verule/cli@${sdkArtifact.version}`,
        `@verule/sdk@${sdkArtifact.version}`,
        `@verule/adapter-zod@${sdkArtifact.version}`,
        `@verule/adapter-drizzle@${sdkArtifact.version}`,
        `@verule/rules-reference@${sdkArtifact.version}`,
        "zod",
      ],
      {
        cwd: hostDir,
        encoding: "utf8",
        maxBuffer: maxOutputBytes,
      },
    );

    rmSync(join(hostDir, ".npmrc"), { force: true });
    await registry.close();

    // Verify all resolved Verule packages (including transitive @verule/engine) live inside hostDir
    const hostRequire = createRequire(join(hostDir, "package.json"));
    const hostReal = realpathSync(hostDir) + sep;
    for (const pkgName of [
      "@verule/cli/package.json",
      "@verule/sdk",
      "@verule/adapter-zod",
      "@verule/adapter-drizzle",
      "@verule/rules-reference",
    ]) {
      const resolved = realpathSync(hostRequire.resolve(pkgName));
      assert.ok(
        resolved.startsWith(hostReal),
        `Expected ${pkgName} to resolve inside ${hostReal}, got ${resolved}`,
      );
    }
    const sdkRequire = createRequire(hostRequire.resolve("@verule/sdk"));
    const resolvedEngine = realpathSync(
      sdkRequire.resolve("@verule/engine/binary"),
    );
    assert.ok(
      resolvedEngine.startsWith(hostReal),
      `Expected @verule/engine/binary to resolve inside ${hostReal}, got ${resolvedEngine}`,
    );

    const hostManifest = JSON.parse(
      readFileSync(join(hostDir, "package.json"), "utf8"),
    ) as { readonly devDependencies: Record<string, string> };
    assert.equal("@verule/engine" in hostManifest.devDependencies, false);

    // Populate multi-package host TypeScript sources
    writeFileSync(
      join(hostDir, "packages/db/tsconfig.json"),
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
      join(hostDir, "packages/api/tsconfig.json"),
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
      join(hostDir, "packages/db/src/drizzle.ts"),
      [
        "export type Column<T = unknown> = {",
        "  readonly _type: T;",
        "  notNull: () => Column<T>;",
        "  primaryKey: () => Column<T>;",
        "  default: (v: T) => Column<T>;",
        "};",
        "declare const col: Column<any>;",
        "export const integer = (_name?: string) => col;",
        "export const text = (_name?: string) => col;",
        "export function sqliteTable<Cols extends Record<string, unknown>>(_name: string, cols: Cols): Cols { return cols; }",
        "export function relations<T>(_table: T, _cb: (h: { one: any; many: any }) => Record<string, unknown>) { return {}; }",
        "export function createSelectSchema(_table: unknown): any { return {}; }",
        "export type SelectChain = {",
        "  from: (t: unknown) => SelectChain;",
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
      "utf8",
    );
    writeFileSync(
      join(hostDir, "packages/db/src/schema.ts"),
      [
        'import { z } from "zod";',
        'import { createSelectSchema, integer, relations, sqliteTable, text } from "./drizzle.js";',
        "",
        'export const users = sqliteTable("users", {',
        '  id: integer("id").primaryKey(),',
        '  name: text("name").notNull(),',
        '  age: integer("user_age").notNull(),',
        "});",
        "",
        'export const workspace = sqliteTable("workspace", {',
        '  id: integer("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  plan: text("plan").notNull().default("free"),',
        "});",
        "",
        'export const page = sqliteTable("page", {',
        '  id: integer("id").primaryKey(),',
        '  slug: text("slug").notNull(),',
        '  customDomain: text("custom_domain"),',
        '  password: text("password"),',
        "});",
        "",
        "export const pageRelations = relations(page, ({ one }) => ({",
        "  workspace: one(workspace),",
        "}));",
        "",
        "export const selectWorkspaceSchema = createSelectSchema(workspace)",
        "  .extend({",
        '    plan: z.enum(["free", "pro"]).nullable().prefault("free"),',
        "  })",
        "  .transform((v: Record<string, unknown>) => ({ ...v }));",
        "",
        "export const selectPageSchema = createSelectSchema(page).extend({",
        '  password: z.string().nullable().prefault(""),',
        "});",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "packages/db/src/queries.ts"),
      [
        'import { db } from "./drizzle.js";',
        'import { users } from "./schema.js";',
        "",
        "export async function fetchUserBrief() {",
        "  return await db.select({ id: users.id, name: users.name }).from(users).get();",
        "}",
        "",
        "export async function fetchUserFull() {",
        "  return await db.select({ id: users.id, name: users.name, age: users.age }).from(users).get();",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "packages/db/src/index.ts"),
      [
        'export { db } from "./drizzle.js";',
        'export { page, pageRelations, selectPageSchema, selectWorkspaceSchema, users, workspace } from "./schema.js";',
        'export { fetchUserBrief, fetchUserFull } from "./queries.js";',
        "",
      ].join("\n"),
      "utf8",
    );

    const apiHandlerPath = join(hostDir, "packages/api/src/handler.ts");
    const initialHandlerSource = [
      'import { z } from "zod";',
      'import { db, fetchUserBrief, fetchUserFull, selectPageSchema, selectWorkspaceSchema, users } from "@host/db";',
      "",
      "declare function extraCols(): Record<string, unknown>;",
      "",
      "const strictUserSchema = z.object({",
      "  id: z.number(),",
      "  name: z.string(),",
      "  age: z.number(),",
      "});",
      "",
      "const defaultedAgeSchema = z.object({",
      "  id: z.number(),",
      "  name: z.string(),",
      "  age: z.number().prefault(18),",
      "});",
      "",
      "const gateFieldsSchema = selectPageSchema.pick({",
      "  slug: true,",
      "  customDomain: true,",
      "  password: true,",
      "});",
      "",
      "export async function runHandlers() {",
      "  const brief = await fetchUserBrief();",
      "  const full = await fetchUserFull();",
      "  const missingAge = brief ? strictUserSchema.parse(brief) : null;",
      "  const okFull = full ? strictUserSchema.parse(full) : null;",
      "  const okDefault = brief ? defaultedAgeSchema.parse(brief) : null;",
      "",
      "  const dyn = await db.select({ id: users.id, ...extraCols() }).from(users).get();",
      "  const dynCheck = dyn ? strictUserSchema.parse(dyn) : null;",
      "",
      "  const _page = await db.query.page.findFirst({",
      "    columns: {",
      "      slug: true,",
      "      customDomain: true,",
      "    },",
      "    with: { workspace: true },",
      "  });",
      "  if (!_page) return { missingAge, okFull, okDefault, dynCheck };",
      "  const ws = selectWorkspaceSchema.safeParse(_page.workspace);",
      "  const { workspace: _ws, ...rest } = _page;",
      "  const gate = gateFieldsSchema.parse(rest);",
      "  return { missingAge, okFull, okDefault, dynCheck, ws, gate };",
      "}",
      "",
    ].join("\n");
    writeFileSync(apiHandlerPath, initialHandlerSource, "utf8");

    writeFileSync(
      join(hostDir, "verule.config.mjs"),
      [
        'import { defineConfig } from "@verule/sdk";',
        'import { drizzleAdapter } from "@verule/adapter-drizzle";',
        'import { zodAdapter } from "@verule/adapter-zod";',
        'import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";',
        "",
        "export default defineConfig({",
        '  projects: ["packages/db/tsconfig.json", "packages/api/tsconfig.json"],',
        "  adapters: [drizzleAdapter, zodAdapter],",
        "  rules: [rowProjectionSatisfiesValidatorRule],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const veruleBin = join(hostDir, "node_modules", ".bin", "verule");
    assert.equal(existsSync(veruleBin), true, "Missing installed verule bin");

    const run1 = await runCliCheck(veruleBin, hostDir);
    assert.equal(
      run1.exitCode,
      1,
      `Expected exit 1 (findings), stderr: ${run1.stderr}`,
    );

    type CliJsonReport = {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly status: string;
        readonly diagnostics: readonly {
          readonly ruleId: string;
          readonly message: string;
          readonly at: { readonly file: string; readonly line: number };
          readonly evidence: readonly {
            readonly at?: { readonly file: string };
          }[];
        }[];
        readonly gaps: readonly {
          readonly kind: string;
          readonly at?: { readonly file: string };
        }[];
        readonly observation: {
          readonly providers: readonly string[];
        };
      };
    };

    const parsed1 = JSON.parse(run1.stdout) as CliJsonReport;
    assert.equal(parsed1.kind, "data");
    assert.equal(parsed1.variant, "findings");
    assert.equal(parsed1.data.diagnostics.length, 1);
    assert.equal(
      parsed1.data.diagnostics[0]!.at.file,
      "packages/api/src/handler.ts",
    );
    assert.ok(parsed1.data.diagnostics[0]!.message.includes("age"));
    assert.ok(
      parsed1.data.diagnostics[0]!.evidence.some(
        (ev) => ev.at?.file === "packages/db/src/queries.ts",
      ),
    );
    assert.ok(
      parsed1.data.diagnostics[0]!.evidence.some(
        (ev) => ev.at?.file === "packages/api/src/handler.ts",
      ),
    );
    assert.ok(
      parsed1.data.gaps.some(
        (g) =>
          g.kind === "dynamic-query-projection" &&
          g.at?.file === "packages/api/src/handler.ts",
      ),
    );
    assert.ok(parsed1.data.observation.providers.includes("drizzle"));
    assert.ok(parsed1.data.observation.providers.includes("zod"));

    // Fix brief -> fetchUserFull and remove `slug: true` from getGate -> missing slug ONLY on gateFieldsSchema.parse(rest)
    const editedSource = initialHandlerSource
      .replace(
        "  const brief = await fetchUserBrief();",
        "  const brief = await fetchUserFull();",
      )
      .replace("      slug: true,\n", "");
    writeFileSync(apiHandlerPath, editedSource, "utf8");

    const run2 = await runCliCheck(veruleBin, hostDir);
    assert.equal(
      run2.exitCode,
      1,
      `Expected exit 1 for missing slug, stderr: ${run2.stderr}`,
    );
    const parsed2 = JSON.parse(run2.stdout) as CliJsonReport;
    assert.equal(parsed2.data.diagnostics.length, 1);
    assert.ok(parsed2.data.diagnostics[0]!.message.includes("slug"));

    // Restore `slug: true` -> zero findings (exit code 0)
    const cleanSource = initialHandlerSource.replace(
      "  const brief = await fetchUserBrief();",
      "  const brief = await fetchUserFull();",
    );
    writeFileSync(apiHandlerPath, cleanSource, "utf8");

    const run3 = await runCliCheck(veruleBin, hostDir);
    assert.equal(
      run3.exitCode,
      0,
      `Expected exit 0 (clean), stderr: ${run3.stderr}`,
    );
    const parsed3 = JSON.parse(run3.stdout) as CliJsonReport;
    assert.equal(parsed3.variant, "clean");
    assert.equal(parsed3.data.diagnostics.length, 0);
  } finally {
    await registry.close().catch(() => {});
    bundle.dispose();
    rmSync(hostDir, { recursive: true, force: true });
  }
});
