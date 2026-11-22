import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import {
  packWorkspaceArtifacts,
  type PackedArtifact,
  type PackedArtifactBundle,
} from "./artifacts.ts";
import {
  prepareHostWithArtifacts,
  type PreparedHostWithArtifacts,
} from "./host-install.ts";
import { runBareVeruleInHost } from "./isolation.ts";
import { verifyHostArtifactResolution } from "./verify.ts";

export const OPENSTATUS_EXTENSION_PACKAGES: readonly string[] = [
  "@verule/adapter-zod",
  "@verule/adapter-drizzle",
  "@verule/rules-reference",
];

export const OPENSTATUS_DIRECT_PACKAGES: readonly string[] = [
  "@verule/sdk",
  "@verule/cli",
  ...OPENSTATUS_EXTENSION_PACKAGES,
];

export const OPENSTATUS_WHOAMI_PROJECTS: readonly string[] = [
  "apps/server/tsconfig.json",
  "packages/db/tsconfig.json",
];

export const OPENSTATUS_GET_GATE_PROJECTS: readonly string[] = [
  "packages/api/tsconfig.json",
  "packages/db/tsconfig.json",
];

export type OpenStatusWhoamiStep = {
  readonly kind: "upstream-commit";
  readonly label: "initial" | "fix-typo" | "remove-field";
  readonly sha: string;
  readonly description: string;
  readonly targetFile: string;
  readonly expectedMissingFields: readonly string[];
  readonly expectedDiagnosticCountAtTarget: number;
};

export const OPENSTATUS_WHOAMI_STEPS: readonly OpenStatusWhoamiStep[] = [
  {
    kind: "upstream-commit",
    label: "initial",
    sha: "f8cbf5f4a0565b8b14bfa7272aaf9abbc6b778bf",
    description:
      "Initial whoami implementation with typo `slub` and absent `workspaceId`",
    targetFile: "apps/server/src/v1/whoami/get.ts",
    expectedMissingFields: ["slub", "workspaceId"],
    expectedDiagnosticCountAtTarget: 1,
  },
  {
    kind: "upstream-commit",
    label: "fix-typo",
    sha: "f04bd49aaac41f8be05eb821ec6442e763e6c86f",
    description: "Upstream typo fix `slub -> slug`; `workspaceId` remains missing",
    targetFile: "apps/server/src/v1/whoami/get.ts",
    expectedMissingFields: ["workspaceId"],
    expectedDiagnosticCountAtTarget: 1,
  },
  {
    kind: "upstream-commit",
    label: "remove-field",
    sha: "f2840732f3f2879ccb1695a7a42513aeaf274cb3",
    description: "Upstream removal of `workspaceId`; diagnostic retracted",
    targetFile: "apps/server/src/v1/whoami/get.ts",
    expectedMissingFields: [],
    expectedDiagnosticCountAtTarget: 0,
  },
];

export const OPENSTATUS_GET_GATE_SHA =
  "090709ad0a4c838215c321cf3d0cb76447cd4b5d";

export const OPENSTATUS_GET_GATE_FILE = "packages/api/src/router/statusPage.ts";

export type OpenStatusGetGateStep = {
  readonly kind: "baseline" | "manual-edit";
  readonly label: "original" | "remove-slug-column" | "restore-slug-column";
  readonly description: string;
  readonly targetFile: string;
  readonly expectedMissingFieldsAtGate: readonly string[];
  readonly expectedMissingFieldsAtWorkspace: readonly string[];
  readonly expectedDiagnosticCountInGetGate: number;
};

export const OPENSTATUS_GET_GATE_STEPS: readonly OpenStatusGetGateStep[] = [
  {
    kind: "baseline",
    label: "original",
    description:
      "Fixed upstream getGate source: both `_page.workspace` and `rest` validations pass",
    targetFile: OPENSTATUS_GET_GATE_FILE,
    expectedMissingFieldsAtGate: [],
    expectedMissingFieldsAtWorkspace: [],
    expectedDiagnosticCountInGetGate: 0,
  },
  {
    kind: "manual-edit",
    label: "remove-slug-column",
    description:
      "Manual edit in temporary checkout removing `slug: true,` from getGate findFirst columns",
    targetFile: OPENSTATUS_GET_GATE_FILE,
    expectedMissingFieldsAtGate: ["slug"],
    expectedMissingFieldsAtWorkspace: [],
    expectedDiagnosticCountInGetGate: 1,
  },
  {
    kind: "manual-edit",
    label: "restore-slug-column",
    description:
      "Manual edit in temporary checkout restoring `slug: true,` to getGate findFirst columns",
    targetFile: OPENSTATUS_GET_GATE_FILE,
    expectedMissingFieldsAtGate: [],
    expectedMissingFieldsAtWorkspace: [],
    expectedDiagnosticCountInGetGate: 0,
  },
];

export type CliLocation = {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly start: number;
  readonly end: number;
};

export type CliEvidence = {
  readonly kind: string;
  readonly message: string;
  readonly at?: CliLocation;
};

export type CliDiagnostic = {
  readonly id: string;
  readonly ruleId: string;
  readonly message: string;
  readonly at: CliLocation;
  readonly evidence: readonly CliEvidence[];
};

export type CliExplainCheckpoint = {
  readonly name: string;
  readonly ruleId: string;
  readonly projectId: string;
  readonly outcome: "pass" | "exclude" | "info";
  readonly at?: CliLocation;
  readonly detail?: unknown;
};

export type CliExplainResult = {
  readonly ruleId: string;
  readonly status: string;
  readonly inCandidates: boolean;
  readonly summary: string;
  readonly projectsChecked: readonly string[];
  readonly matchingCandidates: readonly CliLocation[];
  readonly checkpoints: readonly CliExplainCheckpoint[];
  readonly providers: readonly string[];
};

export type CliCheckPayload = {
  readonly kind: "data";
  readonly variant: "clean" | "findings";
  readonly data: {
    readonly status: "clean" | "findings";
    readonly projects: readonly {
      readonly projectId: string;
      readonly configPath: string;
      readonly sourceFiles: readonly string[];
    }[];
    readonly fileOrigins: readonly { readonly file: string }[];
    readonly diagnostics: readonly CliDiagnostic[];
    readonly gaps: readonly {
      readonly kind: string;
      readonly message: string;
      readonly at?: CliLocation;
    }[];
    readonly explanation?: CliExplainResult;
    readonly observation?: {
      readonly providers: readonly string[];
      readonly candidateCount: number;
      readonly checkpointCount: number;
    };
  };
};

export type OpenStatusArtifactDigest = {
  readonly name: string;
  readonly version: string;
  readonly size: number;
  readonly sha256: string;
  readonly binarySha256?: string;
};

export type OpenStatusProjectCoverage = {
  readonly projectId: string;
  readonly configPath: string;
  readonly sourceFileCount: number;
};

export type OpenStatusReplayRecord = {
  readonly scenario: "openstatus-whoami" | "openstatus-get-gate";
  readonly kind: "upstream-commit" | "baseline" | "manual-edit";
  readonly label: string;
  readonly sha: string;
  readonly exitCode: number;
  readonly status: "clean" | "findings";
  readonly preparationMs: number;
  readonly coldCheckMs: number;
  readonly totalSourceFiles: number;
  readonly projects: readonly OpenStatusProjectCoverage[];
  readonly targetDiagnostics: readonly CliDiagnostic[];
  readonly allDiagnosticsCount: number;
  readonly engineBinarySha256: string;
  readonly auditedSymlinkCount: number;
  readonly explainAtCheckpoints?: readonly {
    readonly at: string;
    readonly status: string;
    readonly checkpoints: readonly CliExplainCheckpoint[];
  }[];
};

export type OpenStatusAcceptanceResult = {
  readonly artifacts: readonly OpenStatusArtifactDigest[];
  readonly configCodeLines: number;
  readonly whoamiReplays: readonly OpenStatusReplayRecord[];
  readonly getGateReplays: readonly OpenStatusReplayRecord[];
};

/**
 * Renders the replayable `verule.config.mjs` used in out-of-repo OpenStatus
 * checkouts, loading all rules and adapters strictly from public package exports.
 */
export function renderOpenStatusVeruleConfig(
  projects: readonly string[],
): string {
  return [
    'import { defineConfig } from "@verule/sdk";',
    'import { drizzleAdapter } from "@verule/adapter-drizzle";',
    'import { zodAdapter } from "@verule/adapter-zod";',
    'import { rowProjectionSatisfiesValidatorRule } from "@verule/rules-reference";',
    "",
    "export default defineConfig({",
    `  projects: ${JSON.stringify(projects)},`,
    "  adapters: [drizzleAdapter, zodAdapter],",
    "  rules: [rowProjectionSatisfiesValidatorRule],",
    "});",
    "",
  ].join("\n");
}

/**
 * Parses JSON emitted by `verule check --output json`.
 */
export function parseCliCheckJson(stdout: string): CliCheckPayload {
  const parsed: unknown = JSON.parse(stdout);
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("kind" in parsed) ||
    parsed.kind !== "data" ||
    !("data" in parsed) ||
    typeof parsed.data !== "object" ||
    parsed.data === null
  ) {
    throw new Error(`Unexpected verule check JSON output: ${stdout.slice(0, 400)}`);
  }
  return parsed as CliCheckPayload;
}

/**
 * Applies or reverts the `getGate` manual column removal edit in a temporary
 * OpenStatus checkout.
 */
export function applyGetGateManualColumnEdit(
  source: string,
  action: "remove-slug" | "restore-slug",
): string {
  const getGateMarker = "getGate: publicProcedure";
  const markerIndex = source.indexOf(getGateMarker);
  if (markerIndex === -1) {
    throw new Error(`Could not locate "${getGateMarker}" in statusPage.ts`);
  }
  const head = source.slice(0, markerIndex);
  const tail = source.slice(markerIndex);
  const slugLine = "          slug: true,\n";
  const anchorLine = "          customDomain: true,\n";

  if (action === "remove-slug") {
    if (!tail.includes(slugLine)) {
      throw new Error(`Could not locate "${slugLine.trim()}" inside getGate`);
    }
    return head + tail.replace(slugLine, "");
  }

  if (tail.includes(slugLine)) {
    return source;
  }
  if (!tail.includes(anchorLine)) {
    throw new Error(`Could not locate "${anchorLine.trim()}" inside getGate`);
  }
  return head + tail.replace(anchorLine, `${slugLine}${anchorLine}`);
}

/**
 * Finds the 1-based line number matching a snippet inside a file, starting at
 * or after an optional anchor substring.
 */
export function findLineContaining(
  source: string,
  snippet: string,
  afterAnchor?: string,
): number {
  const searchStart = afterAnchor ? Math.max(0, source.indexOf(afterAnchor)) : 0;
  const matchIndex = source.indexOf(snippet, searchStart);
  if (matchIndex === -1) {
    throw new Error(`Could not locate "${snippet}" in source`);
  }
  return source.slice(0, matchIndex).split("\n").length;
}

async function runVeruleCheckJson(options: {
  readonly checkoutDir: string;
  readonly args: readonly string[];
  readonly timeoutMs?: number;
}): Promise<{
  readonly exitCode: number;
  readonly payload: CliCheckPayload;
  readonly durationMs: number;
}> {
  const start = performance.now();
  const res = await runBareVeruleInHost({
    checkoutDir: options.checkoutDir,
    args: options.args,
    isolated: false,
    timeoutMs: options.timeoutMs ?? 120_000,
  });
  const durationMs = Math.round((performance.now() - start) * 1000) / 1000;
  if (res.status !== 0 && res.status !== 1) {
    throw new Error(
      `verule ${options.args.join(" ")} failed with exit ${String(res.status)}:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
    );
  }
  return {
    exitCode: res.status,
    payload: parseCliCheckJson(res.stdout),
    durationMs,
  };
}

function summarizeCoverage(payload: CliCheckPayload): {
  readonly totalSourceFiles: number;
  readonly projects: readonly OpenStatusProjectCoverage[];
} {
  return {
    totalSourceFiles: payload.data.fileOrigins.length,
    projects: payload.data.projects.map((p) => ({
      projectId: p.projectId,
      configPath: p.configPath,
      sourceFileCount: p.sourceFiles.length,
    })),
  };
}

async function prepareOpenStatusCheckout(options: {
  readonly sha: string;
  readonly projects: readonly string[];
  readonly artifacts: readonly PackedArtifact[];
  readonly repositoryUrl?: string;
  readonly cacheDir?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<{
  readonly prepared: PreparedHostWithArtifacts;
  readonly preparationMs: number;
  readonly engineBinarySha256: string;
  readonly auditedSymlinkCount: number;
}> {
  const prepStart = performance.now();
  const prepared = await prepareHostWithArtifacts({
    hostId: "openstatus",
    sha: options.sha,
    artifacts: options.artifacts,
    directPackages: OPENSTATUS_DIRECT_PACKAGES,
    ...(options.repositoryUrl === undefined
      ? {}
      : { repositoryUrl: options.repositoryUrl }),
    ...(options.cacheDir === undefined ? {} : { cacheDir: options.cacheDir }),
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (prepared.status === "preparation-failed") {
    throw new Error(
      `Failed to prepare OpenStatus checkout ${options.sha} at ${prepared.stage}: ${prepared.message}\n${prepared.stderr ?? ""}`,
    );
  }

  try {
    const audit = await verifyHostArtifactResolution({
      checkoutDir: prepared.checkout.checkoutDir,
      artifacts: options.artifacts,
      directPackages: OPENSTATUS_DIRECT_PACKAGES,
    });
    writeFileSync(
      join(prepared.checkout.checkoutDir, "verule.config.mjs"),
      renderOpenStatusVeruleConfig(options.projects),
      "utf8",
    );
    const preparationMs =
      Math.round((performance.now() - prepStart) * 1000) / 1000;
    return {
      prepared,
      preparationMs,
      engineBinarySha256: audit.engineBinarySha256,
      auditedSymlinkCount: audit.auditedSymlinkCount,
    };
  } catch (error) {
    prepared.cleanup();
    throw error;
  }
}

/**
 * Packs the 6 workspace artifacts (`@verule/engine`, `@verule/sdk`, `@verule/cli`,
 * `@verule/adapter-zod`, `@verule/adapter-drizzle`, `@verule/rules-reference`),
 * replays the 3 OpenStatus `whoami` commits and the `getGate` original + manual-edit
 * sequence in isolated out-of-repo temporary checkouts, and removes every temporary
 * checkout upon completion.
 */
export async function runOpenStatusProjectionAcceptance(
  options: {
    readonly repositoryUrl?: string;
    readonly cacheDir?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMs?: number;
  } = {},
): Promise<OpenStatusAcceptanceResult> {
  const bundle: PackedArtifactBundle = await packWorkspaceArtifacts({
    additionalPackages: OPENSTATUS_EXTENSION_PACKAGES,
  });

  const artifactDigests: OpenStatusArtifactDigest[] = bundle.artifacts.map(
    (artifact) => ({
      name: artifact.name,
      version: artifact.version,
      size: artifact.size,
      sha256: artifact.sha256,
      ...(artifact.binarySha256 === undefined
        ? {}
        : { binarySha256: artifact.binarySha256 }),
    }),
  );

  const whoamiReplays: OpenStatusReplayRecord[] = [];
  const getGateReplays: OpenStatusReplayRecord[] = [];

  try {
    for (const step of OPENSTATUS_WHOAMI_STEPS) {
      const {
        prepared,
        preparationMs,
        engineBinarySha256,
        auditedSymlinkCount,
      } = await prepareOpenStatusCheckout({
        sha: step.sha,
        projects: OPENSTATUS_WHOAMI_PROJECTS,
        artifacts: bundle.artifacts,
        ...(options.repositoryUrl === undefined
          ? {}
          : { repositoryUrl: options.repositoryUrl }),
        ...(options.cacheDir === undefined
          ? {}
          : { cacheDir: options.cacheDir }),
        ...(options.env === undefined ? {} : { env: options.env }),
      });

      try {
        const checkRun = await runVeruleCheckJson({
          checkoutDir: prepared.checkout.checkoutDir,
          args: ["check", "--output", "json"],
          ...(options.timeoutMs === undefined
            ? {}
            : { timeoutMs: options.timeoutMs }),
        });
        const coverage = summarizeCoverage(checkRun.payload);
        const targetDiagnostics = checkRun.payload.data.diagnostics.filter(
          (diag) => diag.at.file === step.targetFile,
        );
        whoamiReplays.push({
          scenario: "openstatus-whoami",
          kind: step.kind,
          label: step.label,
          sha: step.sha,
          exitCode: checkRun.exitCode,
          status: checkRun.payload.data.status,
          preparationMs,
          coldCheckMs: checkRun.durationMs,
          totalSourceFiles: coverage.totalSourceFiles,
          projects: coverage.projects,
          targetDiagnostics,
          allDiagnosticsCount: checkRun.payload.data.diagnostics.length,
          engineBinarySha256,
          auditedSymlinkCount,
        });
      } finally {
        prepared.cleanup();
        if (existsSync(prepared.checkout.checkoutDir)) {
          throw new Error(
            `Temporary OpenStatus checkout was not cleaned up: ${prepared.checkout.checkoutDir}`,
          );
        }
      }
    }

    const getGatePrepared = await prepareOpenStatusCheckout({
      sha: OPENSTATUS_GET_GATE_SHA,
      projects: OPENSTATUS_GET_GATE_PROJECTS,
      artifacts: bundle.artifacts,
      ...(options.repositoryUrl === undefined
        ? {}
        : { repositoryUrl: options.repositoryUrl }),
      ...(options.cacheDir === undefined
        ? {}
        : { cacheDir: options.cacheDir }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });

    try {
      const checkoutDir = getGatePrepared.prepared.checkout.checkoutDir;
      const statusPagePath = join(checkoutDir, OPENSTATUS_GET_GATE_FILE);
      const originalSource = readFileSync(statusPagePath, "utf8");

      const workspaceValidationLine = findLineContaining(
        originalSource,
        "selectWorkspaceSchema.safeParse(_page.workspace)",
        "getGate: publicProcedure",
      );
      const gateValidationLine = findLineContaining(
        originalSource,
        "gateFieldsSchema.parse(rest)",
        "getGate: publicProcedure",
      );

      // Step 1: Baseline original source
      const baselineCheck = await runVeruleCheckJson({
        checkoutDir,
        args: ["check", "--output", "json"],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      const baselineExplainWorkspace = await runVeruleCheckJson({
        checkoutDir,
        args: [
          "check",
          "--at",
          `${OPENSTATUS_GET_GATE_FILE}:${String(workspaceValidationLine)}`,
          "--output",
          "json",
        ],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      const baselineExplainGate = await runVeruleCheckJson({
        checkoutDir,
        args: [
          "check",
          "--at",
          `${OPENSTATUS_GET_GATE_FILE}:${String(gateValidationLine)}`,
          "--output",
          "json",
        ],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });

      const baselineCoverage = summarizeCoverage(baselineCheck.payload);
      const baselineGetGateDiagnostics =
        baselineCheck.payload.data.diagnostics.filter(
          (diag) =>
            diag.at.file === OPENSTATUS_GET_GATE_FILE &&
            diag.at.line >= workspaceValidationLine - 20 &&
            diag.at.line <= gateValidationLine + 5,
        );
      getGateReplays.push({
        scenario: "openstatus-get-gate",
        kind: OPENSTATUS_GET_GATE_STEPS[0]!.kind,
        label: OPENSTATUS_GET_GATE_STEPS[0]!.label,
        sha: OPENSTATUS_GET_GATE_SHA,
        exitCode: baselineCheck.exitCode,
        status: baselineCheck.payload.data.status,
        preparationMs: getGatePrepared.preparationMs,
        coldCheckMs: baselineCheck.durationMs,
        totalSourceFiles: baselineCoverage.totalSourceFiles,
        projects: baselineCoverage.projects,
        targetDiagnostics: baselineGetGateDiagnostics,
        allDiagnosticsCount: baselineCheck.payload.data.diagnostics.length,
        engineBinarySha256: getGatePrepared.engineBinarySha256,
        auditedSymlinkCount: getGatePrepared.auditedSymlinkCount,
        explainAtCheckpoints: [
          {
            at: `${OPENSTATUS_GET_GATE_FILE}:${String(workspaceValidationLine)}`,
            status:
              baselineExplainWorkspace.payload.data.explanation?.status ??
              "missing",
            checkpoints:
              baselineExplainWorkspace.payload.data.explanation?.checkpoints ??
              [],
          },
          {
            at: `${OPENSTATUS_GET_GATE_FILE}:${String(gateValidationLine)}`,
            status:
              baselineExplainGate.payload.data.explanation?.status ?? "missing",
            checkpoints:
              baselineExplainGate.payload.data.explanation?.checkpoints ?? [],
          },
        ],
      });

      // Step 2: Manual edit removing `slug: true,`
      const editedSource = applyGetGateManualColumnEdit(
        originalSource,
        "remove-slug",
      );
      writeFileSync(statusPagePath, editedSource, "utf8");
      const editedCheck = await runVeruleCheckJson({
        checkoutDir,
        args: ["check", "--output", "json"],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      const editedCoverage = summarizeCoverage(editedCheck.payload);
      const editedGetGateDiagnostics =
        editedCheck.payload.data.diagnostics.filter(
          (diag) =>
            diag.at.file === OPENSTATUS_GET_GATE_FILE &&
            diag.at.line >= workspaceValidationLine - 20 &&
            diag.at.line <= gateValidationLine + 5,
        );
      getGateReplays.push({
        scenario: "openstatus-get-gate",
        kind: OPENSTATUS_GET_GATE_STEPS[1]!.kind,
        label: OPENSTATUS_GET_GATE_STEPS[1]!.label,
        sha: OPENSTATUS_GET_GATE_SHA,
        exitCode: editedCheck.exitCode,
        status: editedCheck.payload.data.status,
        preparationMs: 0,
        coldCheckMs: editedCheck.durationMs,
        totalSourceFiles: editedCoverage.totalSourceFiles,
        projects: editedCoverage.projects,
        targetDiagnostics: editedGetGateDiagnostics,
        allDiagnosticsCount: editedCheck.payload.data.diagnostics.length,
        engineBinarySha256: getGatePrepared.engineBinarySha256,
        auditedSymlinkCount: getGatePrepared.auditedSymlinkCount,
      });

      // Step 3: Manual edit restoring `slug: true,`
      const restoredSource = applyGetGateManualColumnEdit(
        editedSource,
        "restore-slug",
      );
      writeFileSync(statusPagePath, restoredSource, "utf8");
      const restoredCheck = await runVeruleCheckJson({
        checkoutDir,
        args: ["check", "--output", "json"],
        ...(options.timeoutMs === undefined
          ? {}
          : { timeoutMs: options.timeoutMs }),
      });
      const restoredCoverage = summarizeCoverage(restoredCheck.payload);
      const restoredGetGateDiagnostics =
        restoredCheck.payload.data.diagnostics.filter(
          (diag) =>
            diag.at.file === OPENSTATUS_GET_GATE_FILE &&
            diag.at.line >= workspaceValidationLine - 20 &&
            diag.at.line <= gateValidationLine + 5,
        );
      getGateReplays.push({
        scenario: "openstatus-get-gate",
        kind: OPENSTATUS_GET_GATE_STEPS[2]!.kind,
        label: OPENSTATUS_GET_GATE_STEPS[2]!.label,
        sha: OPENSTATUS_GET_GATE_SHA,
        exitCode: restoredCheck.exitCode,
        status: restoredCheck.payload.data.status,
        preparationMs: 0,
        coldCheckMs: restoredCheck.durationMs,
        totalSourceFiles: restoredCoverage.totalSourceFiles,
        projects: restoredCoverage.projects,
        targetDiagnostics: restoredGetGateDiagnostics,
        allDiagnosticsCount: restoredCheck.payload.data.diagnostics.length,
        engineBinarySha256: getGatePrepared.engineBinarySha256,
        auditedSymlinkCount: getGatePrepared.auditedSymlinkCount,
      });
    } finally {
      getGatePrepared.prepared.cleanup();
      if (existsSync(getGatePrepared.prepared.checkout.checkoutDir)) {
        throw new Error(
          `Temporary OpenStatus checkout was not cleaned up: ${getGatePrepared.prepared.checkout.checkoutDir}`,
        );
      }
    }

    const configText = renderOpenStatusVeruleConfig(OPENSTATUS_GET_GATE_PROJECTS);
    const configCodeLines = configText.trimEnd().split("\n").length;

    return {
      artifacts: artifactDigests,
      configCodeLines,
      whoamiReplays,
      getGateReplays,
    };
  } finally {
    bundle.dispose();
  }
}
