import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

import type { CheckReport } from "@verule/sdk";

import {
  packWorkspaceArtifacts,
  type PackedArtifact,
  type PackedArtifactBundle,
} from "./artifacts.ts";
import { prepareHostCheckout } from "./checkout.ts";
import {
  installArtifactsInHost,
  restoreHostDependencies,
} from "./host-install.ts";
import { runBareVeruleInHost, type IsolationEvidence } from "./isolation.ts";
import type { PreparationFailure } from "./types.ts";
import {
  verifyHostArtifactResolution,
  type HostResolutionAudit,
} from "./verify.ts";

export const VUE_REQUEUE_BEFORE_SHA =
  "7257e6a34200409b3fc347d3bb807e11e2785974" as const;
export const VUE_REQUEUE_AFTER_SHA =
  "d18d6aa1b20dc57a8103c51ec4d61e8e53ed936d" as const;

export const VUE_REQUEUE_PACKAGE_BATCH: readonly string[] = [
  "@verule/adapter-drizzle",
  "@verule/adapter-zod",
  "@verule/rules-reference",
];

export const VUE_REQUEUE_DIRECT_PACKAGES: readonly string[] = [
  "@verule/cli",
  "@verule/sdk",
  "@verule/rules-reference",
];

export const VUE_REQUEUE_CONFIG_SOURCE = [
  'import { defineConfig } from "@verule/sdk";',
  "import {",
  "  reentrantQueueFlagRule,",
  "  vueSchedulerQueueModel,",
  '} from "@verule/rules-reference";',
  "",
  "export default defineConfig({",
  '  tsconfig: "tsconfig.json",',
  "  models: [vueSchedulerQueueModel],",
  "  rules: [reentrantQueueFlagRule],",
  "});",
  "",
].join("\n");

export type VueRequeueRevisionLabel = "before" | "after";

export type VueRequeueCliEnvelope = {
  readonly kind: string;
  readonly variant: string;
  readonly data: CheckReport;
};

export type VueRequeueRevisionResult =
  | {
      readonly status: "completed";
      readonly label: VueRequeueRevisionLabel;
      readonly sha: string;
      readonly exitCode: number;
      readonly variant: string;
      readonly report: CheckReport;
      readonly durationMs: number;
      readonly prepareMs: number;
      readonly resolutionAudit: HostResolutionAudit;
      readonly isolation?: IsolationEvidence;
    }
  | PreparationFailure;

export type VueRequeueReplayOutcome = {
  readonly before: VueRequeueRevisionResult;
  readonly after: VueRequeueRevisionResult;
};

export type RunVueRequeueOptions = {
  readonly bundle?: PackedArtifactBundle;
  readonly artifacts?: readonly PackedArtifact[];
  readonly isolated?: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
};

async function runSingleVueRevision(options: {
  readonly label: VueRequeueRevisionLabel;
  readonly sha: string;
  readonly artifacts: readonly PackedArtifact[];
  readonly isolated: boolean;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<VueRequeueRevisionResult> {
  const prepStart = performance.now();
  const checkout = await prepareHostCheckout({
    hostId: "vue",
    sha: options.sha,
    ...(options.env === undefined ? {} : { env: options.env }),
  });
  if (checkout.status === "preparation-failed") {
    return checkout;
  }

  try {
    const restored = await restoreHostDependencies(
      checkout,
      options.env === undefined ? {} : { env: options.env },
    );
    if (restored.status === "preparation-failed") {
      return restored;
    }

    const installed = await installArtifactsInHost({
      hostId: "vue",
      sha: options.sha,
      checkoutDir: checkout.checkoutDir,
      artifacts: options.artifacts,
      directPackages: VUE_REQUEUE_DIRECT_PACKAGES,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    if (installed.status === "preparation-failed") {
      return installed;
    }

    const resolutionAudit = await verifyHostArtifactResolution({
      checkoutDir: checkout.checkoutDir,
      artifacts: options.artifacts,
      directPackages: VUE_REQUEUE_DIRECT_PACKAGES,
    });

    writeFileSync(
      join(checkout.checkoutDir, "verule.config.ts"),
      VUE_REQUEUE_CONFIG_SOURCE,
      "utf8",
    );
    const prepareMs = performance.now() - prepStart;

    const checkStart = performance.now();
    const runResult = await runBareVeruleInHost({
      checkoutDir: checkout.checkoutDir,
      args: ["check", "--output", "json"],
      isolated: options.isolated,
    });
    const durationMs = performance.now() - checkStart;

    if (runResult.status !== 0 && runResult.status !== 1) {
      throw new Error(
        `verule check failed on Vue ${options.label} (${options.sha}) with exit code ${String(runResult.status)}: ${runResult.stderr}\n${runResult.stdout}`,
      );
    }

    const envelope = JSON.parse(runResult.stdout) as VueRequeueCliEnvelope;
    return {
      status: "completed",
      label: options.label,
      sha: options.sha,
      exitCode: runResult.status,
      variant: envelope.variant,
      report: envelope.data,
      durationMs,
      prepareMs,
      resolutionAudit,
      ...(runResult.isolation === undefined
        ? {}
        : { isolation: runResult.isolation }),
    };
  } finally {
    checkout.cleanup();
  }
}

/**
 * Replays the pinned pre-fix (`7257e6a3`) and post-fix (`d18d6aa1`) Vue
 * commits in isolated out-of-repo checkouts using locally packed artifacts.
 */
export async function runVueRequeueReplay(
  options: RunVueRequeueOptions = {},
): Promise<VueRequeueReplayOutcome> {
  const ownedBundle =
    options.bundle === undefined && options.artifacts === undefined
      ? await packWorkspaceArtifacts({
          additionalPackages: VUE_REQUEUE_PACKAGE_BATCH,
        })
      : undefined;
  const artifacts =
    options.artifacts ?? options.bundle?.artifacts ?? ownedBundle!.artifacts;
  const isolated = options.isolated ?? true;

  try {
    const before = await runSingleVueRevision({
      label: "before",
      sha: VUE_REQUEUE_BEFORE_SHA,
      artifacts,
      isolated,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    const after = await runSingleVueRevision({
      label: "after",
      sha: VUE_REQUEUE_AFTER_SHA,
      artifacts,
      isolated,
      ...(options.env === undefined ? {} : { env: options.env }),
    });
    return { before, after };
  } finally {
    ownedBundle?.dispose();
  }
}
