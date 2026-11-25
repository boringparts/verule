import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  CheckReport,
  Diagnostic,
  ObservationDetailEntry,
} from "@boringparts/verule";

import type { PackedArtifactBundle } from "./artifacts.ts";
import {
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "./host-lifecycle.ts";
import type { WatchReportRecord } from "./process-stream.ts";

export type PoolOwnershipScaleSpec = {
  readonly fileCount: number;
  readonly candidateFactoryCount: number;
};

export const POOL_OWNERSHIP_SMALL_SCALE: PoolOwnershipScaleSpec = {
  fileCount: 64,
  candidateFactoryCount: 8,
};

export const POOL_OWNERSHIP_TIERS: readonly PoolOwnershipScaleSpec[] = [
  POOL_OWNERSHIP_SMALL_SCALE,
  { fileCount: 256, candidateFactoryCount: 8 },
  { fileCount: 1024, candidateFactoryCount: 8 },
  { fileCount: 256, candidateFactoryCount: 32 },
  { fileCount: 256, candidateFactoryCount: 128 },
];

export type GeneratedPoolOwnershipProject = {
  readonly scale: PoolOwnershipScaleSpec;
  readonly files: Readonly<Record<string, string>>;
  readonly sourceFiles: readonly string[];
  readonly poolFiles: readonly string[];
  readonly backgroundFiles: readonly string[];
  readonly violatingFile: string;
  readonly violatingLine: number;
  readonly unrelatedFile: string;
};

export type PoolOwnershipMaterializedSpec = {
  readonly scale: PoolOwnershipScaleSpec;
  readonly appSubdir: string;
  readonly configPath: string;
  readonly tsconfigPath: string;
  readonly sourceFiles: readonly string[];
  readonly poolFiles: readonly string[];
  readonly backgroundFiles: readonly string[];
  readonly violatingFile: string;
  readonly violatingLine: number;
  readonly unrelatedFile: string;
  readonly probeFile: string;
};

export type PoolOwnershipCandidateAudit = {
  readonly fileCount: number;
  readonly candidateCallCount: number;
  readonly seedCheckpointCount: number;
  readonly judgmentCheckpointCount: number;
  readonly report: CheckReport;
};

const scenariosDir = fileURLToPath(
  new URL("../scenarios/pool-ownership", import.meta.url),
);

const SEED_SHARED_FILES = [
  "src/platform/lifecycle.ts",
  "src/platform/instantiation.ts",
  "src/services/workbench-context.ts",
] as const;

const SEED_VIOLATING_POOL_FILE = "src/pools/collapsible-list-pool.ts";
const SEED_CLEAN_TREE_POOL_FILE = "src/pools/tree-pool.ts";
const SEED_CLEAN_EDITOR_POOL_FILE = "src/pools/editor-pool.ts";
const SEED_UNRELATED_FEATURE_FILE = "src/features/panel-module.ts";
const PROBE_RELATIVE_FILE = "src/extensions-probe/unlisted-panel-pools.ts";
const DEFAULT_APP_SUBDIR = "packages/app";

function readSeedFile(relativePath: string): string {
  return readFileSync(join(scenariosDir, relativePath), "utf8");
}

function pad3(value: number): string {
  return String(value).padStart(3, "0");
}

function findExactLineNumber(
  source: string,
  needle: string,
  filePath: string,
): number {
  const idx = source.indexOf(needle);
  if (idx === -1) {
    throw new Error(
      `Expected ${filePath} to contain ${JSON.stringify(needle)}`,
    );
  }
  return source.slice(0, idx).split("\n").length;
}

function renderHostTsconfig(includePattern = "src/**/*.ts"): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2024",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        types: [],
        erasableSyntaxOnly: true,
        rewriteRelativeImportExtensions: true,
        noEmit: true,
      },
      include: [includePattern],
    },
    null,
    2,
  )}\n`;
}

function renderHostAppPackageJson(): string {
  return `${JSON.stringify(
    {
      name: "@verule/acceptance-host-pool-ownership-app",
      version: "0.0.0",
      private: true,
      type: "module",
    },
    null,
    2,
  )}\n`;
}

function renderGeneratedPoolModule(
  moduleNumber: number,
  factoryIndices: readonly number[],
): string {
  const suffix = pad3(moduleNumber);
  const needsStore = factoryIndices.some((index) => index % 2 === 0);
  const needsListOrTree = factoryIndices.some((index) => index % 2 === 0);
  const needsCodeBlock = factoryIndices.some((index) => index % 2 === 1);

  const instantiationImports = [
    ...(needsListOrTree
      ? [
          "  createFileIconThemableTreeContainerScope,",
          "  ResourceLabels,",
          "  WorkbenchTree,",
        ]
      : []),
    ...(needsCodeBlock ? ["  CodeBlockPart,"] : []),
    "  type IInstantiationService,",
  ];

  const lifecycleImports = [
    "  Disposable,",
    ...(needsStore ? ["  DisposableStore,"] : []),
    "  ResourcePool,",
    ...(needsListOrTree ? ["  type IDisposable,"] : []),
  ];

  const blocks: string[] = [
    "import {",
    ...instantiationImports,
    '} from "../platform/instantiation.ts";',
    "import {",
    ...lifecycleImports,
    '} from "../platform/lifecycle.ts";',
    'import { createWorkbenchContext } from "../services/workbench-context.ts";',
    "",
  ];

  for (const factoryIndex of factoryIndices) {
    const id = pad3(factoryIndex);
    if (factoryIndex % 2 === 0) {
      blocks.push(
        `export interface IGeneratedTreePoolItem${id} extends IDisposable {`,
        "  readonly tree: WorkbenchTree;",
        "}",
        "",
        `export class GeneratedTreePool${id} extends Disposable {`,
        `  private readonly pool: ResourcePool<IGeneratedTreePoolItem${id}>;`,
        "  private readonly instantiationService: IInstantiationService;",
        `  private readonly context = createWorkbenchContext("generated-tree-${id}", "tree");`,
        "",
        "  constructor(instantiationService: IInstantiationService) {",
        "    super();",
        "    this.instantiationService = instantiationService;",
        `    this.pool = this._register(new ResourcePool(() => this.createTreeEntry${id}()));`,
        "  }",
        "",
        `  private createTreeEntry${id}(): IGeneratedTreePoolItem${id} {`,
        "    const store = new DisposableStore();",
        "    const labels = store.add(",
        "      this.instantiationService.createInstance(ResourceLabels),",
        "    );",
        "    const scope = store.add(",
        "      createFileIconThemableTreeContainerScope(this.context.panelId),",
        "    );",
        "    const tree = this.instantiationService.createInstance(",
        "      WorkbenchTree,",
        "      labels,",
        "      scope,",
        "      this.context.panelId,",
        "    );",
        "    return {",
        "      tree,",
        "      dispose: () => store.dispose(),",
        "    };",
        "  }",
        "",
        "  borrow(): WorkbenchTree {",
        "    return this.pool.get().tree;",
        "  }",
        "}",
        "",
      );
    } else {
      blocks.push(
        `export class GeneratedEditorPool${id} extends Disposable {`,
        "  private readonly pool: ResourcePool<CodeBlockPart>;",
        "  private readonly instantiationService: IInstantiationService;",
        `  private readonly context = createWorkbenchContext("generated-editor-${id}", "editor");`,
        "",
        "  constructor(instantiationService: IInstantiationService) {",
        "    super();",
        "    this.instantiationService = instantiationService;",
        `    this.pool = this._register(new ResourcePool(() => this.createEditorEntry${id}()));`,
        "  }",
        "",
        `  private createEditorEntry${id}(): CodeBlockPart {`,
        "    return this.instantiationService.createInstance(",
        "      CodeBlockPart,",
        `      this.context.formatTag("${suffix}"),`,
        "    );",
        "  }",
        "",
        "  borrow(): CodeBlockPart {",
        "    return this.pool.get();",
        "  }",
        "}",
        "",
      );
    }
  }

  return blocks.join("\n");
}

function renderGeneratedFeatureModule(moduleNumber: number): string {
  const id = pad3(moduleNumber);
  const usePanelAnchor = moduleNumber === 1 || moduleNumber % 8 === 1;
  const prevId = pad3(moduleNumber - 1);
  const upstreamImport = usePanelAnchor
    ? 'import { evaluatePanelDescriptors } from "./panel-module.ts";'
    : `import { evaluateFeatureModule${prevId} } from "./feature-module-${prevId}.ts";`;
  const upstreamCall = usePanelAnchor
    ? "evaluatePanelDescriptors(entries)"
    : `evaluateFeatureModule${prevId}(entries)`;

  return [
    'import { disposeAll, type IDisposable } from "../platform/lifecycle.ts";',
    "import {",
    "  createWorkbenchContext,",
    "  summarizePanelMetrics,",
    "  type PanelDescriptor,",
    "  type ViewMetrics,",
    '} from "../services/workbench-context.ts";',
    upstreamImport,
    "",
    `export type FeatureBatch${id} = {`,
    "  readonly tag: string;",
    "  readonly localMetrics: ViewMetrics;",
    "  readonly upstreamMetrics: ViewMetrics;",
    "};",
    "",
    `export function evaluateFeatureModule${id}(`,
    "  entries: readonly PanelDescriptor[],",
    "): ViewMetrics {",
    "  return summarizePanelMetrics(entries);",
    "}",
    "",
    `export class FeaturePanelService${id} implements IDisposable {`,
    "  private readonly entries: PanelDescriptor[] = [];",
    "  private readonly resources: IDisposable[] = [];",
    `  private readonly context = createWorkbenchContext("feature-${id}", "list");`,
    "",
    "  register(entry: PanelDescriptor, resource?: IDisposable): void {",
    "    this.entries.push(entry);",
    "    if (resource !== undefined) {",
    "      this.resources.push(resource);",
    "    }",
    "  }",
    "",
    `  buildBatch(): FeatureBatch${id} {`,
    "    const entries = this.entries;",
    "    return {",
    `      tag: this.context.formatTag("${id}"),`,
    "      localMetrics: summarizePanelMetrics(entries),",
    `      upstreamMetrics: ${upstreamCall},`,
    "    };",
    "  }",
    "",
    "  dispose(): void {",
    "    disposeAll(this.resources);",
    "    this.resources.length = 0;",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Deterministically generates a TypeScript pool-ownership project for the
 * requested `{ fileCount, candidateFactoryCount }` scale tier.
 */
export function generatePoolOwnershipProject(
  scale: PoolOwnershipScaleSpec,
): GeneratedPoolOwnershipProject {
  const { fileCount, candidateFactoryCount } = scale;
  if (!Number.isSafeInteger(fileCount) || fileCount < 5) {
    throw new Error(
      `Expected fileCount to be an integer >= 5, got ${String(fileCount)}`,
    );
  }
  if (
    !Number.isSafeInteger(candidateFactoryCount) ||
    candidateFactoryCount < 1
  ) {
    throw new Error(
      `Expected candidateFactoryCount to be an integer >= 1, got ${String(candidateFactoryCount)}`,
    );
  }

  const files: Record<string, string> = {
    "package.json": renderHostAppPackageJson(),
    "tsconfig.json": renderHostTsconfig(),
    "verule.config.ts": readSeedFile("verule.config.ts"),
  };

  const sourceFiles: string[] = [];
  const poolFiles: string[] = [];
  const backgroundFiles: string[] = [];

  for (const rel of SEED_SHARED_FILES) {
    files[rel] = readSeedFile(rel);
    sourceFiles.push(rel);
  }

  const seedPools: readonly string[] =
    candidateFactoryCount === 1
      ? [SEED_VIOLATING_POOL_FILE]
      : candidateFactoryCount === 2
        ? [SEED_VIOLATING_POOL_FILE, SEED_CLEAN_TREE_POOL_FILE]
        : [
            SEED_VIOLATING_POOL_FILE,
            SEED_CLEAN_TREE_POOL_FILE,
            SEED_CLEAN_EDITOR_POOL_FILE,
          ];

  for (const rel of seedPools) {
    files[rel] = readSeedFile(rel);
    sourceFiles.push(rel);
    poolFiles.push(rel);
  }

  const availablePoolFileSlots = Math.max(
    seedPools.length,
    fileCount - SEED_SHARED_FILES.length - 1,
  );
  const generatedPoolFileCount = Math.min(
    Math.max(0, candidateFactoryCount - seedPools.length),
    Math.max(0, availablePoolFileSlots - seedPools.length),
  );

  const extraFactoriesCount = Math.max(
    0,
    candidateFactoryCount - seedPools.length,
  );
  if (extraFactoriesCount > 0) {
    const buckets: number[][] = Array.from(
      { length: generatedPoolFileCount },
      () => [],
    );
    for (let i = 0; i < extraFactoriesCount; i += 1) {
      const factoryNumber = seedPools.length + i + 1;
      buckets[i % generatedPoolFileCount]!.push(factoryNumber);
    }
    for (let slot = 0; slot < buckets.length; slot += 1) {
      const moduleNumber = seedPools.length + slot + 1;
      const rel = `src/pools/generated-pool-${pad3(moduleNumber)}.ts`;
      files[rel] = renderGeneratedPoolModule(moduleNumber, buckets[slot]!);
      sourceFiles.push(rel);
      poolFiles.push(rel);
    }
  }

  files[SEED_UNRELATED_FEATURE_FILE] = readSeedFile(
    SEED_UNRELATED_FEATURE_FILE,
  );
  sourceFiles.push(SEED_UNRELATED_FEATURE_FILE);
  backgroundFiles.push(SEED_UNRELATED_FEATURE_FILE);

  const remainingBackgroundFiles = fileCount - sourceFiles.length;
  if (remainingBackgroundFiles < 0) {
    throw new Error(
      `Cannot fit ${String(sourceFiles.length)} base files into fileCount=${String(fileCount)}`,
    );
  }
  for (let i = 1; i <= remainingBackgroundFiles; i += 1) {
    const rel = `src/features/feature-module-${pad3(i)}.ts`;
    files[rel] = renderGeneratedFeatureModule(i);
    sourceFiles.push(rel);
    backgroundFiles.push(rel);
  }

  const sortedSources = [...sourceFiles].toSorted();
  assert.equal(
    sortedSources.length,
    fileCount,
    `Generated source count mismatch: expected ${String(fileCount)}, got ${String(sortedSources.length)}`,
  );

  const violatingSource = files[SEED_VIOLATING_POOL_FILE]!;
  const violatingLine = findExactLineNumber(
    violatingSource,
    "const resourceLabels = this._register(",
    SEED_VIOLATING_POOL_FILE,
  );

  return {
    scale: { fileCount, candidateFactoryCount },
    files,
    sourceFiles: sortedSources,
    poolFiles: [...poolFiles].toSorted(),
    backgroundFiles: [...backgroundFiles].toSorted(),
    violatingFile: SEED_VIOLATING_POOL_FILE,
    violatingLine,
    unrelatedFile: SEED_UNRELATED_FEATURE_FILE,
  };
}

/**
 * Replaces the neutral acceptance app files with the generated pool-ownership
 * project for `scale` while leaving installed packed artifacts intact.
 */
export function materializePoolOwnershipHost(
  host: PreparedAcceptanceHost,
  scale: PoolOwnershipScaleSpec = POOL_OWNERSHIP_SMALL_SCALE,
  appSubdir: string = DEFAULT_APP_SUBDIR,
): PoolOwnershipMaterializedSpec {
  const generated = generatePoolOwnershipProject(scale);

  rmSync(host.resolvePath(`${appSubdir}/src`), {
    recursive: true,
    force: true,
  });
  for (const staleConfig of [
    `${appSubdir}/verule.config.ts`,
    `${appSubdir}/verule.native.config.ts`,
    `${appSubdir}/verule.missing-adapter.config.ts`,
  ]) {
    const stalePath = host.resolvePath(staleConfig);
    if (existsSync(stalePath)) {
      rmSync(stalePath, { force: true });
    }
  }

  for (const [relPath, content] of Object.entries(generated.files)) {
    host.writeText(`${appSubdir}/${relPath}`, content);
  }
  host.writeText(
    "tsconfig.json",
    renderHostTsconfig(`${appSubdir}/src/**/*.ts`),
  );

  const prefix = `${appSubdir}/`;
  return {
    scale: generated.scale,
    appSubdir,
    configPath: `${prefix}verule.config.ts`,
    tsconfigPath: `${prefix}tsconfig.json`,
    sourceFiles: generated.sourceFiles.map((file) => `${prefix}${file}`),
    poolFiles: generated.poolFiles.map((file) => `${prefix}${file}`),
    backgroundFiles: generated.backgroundFiles.map(
      (file) => `${prefix}${file}`,
    ),
    violatingFile: `${prefix}${generated.violatingFile}`,
    violatingLine: generated.violatingLine,
    unrelatedFile: `${prefix}${generated.unrelatedFile}`,
    probeFile: `${prefix}${PROBE_RELATIVE_FILE}`,
  };
}

export type WithPoolOwnershipHostOptions = {
  readonly scale?: PoolOwnershipScaleSpec;
  readonly bundle?: PackedArtifactBundle;
  readonly tempRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

/**
 * Prepares an isolated out-of-repo acceptance host with packed Verule CLI, SDK,
 * engine, and `@verule/rules-reference` artifacts, materialized with the
 * requested pool-ownership tier and guaranteed LIFO cleanup.
 */
export async function withPoolOwnershipHost<T>(
  options: WithPoolOwnershipHostOptions,
  callback: (
    host: PreparedAcceptanceHost,
    spec: PoolOwnershipMaterializedSpec,
  ) => Promise<T>,
): Promise<T> {
  return withAcceptanceHost(
    {
      additionalPackages: [
        "@verule/rules-reference",
        "@verule/adapter-drizzle",
        "@verule/adapter-zod",
      ],
      directPackages: ["@boringparts/verule", "@verule/rules-reference"],
      ...(options.bundle === undefined ? {} : { bundle: options.bundle }),
      ...(options.tempRoot === undefined ? {} : { tempRoot: options.tempRoot }),
      ...(options.env === undefined ? {} : { env: options.env }),
    },
    async (host) => {
      const spec = materializePoolOwnershipHost(
        host,
        options.scale ?? POOL_OWNERSHIP_SMALL_SCALE,
      );
      return callback(host, spec);
    },
  );
}

const BUGGY_LIST_IMPORT_AND_FACTORY = [
  "import {",
  "  Disposable,",
  "  ResourcePool,",
  "  type IDisposable,",
  '} from "../platform/lifecycle.ts";',
].join("\n");

const FIXED_LIST_IMPORT_AND_FACTORY = [
  "import {",
  "  Disposable,",
  "  DisposableStore,",
  "  ResourcePool,",
  "  type IDisposable,",
  '} from "../platform/lifecycle.ts";',
].join("\n");

const BUGGY_LIST_FACTORY_BODY = [
  "  private listFactory(): ICollapsibleListPoolItem {",
  "    const resourceLabels = this._register(",
  "      this.instantiationService.createInstance(ResourceLabels),",
  "    );",
  "    const list = this.instantiationService.createInstance(",
  "      WorkbenchList,",
  "      resourceLabels,",
  "      this.context.panelId,",
  "    );",
  "    return {",
  "      list,",
  "      dispose: () => list.dispose(),",
  "    };",
  "  }",
].join("\n");

const FIXED_LIST_FACTORY_BODY = [
  "  private listFactory(): ICollapsibleListPoolItem {",
  "    const store = new DisposableStore();",
  "    const resourceLabels = store.add(",
  "      this.instantiationService.createInstance(ResourceLabels),",
  "    );",
  "    const list = this.instantiationService.createInstance(",
  "      WorkbenchList,",
  "      resourceLabels,",
  "      this.context.panelId,",
  "    );",
  "    return {",
  "      list,",
  "      dispose: () => {",
  "        list.dispose();",
  "        store.dispose();",
  "      },",
  "    };",
  "  }",
].join("\n");

function replaceFileSegments(
  host: PreparedAcceptanceHost,
  relativePath: string,
  replacements: readonly (readonly [string, string])[],
): void {
  let content = host.readText(relativePath);
  for (const [search, replacement] of replacements) {
    if (!content.includes(search)) {
      throw new Error(
        `Expected ${relativePath} to contain ${JSON.stringify(search)}`,
      );
    }
    content = content.replace(search, replacement);
  }
  host.writeText(relativePath, content);
}

/** Moves `CollapsibleListPool`'s `ResourceLabels` from outer `this._register` to an item-owned `DisposableStore`. */
export function fixPoolOwnershipViolation(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
): void {
  replaceFileSegments(host, spec.violatingFile, [
    [BUGGY_LIST_IMPORT_AND_FACTORY, FIXED_LIST_IMPORT_AND_FACTORY],
    [BUGGY_LIST_FACTORY_BODY, FIXED_LIST_FACTORY_BODY],
  ]);
}

/** Restores `CollapsibleListPool`'s outer `this._register` ownership violation. */
export function restorePoolOwnershipViolation(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
): void {
  replaceFileSegments(host, spec.violatingFile, [
    [FIXED_LIST_IMPORT_AND_FACTORY, BUGGY_LIST_IMPORT_AND_FACTORY],
    [FIXED_LIST_FACTORY_BODY, BUGGY_LIST_FACTORY_BODY],
  ]);
}

/** Appends a comment to an included background `.ts` file without changing semantics. */
export function appendUnrelatedBackgroundComment(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
  marker: string,
): void {
  const current = host.readText(spec.unrelatedFile);
  host.writeText(spec.unrelatedFile, `${current}// ${marker}\n`);
}

function renderProbePoolsFile(fixDrawerViolation: boolean): string {
  const drawerBody = fixDrawerViolation
    ? [
        "  private allocateDrawerEntry(): IDrawerEntry {",
        "    const drawerStore = new DisposableStore();",
        "    const drawerLabels = drawerStore.add(",
        "      this.instantiationService.createInstance(ResourceLabels),",
        "    );",
        "    const list = this.instantiationService.createInstance(",
        "      WorkbenchList,",
        "      drawerLabels,",
        '      "unlisted-drawer",',
        "    );",
        "    return {",
        "      list,",
        "      dispose: () => {",
        "        list.dispose();",
        "        drawerStore.dispose();",
        "      },",
        "    };",
        "  }",
      ].join("\n")
    : [
        "  private allocateDrawerEntry(): IDrawerEntry {",
        "    const drawerLabels = this._register(",
        "      this.instantiationService.createInstance(ResourceLabels),",
        "    );",
        "    const list = this.instantiationService.createInstance(",
        "      WorkbenchList,",
        "      drawerLabels,",
        '      "unlisted-drawer",',
        "    );",
        "    return {",
        "      list,",
        "      dispose: () => list.dispose(),",
        "    };",
        "  }",
      ].join("\n");

  return [
    "import {",
    "  createFileIconThemableTreeContainerScope,",
    "  ResourceLabels,",
    "  WorkbenchList,",
    "  WorkbenchTree,",
    "  type IInstantiationService,",
    '} from "../platform/instantiation.ts";',
    "import {",
    "  Disposable,",
    "  DisposableStore,",
    "  ResourcePool,",
    "  type IDisposable,",
    '} from "../platform/lifecycle.ts";',
    "",
    "export interface IDrawerEntry extends IDisposable {",
    "  readonly list: WorkbenchList;",
    "}",
    "",
    "export interface ISidebarEntry extends IDisposable {",
    "  readonly tree: WorkbenchTree;",
    "}",
    "",
    "export class UnlistedExtensionDrawerPool extends Disposable {",
    "  private readonly drawerPool: ResourcePool<IDrawerEntry>;",
    "  private readonly instantiationService: IInstantiationService;",
    "",
    "  constructor(instantiationService: IInstantiationService) {",
    "    super();",
    "    this.instantiationService = instantiationService;",
    "    this.drawerPool = this._register(",
    "      new ResourcePool(() => this.allocateDrawerEntry()),",
    "    );",
    "  }",
    "",
    drawerBody,
    "",
    "  openDrawer(): WorkbenchList {",
    "    return this.drawerPool.get().list;",
    "  }",
    "}",
    "",
    "export class UnlistedExtensionSidebarPool extends Disposable {",
    "  private readonly sidebarPool: ResourcePool<ISidebarEntry>;",
    "  private readonly instantiationService: IInstantiationService;",
    "",
    "  constructor(instantiationService: IInstantiationService) {",
    "    super();",
    "    this.instantiationService = instantiationService;",
    "    this.sidebarPool = this._register(",
    "      new ResourcePool(() => this.allocateSidebarEntry()),",
    "    );",
    "  }",
    "",
    "  private allocateSidebarEntry(): ISidebarEntry {",
    "    const sidebarStore = new DisposableStore();",
    "    const sidebarLabels = sidebarStore.add(",
    "      this.instantiationService.createInstance(ResourceLabels),",
    "    );",
    "    const sidebarScope = sidebarStore.add(",
    '      createFileIconThemableTreeContainerScope("unlisted-sidebar"),',
    "    );",
    "    const tree = this.instantiationService.createInstance(",
    "      WorkbenchTree,",
    "      sidebarLabels,",
    "      sidebarScope,",
    '      "unlisted-sidebar",',
    "    );",
    "    return {",
    "      tree,",
    "      dispose: () => sidebarStore.dispose(),",
    "    };",
    "  }",
    "",
    "  openSidebar(): WorkbenchTree {",
    "    return this.sidebarPool.get().tree;",
    "  }",
    "}",
    "",
  ].join("\n");
}

/**
 * Adds an unlisted extension pool file in a brand-new directory containing one
 * violating pool and one valid item-owned pool, returning the expected
 * violating line number.
 */
export function addUnlistedProbePoolsFile(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
): { readonly file: string; readonly violatingLine: number } {
  const content = renderProbePoolsFile(false);
  host.writeText(spec.probeFile, content);
  return {
    file: spec.probeFile,
    violatingLine: findExactLineNumber(
      content,
      "const drawerLabels = this._register(",
      spec.probeFile,
    ),
  };
}

/** Fixes the violating factory inside the unlisted probe file to use `DisposableStore`. */
export function fixUnlistedProbePool(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
): void {
  host.writeText(spec.probeFile, renderProbePoolsFile(true));
}

/** Removes the unlisted probe file and its directory from the host project. */
export function removeUnlistedProbePoolsFile(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
): void {
  const probeDir = join(host.resolvePath(spec.probeFile), "..");
  rmSync(probeDir, { recursive: true, force: true });
}

function checkpointEntries(
  details: readonly ObservationDetailEntry[],
  name: string,
): readonly ObservationDetailEntry[] {
  return details.filter(
    (entry) => entry.kind === "checkpoint" && entry.name === name,
  );
}

/**
 * Verifies out-of-band (via a separate `--observe detail` CLI run) that the
 * opened project contains the exact expected deduplicated source file count and
 * that every candidate factory entered ownership judgment.
 */
export async function verifyPoolOwnershipScaleAndCandidates(
  host: PreparedAcceptanceHost,
  spec: PoolOwnershipMaterializedSpec,
  options?: {
    readonly expectedCandidateCount?: number;
    readonly expectedFileCount?: number;
    readonly timeoutMs?: number;
  },
): Promise<PoolOwnershipCandidateAudit> {
  const expectedFileCount = options?.expectedFileCount ?? spec.scale.fileCount;
  const expectedCandidateCount =
    options?.expectedCandidateCount ?? spec.scale.candidateFactoryCount;
  const result = await host.check({
    config: spec.configPath,
    observe: "detail",
    timeoutMs: options?.timeoutMs ?? 60_000,
  });
  const report = result.report;

  assert.equal(
    report.fileOrigins.length,
    expectedFileCount,
    `Expected ${String(expectedFileCount)} deduplicated source files in fileOrigins, got ${String(report.fileOrigins.length)}`,
  );
  assert.equal(
    report.projects.length,
    1,
    `Expected 1 opened tsconfig project, got ${String(report.projects.length)}`,
  );
  assert.equal(
    report.projects[0]!.sourceFiles.length,
    expectedFileCount,
    `Expected ${String(expectedFileCount)} sourceFiles in project`,
  );

  const obs = report.observation;
  assert.ok(obs, "Expected observation report in --observe detail run");
  assert.equal(
    obs.truncated,
    false,
    `Observation detail report unexpectedly truncated (dropped=${String(obs.droppedCount)})`,
  );
  const details = obs.details ?? [];

  const domainCheckpoints = checkpointEntries(
    details,
    "child-ownership-candidate-domain",
  );
  assert.equal(domainCheckpoints.length, 1);
  const domainDetail = domainCheckpoints[0]?.detail as
    | { readonly candidateCallCount?: unknown }
    | undefined;
  assert.equal(
    domainDetail?.candidateCallCount,
    expectedCandidateCount,
    `Expected candidateCallCount=${String(expectedCandidateCount)}, got ${String(domainDetail?.candidateCallCount)}`,
  );

  const seedCheckpoints = checkpointEntries(details, "child-ownership-seed");
  const judgmentCheckpoints = checkpointEntries(
    details,
    "child-ownership-reverse-domain",
  );
  assert.equal(
    seedCheckpoints.length,
    expectedCandidateCount,
    `Expected ${String(expectedCandidateCount)} child-ownership-seed checkpoints, got ${String(seedCheckpoints.length)}`,
  );
  assert.equal(
    judgmentCheckpoints.length,
    expectedCandidateCount,
    `Expected ${String(expectedCandidateCount)} child-ownership-reverse-domain checkpoints, got ${String(judgmentCheckpoints.length)}`,
  );

  return {
    fileCount: report.fileOrigins.length,
    candidateCallCount: expectedCandidateCount,
    seedCheckpointCount: seedCheckpoints.length,
    judgmentCheckpointCount: judgmentCheckpoints.length,
    report,
  };
}

/** Asserts that `diag` points to the expected outer `this._register` violation with model & source evidence. */
export function assertPoolOwnershipDiagnostic(
  diag: Diagnostic,
  expectedFile: string,
  expectedLine: number,
  expectedClassOrFactoryText?: string,
): void {
  assert.equal(diag.ruleId, "pool-resource-ownership");
  assert.equal(diag.at.file, expectedFile);
  assert.equal(diag.at.line, expectedLine);
  assert.match(diag.message, /outer host container/iu);
  assert.match(diag.message, /Disposable\._register/u);
  assert.ok(
    diag.evidence.some(
      (ev) =>
        ev.kind === "model" &&
        ev.modelId === "pool-resource-ownership" &&
        ev.at?.file === expectedFile,
    ),
    `Expected pool-resource-ownership model evidence: ${JSON.stringify(diag.evidence)}`,
  );
  assert.ok(
    diag.evidence.some(
      (ev) =>
        ev.kind === "source" &&
        ev.at?.file === expectedFile &&
        ev.at.line === expectedLine,
    ),
    `Expected source evidence at outer registration ${expectedFile}:${String(expectedLine)}: ${JSON.stringify(diag.evidence)}`,
  );
  if (expectedClassOrFactoryText !== undefined) {
    assert.ok(
      diag.evidence.some(
        (ev) =>
          ev.kind === "source" &&
          ev.at?.file === expectedFile &&
          ev.message.includes(expectedClassOrFactoryText),
      ) || diag.message.includes(expectedClassOrFactoryText),
      `Expected evidence referencing ${expectedClassOrFactoryText}: ${JSON.stringify(diag.evidence)}`,
    );
  }
}

/** Asserts the initial state: exact file count, no missing-model gaps, and exactly 1 violation in `CollapsibleListPool`. */
export function assertPoolOwnershipInitialFindings(
  report: CheckReport,
  spec: PoolOwnershipMaterializedSpec,
): void {
  assert.equal(report.status, "findings");
  assert.equal(report.fileOrigins.length, spec.scale.fileCount);
  assert.equal(
    report.gaps.some((gap) => gap.kind === "missing-instance-model"),
    false,
    `Unexpected missing-instance-model gap: ${JSON.stringify(report.gaps)}`,
  );
  assert.equal(
    report.diagnostics.length,
    1,
    `Expected exactly 1 initial diagnostic, got ${JSON.stringify(report.diagnostics)}`,
  );
  assertPoolOwnershipDiagnostic(
    report.diagnostics[0]!,
    spec.violatingFile,
    spec.violatingLine,
  );
}

/** Asserts the clean state: exact file count, zero diagnostics, no missing-model gaps. */
export function assertPoolOwnershipClean(
  report: CheckReport,
  spec: PoolOwnershipMaterializedSpec,
): void {
  assert.equal(report.status, "clean");
  assert.equal(report.fileOrigins.length, spec.scale.fileCount);
  assert.deepEqual(report.diagnostics, []);
  assert.equal(
    report.gaps.some((gap) => gap.kind === "missing-instance-model"),
    false,
    `Unexpected missing-instance-model gap: ${JSON.stringify(report.gaps)}`,
  );
}

/** Reconciles a watch report (or secondary run) against an independent cold `host.check()` report. */
export function assertPoolOwnershipReportsReconcile(
  actual: CheckReport | WatchReportRecord,
  expected: CheckReport,
  label: string,
): void {
  assert.deepEqual(
    {
      status: actual.status,
      fileCount: actual.fileOrigins.length,
      diagnostics: actual.diagnostics,
      gaps: actual.gaps,
      snapshotDigest: actual.identity.snapshotDigest,
    },
    {
      status: expected.status,
      fileCount: expected.fileOrigins.length,
      diagnostics: expected.diagnostics,
      gaps: expected.gaps,
      snapshotDigest: expected.identity.snapshotDigest,
    },
    `Watch/cold check reconciliation failed at "${label}"`,
  );
}
