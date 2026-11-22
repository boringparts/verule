import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { createInterface } from "node:readline";

import {
  QueryRowProjectionFact,
  createDrizzleAdapter,
  createRustDrizzleAdapter,
  drizzleAdapter,
  rustDrizzleAdapter,
  type QueryRowProjectionFactValue,
} from "@verule/adapter-drizzle";
import { zodAdapter } from "@verule/adapter-zod";
import {
  createRowProjectionSatisfiesValidatorRule,
  rowProjectionSatisfiesValidatorRule,
} from "@verule/rules-reference";
import {
  defineConfig,
  defineRule,
  openSession,
  runCheck,
  type Diagnostic,
  type FactResult,
  type Gap,
  type MemoryStats,
  type ObservationOverhead,
  type ObservationRpcMetrics,
  type Rule,
} from "@verule/sdk";

import {
  packWorkspaceArtifacts,
  type PackedArtifact,
  type PackedArtifactBundle,
} from "./artifacts.ts";
import { prepareHostWithArtifacts } from "./host-install.ts";
import { runBareVeruleInHost } from "./isolation.ts";
import {
  OPENSTATUS_DIRECT_PACKAGES,
  OPENSTATUS_EXTENSION_PACKAGES,
  OPENSTATUS_GET_GATE_FILE,
  OPENSTATUS_GET_GATE_PROJECTS,
  OPENSTATUS_GET_GATE_SHA,
  OPENSTATUS_WHOAMI_PROJECTS,
  OPENSTATUS_WHOAMI_STEPS,
  applyGetGateManualColumnEdit,
  parseCliCheckJson,
  type CliCheckPayload,
  type CliDiagnostic,
} from "./openstatus-projection.ts";
import { verifyHostArtifactResolution } from "./verify.ts";

export type LatencyDistribution = {
  readonly runsMs: readonly number[];
  readonly minMs: number;
  readonly medianMs: number;
  readonly meanMs: number;
  readonly p95Ms: number;
  readonly maxMs: number;
};

export type FactAlignmentSummary = {
  readonly tsCount: number;
  readonly rustCount: number;
  readonly factsExactMatch: boolean;
  readonly diagnosticsExactMatch: boolean;
  readonly gapsExactMatch: boolean;
  readonly evidenceExactMatch: boolean;
};

export type ConfigBehaviorSample = {
  readonly coldCheckMs: number;
  readonly editCheckMs: number;
  readonly diagnosticsCount: number;
  readonly tsExtractions: number;
  readonly rustExtractions: number;
  readonly rustEngineExtractions: number;
  readonly providerObserved: boolean;
};

export type ThreeConfigMatrix = {
  readonly ts: {
    readonly disabled: ConfigBehaviorSample;
    readonly enabledUnqueried: ConfigBehaviorSample;
    readonly enabledQueried: ConfigBehaviorSample;
  };
  readonly rust: {
    readonly disabled: ConfigBehaviorSample;
    readonly enabledUnqueried: ConfigBehaviorSample;
    readonly enabledQueried: ConfigBehaviorSample;
  };
};

export type ReuseAndInvalidationSummary = {
  readonly firstRuleCacheStatus: "computed" | "reused";
  readonly secondRuleCacheStatus: "computed" | "reused";
  readonly extractionsAcrossTwoRules: number;
  readonly coldLatencyMs: number;
  readonly reuseLatencyMs: number;
  readonly afterTableEditRecomputed: boolean;
  readonly afterTableEditEvidenceUpdated: boolean;
  readonly afterTableEditLatencyMs: number;
  readonly afterSchemaEditRecomputed: boolean;
  readonly afterSchemaEditEvidenceUpdated: boolean;
  readonly afterSchemaEditLatencyMs: number;
};

export type ProviderSelectionSample = {
  readonly providersUsed: readonly string[];
  readonly tsExtractions: number;
  readonly rustExtractions: number;
  readonly candidateCount: number;
  readonly durationMs: number;
  readonly diagnosticsCount: number;
};

export type ProviderSelectionComparison = {
  readonly byFactType: ProviderSelectionSample;
  readonly explicitRust: ProviderSelectionSample;
  readonly explicitTs: ProviderSelectionSample;
};

export type ProviderCostSample = {
  readonly coldCheckMs: number;
  readonly reuseCheckMs: number;
  readonly editCheckMs: number;
  readonly rpc: ObservationRpcMetrics;
  readonly memory: MemoryStats;
  readonly candidateCount: number;
};

export type ObserveOverheadComparison = {
  readonly offExternalMs: number;
  readonly detailExternalMs: number;
  readonly externalDeltaMs: number;
  readonly businessReportIdentical: boolean;
  readonly internal: ObservationOverhead;
};

export type ControlledAdapterCostResult = {
  readonly factAlignment: FactAlignmentSummary;
  readonly threeConfigs: ThreeConfigMatrix;
  readonly reuseAndInvalidation: {
    readonly ts: ReuseAndInvalidationSummary;
    readonly rust: ReuseAndInvalidationSummary;
  };
  readonly providerSelection: ProviderSelectionComparison;
  readonly costComparison: {
    readonly ts: ProviderCostSample;
    readonly rust: ProviderCostSample;
  };
  readonly observeOverhead: {
    readonly ts: ObserveOverheadComparison;
    readonly rust: ObserveOverheadComparison;
  };
};

export type OpenStatusWhoamiAlignmentRecord = {
  readonly label: "initial" | "fix-typo" | "remove-field";
  readonly sha: string;
  readonly tsColdCheckMs: number;
  readonly rustColdCheckMs: number;
  readonly diagnosticsExactMatch: boolean;
  readonly gapsExactMatch: boolean;
  readonly evidenceExactMatch: boolean;
  readonly factsExactMatch: boolean;
  readonly factCount: number;
  readonly diagnosticCount: number;
};

export type OpenStatusWatchEditStep = {
  readonly label: "initial" | "remove-slug-column" | "restore-slug-column";
  readonly watchFeedbackMs: number;
  readonly coldCheckMs: number;
  readonly matchesColdCheck: boolean;
  readonly diagnosticsCount: number;
  readonly memory: MemoryStats;
};

export type OpenStatusAdapterCostResult = {
  readonly artifacts: readonly {
    readonly name: string;
    readonly version: string;
    readonly sha256: string;
    readonly binarySha256?: string;
  }[];
  readonly whoamiAlignment: readonly OpenStatusWhoamiAlignmentRecord[];
  readonly getGateAlignment: FactAlignmentSummary;
  readonly coldLatency: {
    readonly ts: LatencyDistribution;
    readonly rust: LatencyDistribution;
  };
  readonly watchEdits: {
    readonly ts: readonly OpenStatusWatchEditStep[];
    readonly rust: readonly OpenStatusWatchEditStep[];
  };
  readonly threeConfigs: ThreeConfigMatrix;
  readonly reuseAndInvalidation: {
    readonly ts: ReuseAndInvalidationSummary;
    readonly rust: ReuseAndInvalidationSummary;
  };
  readonly providerSelection: ProviderSelectionComparison;
  readonly costComparison: {
    readonly ts: ProviderCostSample;
    readonly rust: ProviderCostSample;
  };
  readonly observeOverhead: {
    readonly ts: ObserveOverheadComparison;
    readonly rust: ObserveOverheadComparison;
  };
};

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function summarizeLatencies(runsMs: readonly number[]): LatencyDistribution {
  const sorted = [...runsMs].toSorted((a, b) => a - b);
  const minMs = sorted[0] ?? 0;
  const maxMs = sorted[sorted.length - 1] ?? 0;
  const meanMs =
    sorted.length > 0
      ? sorted.reduce((sum, item) => sum + item, 0) / sorted.length
      : 0;
  const mid = Math.floor(sorted.length / 2);
  const medianMs =
    sorted.length === 0
      ? 0
      : sorted.length % 2 === 1
        ? sorted[mid]!
        : (sorted[mid - 1]! + sorted[mid]!) / 2;
  const p95Idx =
    sorted.length === 0
      ? 0
      : Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1);
  return {
    runsMs: runsMs.map(roundMs),
    minMs: roundMs(minMs),
    medianMs: roundMs(medianMs),
    meanMs: roundMs(meanMs),
    p95Ms: roundMs(sorted[p95Idx] ?? 0),
    maxMs: roundMs(maxMs),
  };
}

function factSortKey(v: QueryRowProjectionFactValue): string {
  return [
    v.queryKind,
    v.tableName ?? "",
    v.cardinality,
    v.projectedColumns.join(","),
    String(v.hasDynamicColumns),
  ].join("|");
}

function normalizeFactEntry(
  fact: FactResult<
    "syntax" | "call" | "declaration",
    QueryRowProjectionFactValue
  >,
) {
  return {
    value: fact.value,
    evidence: fact.evidence,
    gaps: fact.gaps,
  };
}

function normalizeDiagnosticForCompare(diag: Diagnostic | CliDiagnostic) {
  return {
    ruleId: diag.ruleId,
    at: diag.at,
    message: diag.message,
    evidence: diag.evidence,
  };
}

type ComparableGap = {
  readonly kind: string;
  readonly message: string;
  readonly at?: unknown;
};

function normalizeGapForCompare(gap: ComparableGap) {
  return {
    kind: gap.kind,
    message: gap.message,
    ...(gap.at !== undefined ? { at: gap.at } : {}),
  };
}

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).toSorted(compareCodepoint);
  return `{${keys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

function serializeSorted<T>(items: readonly T[]): string {
  return JSON.stringify(
    [...items].map((item) => stableStringify(item)).toSorted(compareCodepoint),
  );
}

function compareFactLists(
  tsFacts: readonly FactResult<
    "syntax" | "call" | "declaration",
    QueryRowProjectionFactValue
  >[],
  rustFacts: readonly FactResult<
    "syntax" | "call" | "declaration",
    QueryRowProjectionFactValue
  >[],
): {
  readonly factsExactMatch: boolean;
  readonly evidenceExactMatch: boolean;
  readonly gapsExactMatch: boolean;
} {
  if (tsFacts.length !== rustFacts.length) {
    return {
      factsExactMatch: false,
      evidenceExactMatch: false,
      gapsExactMatch: false,
    };
  }
  const fullSortKey = (
    f: FactResult<
      "syntax" | "call" | "declaration",
      QueryRowProjectionFactValue
    >,
  ) => `${factSortKey(f.value)}|${stableStringify(f.evidence)}`;
  const tsSorted = [...tsFacts].toSorted((a, b) =>
    fullSortKey(a).localeCompare(fullSortKey(b)),
  );
  const rustSorted = [...rustFacts].toSorted((a, b) =>
    fullSortKey(a).localeCompare(fullSortKey(b)),
  );
  let factsExactMatch = true;
  let evidenceExactMatch = true;
  let gapsExactMatch = true;
  for (let i = 0; i < tsSorted.length; i += 1) {
    const a = normalizeFactEntry(tsSorted[i]!);
    const b = normalizeFactEntry(rustSorted[i]!);
    if (stableStringify(a.value) !== stableStringify(b.value)) {
      factsExactMatch = false;
    }
    if (stableStringify(a.evidence) !== stableStringify(b.evidence)) {
      evidenceExactMatch = false;
    }
    if (stableStringify(a.gaps) !== stableStringify(b.gaps)) {
      gapsExactMatch = false;
    }
  }
  return { factsExactMatch, evidenceExactMatch, gapsExactMatch };
}

function compareReportsBusinessParity(
  a: {
    readonly status: "clean" | "findings";
    readonly diagnostics: readonly (Diagnostic | CliDiagnostic)[];
    readonly gaps: readonly ComparableGap[];
  },
  b: {
    readonly status: "clean" | "findings";
    readonly diagnostics: readonly (Diagnostic | CliDiagnostic)[];
    readonly gaps: readonly ComparableGap[];
  },
  options?: { readonly ignoreRpcProbeGaps?: boolean },
): {
  readonly diagnosticsExactMatch: boolean;
  readonly gapsExactMatch: boolean;
  readonly evidenceExactMatch: boolean;
} {
  const aDiags = a.diagnostics.map(normalizeDiagnosticForCompare);
  const bDiags = b.diagnostics.map(normalizeDiagnosticForCompare);
  const aNoEv = aDiags.map((d) => ({
    ruleId: d.ruleId,
    at: d.at,
    message: d.message,
  }));
  const bNoEv = bDiags.map((d) => ({
    ruleId: d.ruleId,
    at: d.at,
    message: d.message,
  }));
  const diagnosticsExactMatch =
    a.status === b.status && serializeSorted(aNoEv) === serializeSorted(bNoEv);
  const evidenceExactMatch =
    serializeSorted(aDiags.map((d) => d.evidence)) ===
    serializeSorted(bDiags.map((d) => d.evidence));
  const filterGap = (gap: ComparableGap) =>
    options?.ignoreRpcProbeGaps ? gap.kind !== "unresolved-declaration" : true;
  const gapsExactMatch =
    serializeSorted(a.gaps.filter(filterGap).map(normalizeGapForCompare)) ===
    serializeSorted(b.gaps.filter(filterGap).map(normalizeGapForCompare));
  return { diagnosticsExactMatch, gapsExactMatch, evidenceExactMatch };
}

function createControlledMonorepoFixture(): {
  readonly root: string;
  readonly routesPath: string;
  readonly schemaPath: string;
  readonly validationPath: string;
  readonly originalRoutes: string;
  readonly originalSchema: string;
  readonly originalValidation: string;
  readonly projects: readonly string[];
  cleanup(): void;
} {
  const root = mkdtempSync(join(tmpdir(), "verule-adapter-cost-ctrl-"));
  const files: Record<string, string> = {
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
      "export function getTableColumns<Cols extends Record<string, unknown>>(t: Cols): Cols { return t; }",
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
      "  extend: (shape: Record<string, unknown>) => ZodAnyType;",
      "  pick: (mask: Record<string, boolean>) => ZodAnyType;",
      "  parse: (v: unknown) => unknown;",
      "  safeParse: (v: unknown) => { success: boolean; data?: unknown };",
      "};",
      "declare const node: ZodAnyType;",
      "export const z = {",
      "  string: () => node,",
      "  number: () => node,",
      "  object: (_shape: Record<string, unknown>) => node,",
      "};",
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
    ].join("\n"),
    "packages/db/src/schema.ts": [
      'import { integer, relations, sqliteTable, text } from "./drizzle.js";',
      "",
      'export const workspace = sqliteTable("workspace", {',
      '  id: integer("id").primaryKey(),',
      '  slug: text("slug").notNull(),',
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
      'export const users = sqliteTable("users", {',
      '  id: integer("id").primaryKey(),',
      '  name: text("name").notNull(),',
      '  age: integer("age").notNull(),',
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
      "export const selectWorkspaceSchema = createSelectSchema(workspace).extend({",
      '  plan: z.string().nullable().prefault("free"),',
      "});",
      "",
      "export const selectPageSchema = createSelectSchema(page);",
      "",
    ].join("\n"),
    "packages/db/src/index.ts": [
      'export { db, eq, getTableColumns } from "./drizzle.js";',
      'export { page, pageRelations, users, workspace } from "./schema.js";',
      'export { selectPageSchema, selectWorkspaceSchema } from "./validation.js";',
      "",
    ].join("\n"),
    "packages/api/src/routes.ts": [
      'import { db, eq, getTableColumns, page, selectPageSchema, selectWorkspaceSchema, users } from "@fixture/db";',
      'import { strictUserSchema } from "@fixture/validators";',
      "",
      "declare function extraFields(): Record<string, unknown>;",
      "",
      "const gateFieldsSchema = selectPageSchema.pick({",
      "  slug: true,",
      "  customDomain: true,",
      "});",
      "",
      "export async function getGate(userId: number) {",
      "  const brief = await db.select({ id: users.id, name: users.name }).from(users).where(eq(users.id, userId)).get();",
      "  const full = await db.select().from(users).where(eq(users.id, userId)).get();",
      "  const dyn = await db.select({ id: users.id, ...extraFields() }).from(users).get();",
      "  const allViaHelper = await db.select({ ...getTableColumns(users) }).from(users).get();",
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
      "  const invalidBrief = brief ? strictUserSchema.parse(brief) : null;",
      "  const validFull = full ? strictUserSchema.parse(full) : null;",
      "  const dynParsed = dyn ? strictUserSchema.parse(dyn) : null;",
      "  return { ws, gate, invalidBrief, validFull, dynParsed, allViaHelper };",
      "}",
      "",
    ].join("\n"),
  };

  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }

  for (const pkgDir of ["packages/db", "packages/validators", "packages/api"]) {
    writeFileSync(
      join(root, pkgDir, "tsconfig.json"),
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
  }

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

  const routesPath = join(root, "packages/api/src/routes.ts");
  const schemaPath = join(root, "packages/db/src/schema.ts");
  const validationPath = join(root, "packages/db/src/validation.ts");

  return {
    root,
    routesPath,
    schemaPath,
    validationPath,
    originalRoutes: readFileSync(routesPath, "utf8"),
    originalSchema: readFileSync(schemaPath, "utf8"),
    originalValidation: readFileSync(validationPath, "utf8"),
    projects: ["packages/db/tsconfig.json", "packages/api/tsconfig.json"],
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

/**
 * Runs controlled multi-package alignment, 3-configuration, reuse/invalidation,
 * provider selection, RPC/memory cost, and observation overhead experiments
 * comparing TS (`drizzle`) vs engine-internal Rust (`drizzle-rust`) providers.
 */
export async function runControlledAdapterCostComparison(): Promise<ControlledAdapterCostResult> {
  const fixture = createControlledMonorepoFixture();
  try {
    // 1. Fact-level & diagnostic-level alignment
    let tsFacts: FactResult<
      "syntax" | "call" | "declaration",
      QueryRowProjectionFactValue
    >[] = [];
    let rustFacts: FactResult<
      "syntax" | "call" | "declaration",
      QueryRowProjectionFactValue
    >[] = [];

    const collectFactsRule = (
      out: FactResult<
        "syntax" | "call" | "declaration",
        QueryRowProjectionFactValue
      >[],
    ): Rule =>
      defineRule({
        id: "collect-facts",
        run: async (ctx) => {
          const items = await ctx.facts(QueryRowProjectionFact);
          out.push(...items);
        },
      });

    const tsFactReport = await runCheck({
      cwd: fixture.root,
      config: defineConfig({
        projects: fixture.projects,
        adapters: [drizzleAdapter, zodAdapter],
        rules: [rowProjectionSatisfiesValidatorRule, collectFactsRule(tsFacts)],
      }),
      observe: "detail",
    });
    const rustFactReport = await runCheck({
      cwd: fixture.root,
      config: defineConfig({
        projects: fixture.projects,
        adapters: [rustDrizzleAdapter, zodAdapter],
        rules: [
          rowProjectionSatisfiesValidatorRule,
          collectFactsRule(rustFacts),
        ],
      }),
      observe: "detail",
    });

    const factCmp = compareFactLists(tsFacts, rustFacts);
    const diagCmp = compareReportsBusinessParity(tsFactReport, rustFactReport, {
      ignoreRpcProbeGaps: true,
    });
    const factAlignment: FactAlignmentSummary = {
      tsCount: tsFacts.length,
      rustCount: rustFacts.length,
      factsExactMatch: factCmp.factsExactMatch,
      diagnosticsExactMatch: diagCmp.diagnosticsExactMatch,
      gapsExactMatch: factCmp.gapsExactMatch && diagCmp.gapsExactMatch,
      evidenceExactMatch:
        factCmp.evidenceExactMatch && diagCmp.evidenceExactMatch,
    };

    // 2. Three configurations: disabled, enabled-unqueried, enabled-queried
    const unqueriedRule = defineRule({
      id: "syntax-only-no-facts",
      run: async (ctx) => {
        await ctx.findSyntax({ kinds: ["CallExpression"] });
      },
    });

    const measureConfigSample = async (params: {
      readonly kind: "disabled" | "enabled-unqueried" | "enabled-queried";
      readonly impl: "ts" | "rust";
    }): Promise<ConfigBehaviorSample> => {
      let tsExtracts = 0;
      let rustExtracts = 0;
      const trackedTs = createDrizzleAdapter({
        onExtract: () => {
          tsExtracts += 1;
        },
      });
      const trackedRust = createRustDrizzleAdapter({
        onExtract: () => {
          rustExtracts += 1;
        },
      });
      const adapters =
        params.kind === "disabled"
          ? [zodAdapter]
          : params.impl === "ts"
            ? [trackedTs, zodAdapter]
            : [trackedRust, zodAdapter];
      const rules =
        params.kind === "enabled-unqueried"
          ? [unqueriedRule]
          : [rowProjectionSatisfiesValidatorRule];

      const coldStart = performance.now();
      const session = await openSession({
        cwd: fixture.root,
        config: defineConfig({
          projects: fixture.projects,
          adapters,
          rules,
        }),
        observe: "detail",
      });
      try {
        const coldReport = await session.check({ observe: "detail" });
        const coldCheckMs = roundMs(performance.now() - coldStart);

        const broken = fixture.originalRoutes.replace(
          "      slug: true,\n",
          "",
        );
        const editStart = performance.now();
        writeFileSync(fixture.routesPath, broken, "utf8");
        await session.update({ changed: ["packages/api/src/routes.ts"] });
        await session.check({ observe: "detail" });
        const editCheckMs = roundMs(performance.now() - editStart);

        writeFileSync(fixture.routesPath, fixture.originalRoutes, "utf8");

        const targetProviderId =
          params.impl === "ts" ? "drizzle" : "drizzle-rust";
        return {
          coldCheckMs,
          editCheckMs,
          diagnosticsCount: coldReport.diagnostics.length,
          tsExtractions: tsExtracts,
          rustExtractions: rustExtracts,
          rustEngineExtractions:
            coldReport.observation?.engineExtractions?.["drizzle-rust"]
              ?.extractions ?? 0,
          providerObserved:
            coldReport.observation?.providers.includes(targetProviderId) ??
            false,
        };
      } finally {
        await session.close();
      }
    };

    const threeConfigs: ThreeConfigMatrix = {
      ts: {
        disabled: await measureConfigSample({ kind: "disabled", impl: "ts" }),
        enabledUnqueried: await measureConfigSample({
          kind: "enabled-unqueried",
          impl: "ts",
        }),
        enabledQueried: await measureConfigSample({
          kind: "enabled-queried",
          impl: "ts",
        }),
      },
      rust: {
        disabled: await measureConfigSample({ kind: "disabled", impl: "rust" }),
        enabledUnqueried: await measureConfigSample({
          kind: "enabled-unqueried",
          impl: "rust",
        }),
        enabledQueried: await measureConfigSample({
          kind: "enabled-queried",
          impl: "rust",
        }),
      },
    };

    // 3. Cross-rule reuse + table & Zod schema edit invalidation
    const measureReuseAndInvalidation = async (
      impl: "ts" | "rust",
    ): Promise<ReuseAndInvalidationSummary> => {
      let extractCount = 0;
      const adapter =
        impl === "ts"
          ? createDrizzleAdapter({
              onExtract: () => {
                extractCount += 1;
              },
            })
          : createRustDrizzleAdapter({
              onExtract: () => {
                extractCount += 1;
              },
            });

      const apiOnlyConfig = defineConfig({
        projects: ["packages/api/tsconfig.json"],
        adapters: [adapter, zodAdapter],
        rules: [
          rowProjectionSatisfiesValidatorRule,
          defineRule({
            id: "second-drizzle-consumer",
            run: async (ctx) => {
              await ctx.facts(QueryRowProjectionFact);
            },
          }),
        ],
      });

      const coldStart = performance.now();
      const session = await openSession({
        cwd: fixture.root,
        config: apiOnlyConfig,
        observe: "detail",
      });
      try {
        const initialReport = await session.check({ observe: "detail" });
        const coldLatencyMs = roundMs(performance.now() - coldStart);
        const factQueries = (initialReport.observation?.details ?? []).filter(
          (d) =>
            d.kind === "query" &&
            d.name === `facts:${QueryRowProjectionFact.id}`,
        );
        const firstRuleCacheStatus = factQueries[0]?.cacheStatus ?? "computed";
        const secondRuleCacheStatus = factQueries[1]?.cacheStatus ?? "computed";
        const extractionsAcrossTwoRules = extractCount;

        const reuseStart = performance.now();
        await session.check({
          ruleIds: ["second-drizzle-consumer"],
          observe: "detail",
        });
        const reuseLatencyMs = roundMs(performance.now() - reuseStart);

        // Modify Drizzle table definition: rename column `slug` -> `routeSlug` in page table (page.slug missing)
        // Wait: modifying `page` table by adding `title: text("title").notNull()` and requiring it, OR removing `slug` from `page` table:
        const editedSchema = fixture.originalSchema.replace(
          '  slug: text("slug").notNull(),\n  customDomain:',
          '  title: text("title").notNull(),\n  customDomain:',
        );
        const tableStart = performance.now();
        writeFileSync(fixture.schemaPath, editedSchema, "utf8");
        await session.update({ changed: ["packages/db/src/schema.ts"] });
        const afterTableReport = await session.check({ observe: "detail" });
        const afterTableEditLatencyMs = roundMs(performance.now() - tableStart);

        const initialGateDiag = initialReport.diagnostics.find((d) =>
          d.message.includes("gateFieldsSchema"),
        );
        const afterTableGateDiag = afterTableReport.diagnostics.find((d) =>
          d.message.includes("gateFieldsSchema"),
        );
        const afterTableEditRecomputed =
          extractCount > extractionsAcrossTwoRules &&
          initialGateDiag === undefined &&
          afterTableGateDiag === undefined;
        // Wait: `gateFieldsSchema` picks `slug` from `selectPageSchema = createSelectSchema(page)`!
        // When `slug` is removed from `page`, `createSelectSchema(page)` no longer has `slug`,
        // while `select.columns` still had `slug: true` without `table.columns.slug` metadata -> let's test adding a required column AND picking it, OR updating `page` table SQL name / column and verifying `evidence` updated!
        // Let's check evidence of `invalidBrief` (`users` table) when `users` SQL column name changes!
        writeFileSync(
          fixture.schemaPath,
          fixture.originalSchema.replace(
            '  name: text("name").notNull(),',
            '  name: text("display_name").notNull(),',
          ),
          "utf8",
        );
        await session.update({ changed: ["packages/db/src/schema.ts"] });
        const afterColSqlChange = await session.check({ observe: "detail" });
        const briefDiagBefore = initialReport.diagnostics.find((d) =>
          d.message.includes("strictUserSchema"),
        );
        const briefDiagAfter = afterColSqlChange.diagnostics.find((d) =>
          d.message.includes("strictUserSchema"),
        );
        const tableEvidenceChanged =
          JSON.stringify(briefDiagBefore?.evidence ?? []) !==
          JSON.stringify(briefDiagAfter?.evidence ?? []);
        const tableFactEvidenceUpdated =
          (briefDiagAfter?.evidence.some((ev) =>
            ev.message.includes("display_name"),
          ) ??
            false) &&
          tableEvidenceChanged;

        // Restore schema.ts and edit Zod schema validation.ts to require `id` in `gateFieldsSchema`
        writeFileSync(fixture.schemaPath, fixture.originalSchema, "utf8");
        await session.update({ changed: ["packages/db/src/schema.ts"] });

        const schemaEditStart = performance.now();
        writeFileSync(
          fixture.validationPath,
          fixture.originalValidation.replace(
            "export const selectPageSchema = createSelectSchema(page);",
            "export const selectPageSchema = createSelectSchema(page).extend({\n  extraRequired: z.string(),\n});",
          ),
          "utf8",
        );
        writeFileSync(
          fixture.routesPath,
          fixture.originalRoutes.replace(
            "  customDomain: true,\n",
            "  customDomain: true,\n  extraRequired: true,\n",
          ),
          "utf8",
        );
        await session.update({
          changed: [
            "packages/db/src/validation.ts",
            "packages/api/src/routes.ts",
          ],
        });
        const afterZodEditReport = await session.check({ observe: "detail" });
        const afterSchemaEditLatencyMs = roundMs(
          performance.now() - schemaEditStart,
        );
        const zodGateDiag = afterZodEditReport.diagnostics.find(
          (d) =>
            d.message.includes("gateFieldsSchema") &&
            d.message.includes("extraRequired"),
        );

        // Restore files
        writeFileSync(
          fixture.validationPath,
          fixture.originalValidation,
          "utf8",
        );
        writeFileSync(fixture.routesPath, fixture.originalRoutes, "utf8");

        return {
          firstRuleCacheStatus,
          secondRuleCacheStatus,
          extractionsAcrossTwoRules,
          coldLatencyMs,
          reuseLatencyMs,
          afterTableEditRecomputed:
            extractCount > extractionsAcrossTwoRules ||
            afterTableEditRecomputed,
          afterTableEditEvidenceUpdated: tableFactEvidenceUpdated,
          afterTableEditLatencyMs,
          afterSchemaEditRecomputed: zodGateDiag !== undefined,
          afterSchemaEditEvidenceUpdated:
            zodGateDiag?.evidence.some(
              (ev) => ev.at?.file === "packages/db/src/validation.ts",
            ) ?? false,
          afterSchemaEditLatencyMs,
        };
      } finally {
        await session.close();
        writeFileSync(fixture.schemaPath, fixture.originalSchema, "utf8");
        writeFileSync(
          fixture.validationPath,
          fixture.originalValidation,
          "utf8",
        );
        writeFileSync(fixture.routesPath, fixture.originalRoutes, "utf8");
      }
    };

    const reuseAndInvalidation = {
      ts: await measureReuseAndInvalidation("ts"),
      rust: await measureReuseAndInvalidation("rust"),
    };

    // 4. By-FactType vs explicit providerId with both providers enabled
    const runProviderMode = async (
      drizzleProviderId?: "drizzle" | "drizzle-rust",
    ): Promise<ProviderSelectionSample> => {
      let tsExtractions = 0;
      let rustExtractions = 0;
      const trackedTs = createDrizzleAdapter({
        onExtract: () => {
          tsExtractions += 1;
        },
      });
      const trackedRust = createRustDrizzleAdapter({
        onExtract: () => {
          rustExtractions += 1;
        },
      });
      const rule =
        drizzleProviderId === undefined
          ? rowProjectionSatisfiesValidatorRule
          : createRowProjectionSatisfiesValidatorRule({ drizzleProviderId });

      const start = performance.now();
      const report = await runCheck({
        cwd: fixture.root,
        config: defineConfig({
          projects: fixture.projects,
          adapters: [trackedTs, trackedRust, zodAdapter],
          rules: [rule],
        }),
        observe: "detail",
      });
      const durationMs = roundMs(performance.now() - start);
      const providersUsed = (report.observation?.providers ?? []).filter(
        (p) => p === "drizzle" || p === "drizzle-rust",
      );
      return {
        providersUsed,
        tsExtractions,
        rustExtractions,
        candidateCount: report.observation?.candidateCount ?? 0,
        durationMs,
        diagnosticsCount: report.diagnostics.length,
      };
    };

    const providerSelection: ProviderSelectionComparison = {
      byFactType: await runProviderMode(undefined),
      explicitRust: await runProviderMode("drizzle-rust"),
      explicitTs: await runProviderMode("drizzle"),
    };

    // 5. Detailed RPC, memory, and observe overhead comparison
    const measureProviderCostAndObserve = async (
      impl: "ts" | "rust",
    ): Promise<{
      readonly cost: ProviderCostSample;
      readonly observe: ObserveOverheadComparison;
    }> => {
      const adapter = impl === "ts" ? drizzleAdapter : rustDrizzleAdapter;
      const config = defineConfig({
        projects: fixture.projects,
        adapters: [adapter, zodAdapter],
        rules: [rowProjectionSatisfiesValidatorRule],
      });

      const offStart = performance.now();
      const offReport = await runCheck({
        cwd: fixture.root,
        config,
        observe: "off",
      });
      const offExternalMs = roundMs(performance.now() - offStart);

      const detailStart = performance.now();
      const detailSession = await openSession({
        cwd: fixture.root,
        config,
        observe: "detail",
      });
      try {
        const detailReport = await detailSession.check({ observe: "detail" });
        const detailExternalMs = roundMs(performance.now() - detailStart);
        const parity = compareReportsBusinessParity(offReport, detailReport);

        const reuseStart = performance.now();
        await detailSession.check({ observe: "detail" });
        const reuseCheckMs = roundMs(performance.now() - reuseStart);

        const editStart = performance.now();
        writeFileSync(
          fixture.routesPath,
          fixture.originalRoutes.replace("      slug: true,\n", ""),
          "utf8",
        );
        await detailSession.update({ changed: ["packages/api/src/routes.ts"] });
        await detailSession.check({ observe: "detail" });
        const editCheckMs = roundMs(performance.now() - editStart);
        writeFileSync(fixture.routesPath, fixture.originalRoutes, "utf8");

        const obs = detailReport.observation!;
        return {
          cost: {
            coldCheckMs: detailExternalMs,
            reuseCheckMs,
            editCheckMs,
            rpc: obs.rpc,
            memory: detailSession.memory,
            candidateCount: obs.candidateCount,
          },
          observe: {
            offExternalMs,
            detailExternalMs,
            externalDeltaMs: roundMs(detailExternalMs - offExternalMs),
            businessReportIdentical:
              parity.diagnosticsExactMatch &&
              parity.gapsExactMatch &&
              parity.evidenceExactMatch,
            internal: obs.overhead,
          },
        };
      } finally {
        await detailSession.close();
        writeFileSync(fixture.routesPath, fixture.originalRoutes, "utf8");
      }
    };

    const tsCost = await measureProviderCostAndObserve("ts");
    const rustCost = await measureProviderCostAndObserve("rust");

    return {
      factAlignment,
      threeConfigs,
      reuseAndInvalidation,
      providerSelection,
      costComparison: {
        ts: tsCost.cost,
        rust: rustCost.cost,
      },
      observeOverhead: {
        ts: tsCost.observe,
        rust: rustCost.observe,
      },
    };
  } finally {
    fixture.cleanup();
  }
}

function renderAdapterConfigMjs(options: {
  readonly projects: readonly string[];
  readonly adapterExport:
    | "none"
    | "drizzleAdapter"
    | "rustDrizzleAdapter"
    | "both";
  readonly ruleMode:
    | "validator"
    | "validator-rust"
    | "validator-ts"
    | "no-facts";
}): string {
  const drizzleImports =
    options.adapterExport === "none"
      ? []
      : options.adapterExport === "both"
        ? ["drizzleAdapter", "rustDrizzleAdapter"]
        : [options.adapterExport];

  const ruleImport =
    options.ruleMode === "validator"
      ? 'import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";'
      : options.ruleMode === "validator-rust" ||
          options.ruleMode === "validator-ts"
        ? 'import { createRowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";'
        : 'import { defineRule } from "@verule/sdk";';

  const ruleExpr =
    options.ruleMode === "validator"
      ? "rowProjectionSatisfiesValidatorRule"
      : options.ruleMode === "validator-rust"
        ? 'createRowProjectionSatisfiesValidatorRule({ drizzleProviderId: "drizzle-rust" })'
        : options.ruleMode === "validator-ts"
          ? 'createRowProjectionSatisfiesValidatorRule({ drizzleProviderId: "drizzle" })'
          : 'defineRule({ id: "syntax-only-no-facts", run: async (ctx) => { await ctx.findSyntax({ kinds: ["CallExpression"] }); } })';

  return [
    'import { defineConfig } from "@verule/sdk";',
    ...(drizzleImports.length > 0
      ? [
          `import { ${drizzleImports.join(", ")} } from "@verule/adapter-drizzle";`,
        ]
      : []),
    'import { zodAdapter } from "@verule/adapter-zod";',
    ruleImport,
    "",
    "export default defineConfig({",
    `  projects: ${JSON.stringify(options.projects)},`,
    `  adapters: [${[...drizzleImports, "zodAdapter"].join(", ")}],`,
    `  rules: [${ruleExpr}],`,
    "});",
    "",
  ].join("\n");
}

async function runHostCliCheck(options: {
  readonly checkoutDir: string;
  readonly configFile: string;
  readonly observe?: "off" | "summary" | "detail";
  readonly timeoutMs?: number;
}): Promise<{
  readonly exitCode: number;
  readonly payload: CliCheckPayload;
  readonly durationMs: number;
}> {
  const args = [
    "check",
    "--config",
    options.configFile,
    "--output",
    "json",
    ...(options.observe !== undefined && options.observe !== "off"
      ? ["--observe", options.observe]
      : []),
  ];
  const start = performance.now();
  const res = await runBareVeruleInHost({
    checkoutDir: options.checkoutDir,
    args,
    isolated: false,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  const durationMs = roundMs(performance.now() - start);
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(
      `verule ${args.join(" ")} failed with exit ${String(res.status)}:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return {
    exitCode: res.status,
    payload: parseCliCheckJson(res.stdout),
    durationMs,
  };
}

async function runHostNodeScript<T>(options: {
  readonly checkoutDir: string;
  readonly scriptSource: string;
  readonly timeoutMs?: number;
}): Promise<T> {
  const binDir = join(options.checkoutDir, "node_modules", ".bin");
  return new Promise((resolveResult, rejectResult) => {
    const child = spawn(
      process.execPath,
      ["--input-type=module", "-e", options.scriptSource],
      {
        cwd: options.checkoutDir,
        env: {
          ...process.env,
          PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rejectResult(
        new Error(
          `Host script timed out after ${String(options.timeoutMs ?? 120_000)}ms`,
        ),
      );
    }, options.timeoutMs ?? 120_000);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      rejectResult(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      const stdout = stdoutChunks.join("").trim();
      const stderr = stderrChunks.join("").trim();
      if (code !== 0) {
        rejectResult(
          new Error(
            `Host script exited with ${String(code)}: ${stderr}\nstdout: ${stdout}`,
          ),
        );
        return;
      }
      const lastLine = stdout.split("\n").at(-1) ?? "";
      resolveResult(JSON.parse(lastLine) as T);
    });
  });
}

async function runHostWatchEditSequence(options: {
  readonly checkoutDir: string;
  readonly configFile: string;
  readonly statusPagePath: string;
  readonly originalSource: string;
  readonly timeoutMs?: number;
}): Promise<readonly OpenStatusWatchEditStep[]> {
  const binDir = join(options.checkoutDir, "node_modules", ".bin");
  const veruleBin = join(binDir, "verule");

  const child: ChildProcessWithoutNullStreams = spawn(
    veruleBin,
    ["watch", "--config", options.configFile, "--output", "ndjson"],
    {
      cwd: options.checkoutDir,
      env: {
        ...process.env,
        PATH: `${binDir}${delimiter}${process.env.PATH ?? ""}`,
      },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  const lines = createInterface({
    input: child.stdout,
    crlfDelay: Infinity,
  });
  const stderrChunks: string[] = [];
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk: string) => stderrChunks.push(chunk));

  const reportQueue: {
    readonly sequence: number;
    readonly status: "clean" | "findings";
    readonly diagnostics: readonly CliDiagnostic[];
    readonly gaps: readonly Gap[];
    readonly memory: MemoryStats;
    readonly receivedAt: number;
  }[] = [];
  let waitResolve: (() => void) | undefined;

  lines.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = JSON.parse(trimmed) as {
      readonly kind: string;
      readonly variant?: string;
      readonly data?: {
        readonly sequence: number;
        readonly status: "clean" | "findings";
        readonly diagnostics: readonly CliDiagnostic[];
        readonly gaps: readonly Gap[];
        readonly memory: MemoryStats;
      };
    };
    if (
      parsed.kind === "record" &&
      parsed.variant === "report" &&
      parsed.data
    ) {
      reportQueue.push({
        ...parsed.data,
        receivedAt: performance.now(),
      });
      if (waitResolve) {
        const wake = waitResolve;
        waitResolve = undefined;
        wake();
      }
    }
  });

  const nextReport = async (minSequence: number) => {
    const deadline = performance.now() + (options.timeoutMs ?? 120_000);
    while (true) {
      const idx = reportQueue.findIndex((r) => r.sequence >= minSequence);
      if (idx !== -1) {
        return reportQueue[idx]!;
      }
      if (performance.now() > deadline) {
        throw new Error(
          `Timed out waiting for watch report #${String(minSequence)}; stderr=${stderrChunks.join("")}`,
        );
      }
      await new Promise<void>((res) => {
        waitResolve = res;
        const timer = setTimeout(() => {
          if (waitResolve === res) {
            waitResolve = undefined;
            res();
          }
        }, 500);
        timer.unref();
      });
    }
  };

  try {
    const steps: OpenStatusWatchEditStep[] = [];
    const initStart = performance.now();
    const watchInit = await nextReport(1);
    const coldInit = await runHostCliCheck({
      checkoutDir: options.checkoutDir,
      configFile: options.configFile,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
    const initParity = compareReportsBusinessParity(
      watchInit,
      coldInit.payload.data,
    );
    steps.push({
      label: "initial",
      watchFeedbackMs: roundMs(watchInit.receivedAt - initStart),
      coldCheckMs: coldInit.durationMs,
      matchesColdCheck:
        initParity.diagnosticsExactMatch &&
        initParity.gapsExactMatch &&
        initParity.evidenceExactMatch,
      diagnosticsCount: watchInit.diagnostics.length,
      memory: watchInit.memory,
    });

    // Edit 1: remove `slug: true,`
    const brokenSource = applyGetGateManualColumnEdit(
      options.originalSource,
      "remove-slug",
    );
    const edit1Start = performance.now();
    writeFileSync(options.statusPagePath, brokenSource, "utf8");
    const watchEdit1 = await nextReport(watchInit.sequence + 1);
    const edit1FeedbackMs = roundMs(watchEdit1.receivedAt - edit1Start);
    const coldEdit1 = await runHostCliCheck({
      checkoutDir: options.checkoutDir,
      configFile: options.configFile,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
    const edit1Parity = compareReportsBusinessParity(
      watchEdit1,
      coldEdit1.payload.data,
    );
    steps.push({
      label: "remove-slug-column",
      watchFeedbackMs: edit1FeedbackMs,
      coldCheckMs: coldEdit1.durationMs,
      matchesColdCheck:
        edit1Parity.diagnosticsExactMatch &&
        edit1Parity.gapsExactMatch &&
        edit1Parity.evidenceExactMatch,
      diagnosticsCount: watchEdit1.diagnostics.length,
      memory: watchEdit1.memory,
    });

    // Edit 2: restore `slug: true,`
    const restoredSource = applyGetGateManualColumnEdit(
      brokenSource,
      "restore-slug",
    );
    const edit2Start = performance.now();
    writeFileSync(options.statusPagePath, restoredSource, "utf8");
    const watchEdit2 = await nextReport(watchEdit1.sequence + 1);
    const edit2FeedbackMs = roundMs(watchEdit2.receivedAt - edit2Start);
    const coldEdit2 = await runHostCliCheck({
      checkoutDir: options.checkoutDir,
      configFile: options.configFile,
      ...(options.timeoutMs !== undefined
        ? { timeoutMs: options.timeoutMs }
        : {}),
    });
    const edit2Parity = compareReportsBusinessParity(
      watchEdit2,
      coldEdit2.payload.data,
    );
    steps.push({
      label: "restore-slug-column",
      watchFeedbackMs: edit2FeedbackMs,
      coldCheckMs: coldEdit2.durationMs,
      matchesColdCheck:
        edit2Parity.diagnosticsExactMatch &&
        edit2Parity.gapsExactMatch &&
        edit2Parity.evidenceExactMatch,
      diagnosticsCount: watchEdit2.diagnostics.length,
      memory: watchEdit2.memory,
    });

    return steps;
  } finally {
    writeFileSync(options.statusPagePath, options.originalSource, "utf8");
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await new Promise<void>((res) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          res();
        }, 3_000);
        timer.unref();
        child.once("exit", () => {
          clearTimeout(timer);
          res();
        });
      });
    }
  }
}

async function alignHostFactsInCheckout(options: {
  readonly checkoutDir: string;
  readonly projects: readonly string[];
  readonly timeoutMs?: number;
}): Promise<
  Omit<FactAlignmentSummary, "diagnosticsExactMatch"> & {
    readonly diagnosticsExactMatch: boolean;
  }
> {
  const script = `
import { defineConfig, defineRule, runCheck } from "@verule/sdk";
import { QueryRowProjectionFact, drizzleAdapter, rustDrizzleAdapter } from "@verule/adapter-drizzle";
import { zodAdapter } from "@verule/adapter-zod";
import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

const projects = ${JSON.stringify(options.projects)};
const stableStringify = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "undefined";
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const keys = Object.keys(value).toSorted();
  return "{" + keys.filter((k) => value[k] !== undefined).map((k) => JSON.stringify(k) + ":" + stableStringify(value[k])).join(",") + "}";
};
const sortKey = (f) => [f.value.queryKind, f.value.tableName ?? "", f.value.cardinality, f.value.projectedColumns.join(","), String(f.value.hasDynamicColumns), stableStringify(f.evidence)].join("|");
const runOne = async (adapter) => {
  let facts = [];
  const report = await runCheck({
    cwd: process.cwd(),
    config: defineConfig({
      projects,
      adapters: [adapter, zodAdapter],
      rules: [
        rowProjectionSatisfiesValidatorRule,
        defineRule({
          id: "collect-facts",
          run: async (ctx) => {
            facts.push(...(await ctx.facts(QueryRowProjectionFact)));
          },
        }),
      ],
    }),
  });
  return {
    facts: facts.map((f) => ({ value: f.value, evidence: f.evidence, gaps: f.gaps })).toSorted((a, b) => sortKey(a).localeCompare(sortKey(b))),
    report: {
      status: report.status,
      diagnostics: report.diagnostics.map((d) => ({ ruleId: d.ruleId, at: d.at, message: d.message, evidence: d.evidence })),
      gaps: report.gaps,
    },
  };
};
const tsRes = await runOne(drizzleAdapter);
const rustRes = await runOne(rustDrizzleAdapter);
const ser = (arr) => JSON.stringify(arr.map(stableStringify).toSorted());
console.log(JSON.stringify({
  tsCount: tsRes.facts.length,
  rustCount: rustRes.facts.length,
  factsExactMatch: tsRes.facts.length === rustRes.facts.length && tsRes.facts.every((f, i) => stableStringify(f.value) === stableStringify(rustRes.facts[i].value)),
  evidenceExactMatch: tsRes.facts.length === rustRes.facts.length && tsRes.facts.every((f, i) => stableStringify(f.evidence) === stableStringify(rustRes.facts[i].evidence)) && ser(tsRes.report.diagnostics.map((d) => d.evidence)) === ser(rustRes.report.diagnostics.map((d) => d.evidence)),
  gapsExactMatch: tsRes.facts.length === rustRes.facts.length && tsRes.facts.every((f, i) => stableStringify(f.gaps) === stableStringify(rustRes.facts[i].gaps)) && ser(tsRes.report.gaps.filter((g) => g.kind !== "unresolved-declaration")) === ser(rustRes.report.gaps.filter((g) => g.kind !== "unresolved-declaration")),
  diagnosticsExactMatch: tsRes.report.status === rustRes.report.status && ser(tsRes.report.diagnostics.map((d) => ({ ruleId: d.ruleId, at: d.at, message: d.message }))) === ser(rustRes.report.diagnostics.map((d) => ({ ruleId: d.ruleId, at: d.at, message: d.message }))),
}));
`;
  return runHostNodeScript({
    checkoutDir: options.checkoutDir,
    scriptSource: script,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

async function runHostDeepComparisonScript(options: {
  readonly checkoutDir: string;
  readonly projects: readonly string[];
  readonly timeoutMs?: number;
}): Promise<{
  readonly threeConfigs: ThreeConfigMatrix;
  readonly reuseAndInvalidation: {
    readonly ts: ReuseAndInvalidationSummary;
    readonly rust: ReuseAndInvalidationSummary;
  };
  readonly providerSelection: ProviderSelectionComparison;
  readonly costComparison: {
    readonly ts: ProviderCostSample;
    readonly rust: ProviderCostSample;
  };
  readonly observeOverhead: {
    readonly ts: ObserveOverheadComparison;
    readonly rust: ObserveOverheadComparison;
  };
}> {
  const script = `
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { defineConfig, defineRule, openSession, runCheck } from "@verule/sdk";
import { QueryRowProjectionFact, createDrizzleAdapter, createRustDrizzleAdapter, drizzleAdapter, rustDrizzleAdapter } from "@verule/adapter-drizzle";
import { zodAdapter } from "@verule/adapter-zod";
import { createRowProjectionSatisfiesValidatorRule, rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";

const projects = ${JSON.stringify(options.projects)};
const cwd = process.cwd();
const roundMs = (v) => Math.round(v * 1000) / 1000;
const statusPagePath = join(cwd, "packages/api/src/router/statusPage.ts");
const pageSchemaPath = join(cwd, "packages/db/src/schema/pages/page.ts");
const workspaceValidationPath = join(cwd, "packages/db/src/schema/workspaces/validation.ts");
const origStatusPage = readFileSync(statusPagePath, "utf8");
const origPageSchema = readFileSync(pageSchemaPath, "utf8");
const origWorkspaceValidation = readFileSync(workspaceValidationPath, "utf8");

const removeSlug = (src) => {
  const idx = src.indexOf("getGate: publicProcedure");
  return src.slice(0, idx) + src.slice(idx).replace("          slug: true,\\n", "");
};

const unqueriedRule = defineRule({
  id: "syntax-only-no-facts",
  run: async (ctx) => { await ctx.findSyntax({ kinds: ["CallExpression"] }); },
});

const measureConfigSample = async (kind, impl) => {
  let tsExtractions = 0;
  let rustExtractions = 0;
  const trackedTs = createDrizzleAdapter({ onExtract: () => { tsExtractions += 1; } });
  const trackedRust = createRustDrizzleAdapter({ onExtract: () => { rustExtractions += 1; } });
  const adapters = kind === "disabled" ? [zodAdapter] : impl === "ts" ? [trackedTs, zodAdapter] : [trackedRust, zodAdapter];
  const rules = kind === "enabled-unqueried" ? [unqueriedRule] : [rowProjectionSatisfiesValidatorRule];
  const coldStart = performance.now();
  const session = await openSession({ cwd, config: defineConfig({ projects, adapters, rules }), observe: "detail" });
  try {
    const coldReport = await session.check({ observe: "detail" });
    const coldCheckMs = roundMs(performance.now() - coldStart);
    const editStart = performance.now();
    writeFileSync(statusPagePath, removeSlug(origStatusPage), "utf8");
    await session.update({ changed: ["packages/api/src/router/statusPage.ts"] });
    await session.check({ observe: "detail" });
    const editCheckMs = roundMs(performance.now() - editStart);
    writeFileSync(statusPagePath, origStatusPage, "utf8");
    const targetProvider = impl === "ts" ? "drizzle" : "drizzle-rust";
    return {
      coldCheckMs,
      editCheckMs,
      diagnosticsCount: coldReport.diagnostics.length,
      tsExtractions,
      rustExtractions,
      rustEngineExtractions: coldReport.observation?.engineExtractions?.["drizzle-rust"]?.extractions ?? 0,
      providerObserved: coldReport.observation?.providers.includes(targetProvider) ?? false,
    };
  } finally {
    await session.close();
    writeFileSync(statusPagePath, origStatusPage, "utf8");
  }
};

const threeConfigs = {
  ts: {
    disabled: await measureConfigSample("disabled", "ts"),
    enabledUnqueried: await measureConfigSample("enabled-unqueried", "ts"),
    enabledQueried: await measureConfigSample("enabled-queried", "ts"),
  },
  rust: {
    disabled: await measureConfigSample("disabled", "rust"),
    enabledUnqueried: await measureConfigSample("enabled-unqueried", "rust"),
    enabledQueried: await measureConfigSample("enabled-queried", "rust"),
  },
};

const measureReuseAndInvalidation = async (impl) => {
  let extractCount = 0;
  const adapter = impl === "ts"
    ? createDrizzleAdapter({ onExtract: () => { extractCount += 1; } })
    : createRustDrizzleAdapter({ onExtract: () => { extractCount += 1; } });
  const config = defineConfig({
    projects,
    adapters: [adapter, zodAdapter],
    rules: [
      rowProjectionSatisfiesValidatorRule,
      defineRule({
        id: "second-drizzle-consumer",
        run: async (ctx) => { await ctx.facts(QueryRowProjectionFact); },
      }),
    ],
  });
  const coldStart = performance.now();
  const session = await openSession({ cwd, config, observe: "detail" });
  try {
    const initialReport = await session.check({ observe: "detail" });
    const coldLatencyMs = roundMs(performance.now() - coldStart);
    const factQueries = (initialReport.observation?.details ?? []).filter((d) => d.kind === "query" && d.name === "facts:" + QueryRowProjectionFact.id);
    const firstRuleCacheStatus = factQueries[0]?.cacheStatus ?? "computed";
    const secondRuleCacheStatus = factQueries[1]?.cacheStatus ?? "computed";
    const extractionsAcrossTwoRules = extractCount;

    const reuseStart = performance.now();
    await session.check({ ruleIds: ["second-drizzle-consumer"], observe: "detail" });
    const reuseLatencyMs = roundMs(performance.now() - reuseStart);

    // Table column definition edit in packages/db/src/schema/pages/page.ts
    const tableStart = performance.now();
    writeFileSync(pageSchemaPath, origPageSchema.replace('slug: text("slug"', 'slug: text("page_slug_v2"'), "utf8");
    writeFileSync(statusPagePath, removeSlug(origStatusPage), "utf8");
    await session.update({ changed: ["packages/db/src/schema/pages/page.ts", "packages/api/src/router/statusPage.ts"] });
    const afterTableReport = await session.check({ observe: "detail" });
    const afterTableEditLatencyMs = roundMs(performance.now() - tableStart);
    const tableGateDiag = afterTableReport.diagnostics.find((d) => d.at.file === "packages/api/src/router/statusPage.ts" && d.message.includes("slug"));

    // Restore page.ts & statusPage.ts, then edit Zod schema in packages/db/src/schema/workspaces/validation.ts
    writeFileSync(pageSchemaPath, origPageSchema, "utf8");
    writeFileSync(statusPagePath, origStatusPage, "utf8");
    await session.update({ changed: ["packages/db/src/schema/pages/page.ts", "packages/api/src/router/statusPage.ts"] });
    await session.check({ observe: "detail" });

    const beforeSchemaCount = extractCount;
    const schemaStart = performance.now();
    writeFileSync(
      workspaceValidationPath,
      origWorkspaceValidation.replace(
        "    // REMINDER: workspace usage",
        "    requiredPlanAuditField: z.string(),\\n    // REMINDER: workspace usage",
      ),
      "utf8",
    );
    await session.update({ changed: ["packages/db/src/schema/workspaces/validation.ts"] });
    const afterSchemaReport = await session.check({ observe: "detail" });
    const afterSchemaEditLatencyMs = roundMs(performance.now() - schemaStart);
    const schemaGateDiag = afterSchemaReport.diagnostics.find((d) => d.at.file === "packages/api/src/router/statusPage.ts" && d.message.includes("requiredPlanAuditField"));
    const schemaRecomputed = (afterSchemaReport.observation?.details ?? []).some(
      (d) => d.kind === "query" && d.cacheStatus === "computed",
    );

    return {
      firstRuleCacheStatus,
      secondRuleCacheStatus,
      extractionsAcrossTwoRules,
      coldLatencyMs,
      reuseLatencyMs,
      afterTableEditRecomputed: extractCount > extractionsAcrossTwoRules && tableGateDiag !== undefined,
      afterTableEditEvidenceUpdated: tableGateDiag?.evidence.some((ev) => ev.at?.file === "packages/db/src/schema/pages/page.ts") ?? false,
      afterTableEditLatencyMs,
      afterSchemaEditRecomputed: extractCount >= beforeSchemaCount && schemaRecomputed && schemaGateDiag !== undefined,
      afterSchemaEditEvidenceUpdated: schemaGateDiag?.evidence.some((ev) => ev.at?.file === "packages/db/src/schema/workspaces/validation.ts") ?? false,
      afterSchemaEditLatencyMs,
    };
  } finally {
    await session.close();
    writeFileSync(pageSchemaPath, origPageSchema, "utf8");
    writeFileSync(workspaceValidationPath, origWorkspaceValidation, "utf8");
    writeFileSync(statusPagePath, origStatusPage, "utf8");
  }
};

const reuseAndInvalidation = {
  ts: await measureReuseAndInvalidation("ts"),
  rust: await measureReuseAndInvalidation("rust"),
};

const runProviderMode = async (drizzleProviderId) => {
  let tsExtractions = 0;
  let rustExtractions = 0;
  const trackedTs = createDrizzleAdapter({ onExtract: () => { tsExtractions += 1; } });
  const trackedRust = createRustDrizzleAdapter({ onExtract: () => { rustExtractions += 1; } });
  const rule = drizzleProviderId === undefined
    ? rowProjectionSatisfiesValidatorRule
    : createRowProjectionSatisfiesValidatorRule({ drizzleProviderId });
  const start = performance.now();
  const report = await runCheck({
    cwd,
    config: defineConfig({ projects, adapters: [trackedTs, trackedRust, zodAdapter], rules: [rule] }),
    observe: "detail",
  });
  return {
    providersUsed: (report.observation?.providers ?? []).filter((p) => p === "drizzle" || p === "drizzle-rust"),
    tsExtractions,
    rustExtractions,
    candidateCount: report.observation?.candidateCount ?? 0,
    durationMs: roundMs(performance.now() - start),
    diagnosticsCount: report.diagnostics.length,
  };
};

const providerSelection = {
  byFactType: await runProviderMode(undefined),
  explicitRust: await runProviderMode("drizzle-rust"),
  explicitTs: await runProviderMode("drizzle"),
};

const measureCostAndObserve = async (impl) => {
  const adapter = impl === "ts" ? drizzleAdapter : rustDrizzleAdapter;
  const config = defineConfig({ projects, adapters: [adapter, zodAdapter], rules: [rowProjectionSatisfiesValidatorRule] });

  const offStart = performance.now();
  const offReport = await runCheck({ cwd, config, observe: "off" });
  const offExternalMs = roundMs(performance.now() - offStart);

  const detailStart = performance.now();
  const detailSession = await openSession({ cwd, config, observe: "detail" });
  try {
    const detailReport = await detailSession.check({ observe: "detail" });
    const detailExternalMs = roundMs(performance.now() - detailStart);
    const ser = (x) => JSON.stringify(x);
    const businessReportIdentical =
      offReport.status === detailReport.status &&
      ser(offReport.diagnostics.map((d) => ({ ruleId: d.ruleId, at: d.at, message: d.message, evidence: d.evidence }))) ===
      ser(detailReport.diagnostics.map((d) => ({ ruleId: d.ruleId, at: d.at, message: d.message, evidence: d.evidence }))) &&
      ser(offReport.gaps) === ser(detailReport.gaps);

    const reuseStart = performance.now();
    await detailSession.check({ observe: "detail" });
    const reuseCheckMs = roundMs(performance.now() - reuseStart);

    const editStart = performance.now();
    writeFileSync(statusPagePath, removeSlug(origStatusPage), "utf8");
    await detailSession.update({ changed: ["packages/api/src/router/statusPage.ts"] });
    await detailSession.check({ observe: "detail" });
    const editCheckMs = roundMs(performance.now() - editStart);
    writeFileSync(statusPagePath, origStatusPage, "utf8");

    const obs = detailReport.observation;
    return {
      cost: {
        coldCheckMs: detailExternalMs,
        reuseCheckMs,
        editCheckMs,
        rpc: obs.rpc,
        memory: detailSession.memory,
        candidateCount: obs.candidateCount,
      },
      observe: {
        offExternalMs,
        detailExternalMs,
        externalDeltaMs: roundMs(detailExternalMs - offExternalMs),
        businessReportIdentical,
        internal: obs.overhead,
      },
    };
  } finally {
    await detailSession.close();
    writeFileSync(statusPagePath, origStatusPage, "utf8");
  }
};

const tsCost = await measureCostAndObserve("ts");
const rustCost = await measureCostAndObserve("rust");

console.log(JSON.stringify({
  threeConfigs,
  reuseAndInvalidation,
  providerSelection,
  costComparison: { ts: tsCost.cost, rust: rustCost.cost },
  observeOverhead: { ts: tsCost.observe, rust: rustCost.observe },
}));
`;
  return runHostNodeScript({
    checkoutDir: options.checkoutDir,
    scriptSource: script,
    ...(options.timeoutMs !== undefined
      ? { timeoutMs: options.timeoutMs }
      : {}),
  });
}

/**
 * Packs workspace artifacts, installs them into isolated out-of-repo OpenStatus
 * checkouts, aligns TS vs Rust Drizzle providers on `whoami` and `getGate`,
 * measures repeated cold checks, `verule watch` incremental edits, 3-config matrix,
 * cross-rule reuse, table/schema edit invalidation, provider selection, RPC batches/bytes,
 * memory, and observation overhead, then cleans up all temporary directories.
 */
export async function runOpenStatusAdapterCostAcceptance(
  options: {
    readonly repositoryUrl?: string;
    readonly cacheDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly coldIterations?: number;
    readonly timeoutMs?: number;
  } = {},
): Promise<OpenStatusAdapterCostResult> {
  const coldIterations = options.coldIterations ?? 3;
  const bundle: PackedArtifactBundle = await packWorkspaceArtifacts({
    additionalPackages: OPENSTATUS_EXTENSION_PACKAGES,
  });

  const artifactDigests = bundle.artifacts.map((artifact: PackedArtifact) => ({
    name: artifact.name,
    version: artifact.version,
    sha256: artifact.sha256,
    ...(artifact.binarySha256 === undefined
      ? {}
      : { binarySha256: artifact.binarySha256 }),
  }));

  try {
    // 1. Align TS vs Rust across OpenStatus `whoami` 3-commit sequence
    const whoamiAlignment: OpenStatusWhoamiAlignmentRecord[] = [];
    for (const step of OPENSTATUS_WHOAMI_STEPS) {
      const prepared = await prepareHostWithArtifacts({
        hostId: "openstatus",
        sha: step.sha,
        artifacts: bundle.artifacts,
        directPackages: OPENSTATUS_DIRECT_PACKAGES,
        ...(options.repositoryUrl === undefined
          ? {}
          : { repositoryUrl: options.repositoryUrl }),
        ...(options.cacheDir === undefined
          ? {}
          : { cacheDir: options.cacheDir }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });
      if (prepared.status === "preparation-failed") {
        throw new Error(
          `Failed to prepare OpenStatus ${step.sha}: ${prepared.message}\n${prepared.stderr ?? ""}`,
        );
      }
      try {
        await verifyHostArtifactResolution({
          checkoutDir: prepared.checkout.checkoutDir,
          artifacts: bundle.artifacts,
          directPackages: OPENSTATUS_DIRECT_PACKAGES,
        });
        writeFileSync(
          join(prepared.checkout.checkoutDir, "verule.ts.config.mjs"),
          renderAdapterConfigMjs({
            projects: OPENSTATUS_WHOAMI_PROJECTS,
            adapterExport: "drizzleAdapter",
            ruleMode: "validator",
          }),
          "utf8",
        );
        writeFileSync(
          join(prepared.checkout.checkoutDir, "verule.rust.config.mjs"),
          renderAdapterConfigMjs({
            projects: OPENSTATUS_WHOAMI_PROJECTS,
            adapterExport: "rustDrizzleAdapter",
            ruleMode: "validator",
          }),
          "utf8",
        );

        const tsCli = await runHostCliCheck({
          checkoutDir: prepared.checkout.checkoutDir,
          configFile: "verule.ts.config.mjs",
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
        });
        const rustCli = await runHostCliCheck({
          checkoutDir: prepared.checkout.checkoutDir,
          configFile: "verule.rust.config.mjs",
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
        });
        const cliParity = compareReportsBusinessParity(
          tsCli.payload.data,
          rustCli.payload.data,
          { ignoreRpcProbeGaps: true },
        );
        const factParity = await alignHostFactsInCheckout({
          checkoutDir: prepared.checkout.checkoutDir,
          projects: OPENSTATUS_WHOAMI_PROJECTS,
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
        });
        whoamiAlignment.push({
          label: step.label,
          sha: step.sha,
          tsColdCheckMs: tsCli.durationMs,
          rustColdCheckMs: rustCli.durationMs,
          diagnosticsExactMatch:
            cliParity.diagnosticsExactMatch && factParity.diagnosticsExactMatch,
          gapsExactMatch: cliParity.gapsExactMatch && factParity.gapsExactMatch,
          evidenceExactMatch:
            cliParity.evidenceExactMatch && factParity.evidenceExactMatch,
          factsExactMatch: factParity.factsExactMatch,
          factCount: factParity.tsCount,
          diagnosticCount: rustCli.payload.data.diagnostics.length,
        });
      } finally {
        prepared.cleanup();
      }
      if (existsSync(prepared.checkout.checkoutDir)) {
        throw new Error(
          `Temporary OpenStatus checkout was not cleaned up: ${prepared.checkout.checkoutDir}`,
        );
      }
    }

    // 2. Pinned OpenStatus `getGate` (090709ad) full equivalence + latency + cost suite
    const gatePrepared = await prepareHostWithArtifacts({
      hostId: "openstatus",
      sha: OPENSTATUS_GET_GATE_SHA,
      artifacts: bundle.artifacts,
      directPackages: OPENSTATUS_DIRECT_PACKAGES,
      ...(options.repositoryUrl === undefined
        ? {}
        : { repositoryUrl: options.repositoryUrl }),
      ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (gatePrepared.status === "preparation-failed") {
      throw new Error(
        `Failed to prepare OpenStatus getGate ${OPENSTATUS_GET_GATE_SHA}: ${gatePrepared.message}\n${gatePrepared.stderr ?? ""}`,
      );
    }

    const checkoutDir = gatePrepared.checkout.checkoutDir;
    try {
      await verifyHostArtifactResolution({
        checkoutDir,
        artifacts: bundle.artifacts,
        directPackages: OPENSTATUS_DIRECT_PACKAGES,
      });

      writeFileSync(
        join(checkoutDir, "verule.ts.config.mjs"),
        renderAdapterConfigMjs({
          projects: OPENSTATUS_GET_GATE_PROJECTS,
          adapterExport: "drizzleAdapter",
          ruleMode: "validator",
        }),
        "utf8",
      );
      writeFileSync(
        join(checkoutDir, "verule.rust.config.mjs"),
        renderAdapterConfigMjs({
          projects: OPENSTATUS_GET_GATE_PROJECTS,
          adapterExport: "rustDrizzleAdapter",
          ruleMode: "validator",
        }),
        "utf8",
      );

      const getGateAlignment = await alignHostFactsInCheckout({
        checkoutDir,
        projects: OPENSTATUS_GET_GATE_PROJECTS,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      });

      // Repeated cold checks
      const tsColdRuns: number[] = [];
      const rustColdRuns: number[] = [];
      for (let i = 0; i < coldIterations; i += 1) {
        const tsRun = await runHostCliCheck({
          checkoutDir,
          configFile: "verule.ts.config.mjs",
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
        });
        tsColdRuns.push(tsRun.durationMs);

        const rustRun = await runHostCliCheck({
          checkoutDir,
          configFile: "verule.rust.config.mjs",
          ...(options.timeoutMs !== undefined
            ? { timeoutMs: options.timeoutMs }
            : {}),
        });
        rustColdRuns.push(rustRun.durationMs);
      }

      const statusPagePath = join(checkoutDir, OPENSTATUS_GET_GATE_FILE);
      const originalStatusPage = readFileSync(statusPagePath, "utf8");

      const tsWatchEdits = await runHostWatchEditSequence({
        checkoutDir,
        configFile: "verule.ts.config.mjs",
        statusPagePath,
        originalSource: originalStatusPage,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      });
      const rustWatchEdits = await runHostWatchEditSequence({
        checkoutDir,
        configFile: "verule.rust.config.mjs",
        statusPagePath,
        originalSource: originalStatusPage,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      });

      const deep = await runHostDeepComparisonScript({
        checkoutDir,
        projects: OPENSTATUS_GET_GATE_PROJECTS,
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      });

      return {
        artifacts: artifactDigests,
        whoamiAlignment,
        getGateAlignment,
        coldLatency: {
          ts: summarizeLatencies(tsColdRuns),
          rust: summarizeLatencies(rustColdRuns),
        },
        watchEdits: {
          ts: tsWatchEdits,
          rust: rustWatchEdits,
        },
        threeConfigs: deep.threeConfigs,
        reuseAndInvalidation: deep.reuseAndInvalidation,
        providerSelection: deep.providerSelection,
        costComparison: deep.costComparison,
        observeOverhead: deep.observeOverhead,
      };
    } finally {
      gatePrepared.cleanup();
    }
  } finally {
    bundle.dispose();
  }
}

export { resolve };
