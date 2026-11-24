import assert from "node:assert/strict";
import { realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  type PreparedAcceptanceHost,
  withAcceptanceHost,
} from "@verule/acceptance";
import type {
  CheckReport,
  FactType,
  NativeAdapterObservation,
  NormalizedVeruleConfig,
  ObservationDetailEntry,
  SyntaxRef,
  VeruleExecutionError,
} from "@verule/sdk";

const packageNames = [
  "@verule/adapter-fixture",
  "@verule/adapter-fixture-complement",
  "@verule/adapter-drizzle",
] as const;
const nativeConfig =
  "packages/app/provider-session-overlay/app/verule.provider-session.native.config.ts";
const rootInputPath = "fixture.inputs.json";
const sourceRelPath =
  "packages/app/provider-session-overlay/app/src/provider-session.ts";

type ProviderSessionFact = FactType<
  "call",
  { readonly mode: "normal" | "conflict" | "targeted-conflict" },
  {
    readonly text?: string;
    readonly input?: string;
    readonly invocation?: number;
    readonly annotation?: string;
    readonly secondaryInvocation?: number;
  }
>;

async function runCliObserveDetail(
  host: PreparedAcceptanceHost,
  configPath: string,
): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return host.runCli([
    "check",
    "--config",
    configPath,
    "--observe",
    "detail",
    "--output",
    "json",
  ]);
}

async function runInstalledSdk(
  host: PreparedAcceptanceHost,
  configPath: string,
): Promise<CheckReport> {
  const sdk = await host.loadSdk();
  const resolvedConfigPath = host.resolvePath(configPath);
  const config = await host.loadConfig<NormalizedVeruleConfig>(configPath);
  return sdk.runCheck({
    cwd: host.hostDir,
    adapterResolutionRoot: dirname(resolvedConfigPath),
    config,
    observe: "detail",
  });
}

function parseCliReport(stdout: string): CheckReport {
  const envelope = JSON.parse(stdout) as {
    readonly kind: string;
    readonly data: CheckReport;
  };
  assert.equal(envelope.kind, "data");
  return envelope.data;
}

function nativeExtractionProviders(report: CheckReport): readonly string[] {
  const isNativeAdapterStep = (
    entry: ObservationDetailEntry,
  ): entry is ObservationDetailEntry & { readonly provider: string } => {
    if (
      entry.kind !== "engineStep" ||
      typeof entry.detail !== "object" ||
      entry.detail === null ||
      !("kind" in entry.detail)
    ) {
      return false;
    }
    return (
      entry.detail.kind === "nativeAdapterFact" && entry.provider !== undefined
    );
  };
  return [
    ...new Set(
      (report.observation?.details ?? [])
        .filter(isNativeAdapterStep)
        .map((entry) => entry.provider),
    ),
  ].toSorted();
}

function nativeAdapterObservations(
  report: CheckReport,
): readonly NativeAdapterObservation[] {
  return (report.observation?.nativeAdapters ?? []).toSorted((left, right) =>
    left.packageName.localeCompare(right.packageName),
  );
}

function assertReportsAlign(
  actual: CheckReport,
  expected: CheckReport,
  label: string,
): void {
  assert.deepEqual(
    {
      status: actual.status,
      projects: actual.projects,
      fileOrigins: actual.fileOrigins,
      additionalInputs: actual.additionalInputs,
      diagnostics: actual.diagnostics,
      gaps: actual.gaps,
      identity: actual.identity,
    },
    {
      status: expected.status,
      projects: expected.projects,
      fileOrigins: expected.fileOrigins,
      additionalInputs: expected.additionalInputs,
      diagnostics: expected.diagnostics,
      gaps: expected.gaps,
      identity: expected.identity,
    },
    `Report diverged from the independent check at "${label}"`,
  );
}

void test("loads independent native providers together and updates facts across shared snapshots", async () => {
  await withAcceptanceHost(
    {
      overlay: "provider-session",
      additionalPackages: [...packageNames],
    },
    async (host) => {
      const noAdapters = await runCliObserveDetail(
        host,
        "packages/app/verule.config.ts",
      );
      assert.equal(noAdapters.status, 1, noAdapters.stderr + noAdapters.stdout);
      const baselineReport = parseCliReport(noAdapters.stdout);
      assert.deepEqual(nativeExtractionProviders(baselineReport), []);
      assert.deepEqual(nativeAdapterObservations(baselineReport), []);
      assert.deepEqual(baselineReport.observation?.engineExtractions, {});

      const unqueried = await runCliObserveDetail(
        host,
        "packages/app/provider-session-overlay/app/verule.provider-session.unqueried.config.ts",
      );
      assert.equal(unqueried.status, 1, unqueried.stderr + unqueried.stdout);
      const unqueriedReport = parseCliReport(unqueried.stdout);
      assert.deepEqual(nativeExtractionProviders(unqueriedReport), []);
      assert.deepEqual(nativeAdapterObservations(unqueriedReport), [
        {
          packageName: "@verule/adapter-drizzle",
          providerId: "drizzle",
          status: "loaded",
        },
        {
          packageName: "@verule/adapter-fixture",
          providerId: "third-party-fixture",
          status: "loaded",
        },
        {
          packageName: "@verule/adapter-fixture-complement",
          providerId: "third-party-fixture-complement",
          status: "loaded",
        },
      ]);
      assert.deepEqual(unqueriedReport.observation?.engineExtractions, {});

      const queried = await host.check({
        config: nativeConfig,
        observe: "detail",
      });
      assert.equal(queried.status, 1, queried.stderr + queried.stdout);
      const report = queried.report;
      const factDiagnostic = report.diagnostics.find(
        (diagnostic) => diagnostic.ruleId === "provider-session-facts",
      );
      assert.ok(factDiagnostic, JSON.stringify(report.diagnostics));
      assert.deepEqual(
        factDiagnostic.evidence.map((item) => item.message).toSorted(),
        [
          "Complement fixture adapter read this call from the active snapshot.",
          "Fixture adapter read this call from the active snapshot.",
        ],
      );
      assert.match(factDiagnostic.message, /"text":"getProduct\(id\)"/u);
      assert.match(factDiagnostic.message, /"input":"host-installed-input"/u);
      assert.match(
        factDiagnostic.message,
        /"annotation":"complement:host-installed-input"/u,
      );

      const factQueries = (report.observation?.details ?? []).filter(
        (detail) =>
          detail.kind === "query" &&
          detail.name === "facts:fixture.call-source",
      );
      assert.deepEqual(
        factQueries
          .map((query) => query.cacheStatus)
          .toSorted((left, right) => String(left).localeCompare(String(right))),
        ["computed", "reused"],
      );
      assert.deepEqual(nativeExtractionProviders(report), [
        "drizzle",
        "third-party-fixture",
        "third-party-fixture-complement",
      ]);
      assert.deepEqual(nativeAdapterObservations(report), [
        {
          packageName: "@verule/adapter-drizzle",
          providerId: "drizzle",
          status: "loaded",
        },
        {
          packageName: "@verule/adapter-fixture",
          providerId: "third-party-fixture",
          status: "loaded",
        },
        {
          packageName: "@verule/adapter-fixture-complement",
          providerId: "third-party-fixture-complement",
          status: "loaded",
        },
      ]);
      for (const providerId of [
        "drizzle",
        "third-party-fixture",
        "third-party-fixture-complement",
      ]) {
        assert.ok(
          (report.observation?.engineExtractions[providerId]?.extractions ??
            0) > 0,
          `expected extraction count for ${providerId}`,
        );
      }
      assert.equal(
        report.projects[0]?.sourceFiles.includes(
          "packages/data/src/provider-session-query.ts",
        ),
        true,
      );

      const initialInput = host.readText(rootInputPath);
      const initialSource = host.readText(sourceRelPath);
      const sdk = await host.loadSdk();
      const configPath = host.resolvePath(nativeConfig);
      const config =
        await host.loadConfig<NormalizedVeruleConfig>(nativeConfig);
      const providerSessionRules = (await import(
        pathToFileURL(
          join(
            host.appDir,
            "provider-session-overlay/app/src/provider-session-rules.ts",
          ),
        ).href
      )) as {
        readonly lastComplementInvocation: number | undefined;
        readonly providerSessionFact: ProviderSessionFact;
      };

      const targetConflictProbe = sdk.defineRule({
        id: "provider-session-target-conflict-cache",
        run: async (ctx) => {
          const syntax = (
            await ctx.findSyntax({
              files: [sourceRelPath],
              kinds: ["CallExpression"],
              textIncludes: ["getProduct(id)"],
            })
          )[0];
          assert.ok(syntax);
          const [resolved] = await ctx.resolveCalls([syntax.ref]);
          assert.ok(resolved?.call);

          const condition = { mode: "targeted-conflict" as const };
          const full = await ctx.facts(
            providerSessionRules.providerSessionFact,
            { condition },
          );
          const fullProduct = full.find(
            (fact) => fact.value.text === "getProduct(id)",
          );
          assert.ok(fullProduct, JSON.stringify(full));
          const expectedInput = host.readText(rootInputPath);
          assert.equal(fullProduct.value.input, expectedInput);
          assert.notEqual(fullProduct.subject.handleId, resolved.call.handleId);

          const query = {
            condition,
            targets: [resolved.call],
          };
          await assert.rejects(
            ctx.facts(providerSessionRules.providerSessionFact, query),
            (error: unknown) => {
              assert.ok(error instanceof Error);
              const conflictError = error as VeruleExecutionError;
              assert.equal(conflictError.code, "FACT_CONFLICT");
              assert.deepEqual(
                conflictError.conflict?.parties.map(
                  (party) => party.providerId,
                ),
                ["third-party-fixture", "third-party-fixture-complement"],
              );
              assert.ok(
                conflictError.conflict?.parties.some((party) =>
                  party.evidence.some((item) =>
                    item.message.includes("Fixture adapter read this call"),
                  ),
                ),
              );
              assert.ok(
                conflictError.conflict?.parties.some((party) =>
                  party.evidence.some((item) =>
                    item.message.includes(
                      "Complement fixture adapter read this call",
                    ),
                  ),
                ),
              );
              return true;
            },
          );

          host.writeText(rootInputPath, JSON.stringify("target-retry-input"));
          const recovered = await ctx.facts(
            providerSessionRules.providerSessionFact,
            query,
          );
          assert.equal(recovered.length, 1);
          const retryInput = host.readText(rootInputPath);
          assert.notEqual(retryInput, expectedInput);
          assert.equal(recovered[0]?.value.input, retryInput);
          assert.ok(
            recovered[0]!.value.secondaryInvocation! >
              fullProduct.value.secondaryInvocation!,
          );
        },
      });

      const conflictCacheSession = await sdk.openSession({
        cwd: host.hostDir,
        config: { ...config, rules: [targetConflictProbe] },
        adapterResolutionRoot: dirname(configPath),
      });
      try {
        await conflictCacheSession.check();
      } finally {
        host.writeText(rootInputPath, initialInput);
        await conflictCacheSession.close();
      }

      const session = await host.startSession({ config: nativeConfig });
      try {
        const sourceFiles = [...session.projects[0]!.sourceFiles];
        const initial = (await session.check({ observe: "detail" })).report;
        assertReportsAlign(
          initial,
          await runInstalledSdk(host, nativeConfig),
          "shared-initial",
        );
        assert.deepEqual(initial.projects[0]?.sourceFiles, sourceFiles);

        host.writeText(rootInputPath, JSON.stringify("host-edited-input"));
        const editedInput = (await session.check({ observe: "detail" })).report;
        const coldEditedInput = await runInstalledSdk(host, nativeConfig);
        assertReportsAlign(editedInput, coldEditedInput, "shared-input-edited");
        assert.deepEqual(nativeAdapterObservations(editedInput), [
          {
            packageName: "@verule/adapter-drizzle",
            providerId: "drizzle",
            status: "reused",
          },
          {
            packageName: "@verule/adapter-fixture",
            providerId: "third-party-fixture",
            status: "reused",
          },
          {
            packageName: "@verule/adapter-fixture-complement",
            providerId: "third-party-fixture-complement",
            status: "reused",
          },
        ]);
        assert.deepEqual(editedInput.projects[0]?.sourceFiles, sourceFiles);
        assert.equal(editedInput.additionalInputs.length, 1);
        assert.deepEqual(editedInput.additionalInputs[0]?.sources, [
          { kind: "config" },
          { kind: "adapter", id: "third-party-fixture" },
          { kind: "adapter", id: "third-party-fixture-complement" },
          { kind: "rule", id: "provider-session-cache" },
          { kind: "rule", id: "provider-session-facts" },
        ]);
        assert.match(
          editedInput.diagnostics.find(
            (item) => item.ruleId === "provider-session-facts",
          )?.message ?? "",
          /host-edited-input/u,
        );

        host.replaceText(
          sourceRelPath,
          "getProduct(id)",
          "getProduct(productId)",
        );
        const editedSource = (await session.check({ observe: "detail" }))
          .report;
        assertReportsAlign(
          editedSource,
          await runInstalledSdk(host, nativeConfig),
          "shared-source-edited",
        );
        assert.deepEqual(
          nativeAdapterObservations(editedSource).map(
            (adapter) => adapter.status,
          ),
          ["reused", "reused", "reused"],
        );
        assert.deepEqual(editedSource.projects[0]?.sourceFiles, sourceFiles);
        assert.match(
          editedSource.diagnostics.find(
            (item) => item.ruleId === "provider-session-facts",
          )?.message ?? "",
          /getProduct\(productId\)/u,
        );

        host.writeText(sourceRelPath, initialSource);
        host.writeText(rootInputPath, initialInput);
        const restored = (await session.check({ observe: "detail" })).report;
        assertReportsAlign(
          restored,
          await runInstalledSdk(host, nativeConfig),
          "shared-restored",
        );
        assert.deepEqual(restored.projects[0]?.sourceFiles, sourceFiles);
      } finally {
        await session.close();
      }

      const watch = await host.startWatch({ config: nativeConfig });
      try {
        const first = await watch.nextReport();
        assertReportsAlign(
          first,
          await runInstalledSdk(host, nativeConfig),
          "watch-initial",
        );

        host.writeText(rootInputPath, JSON.stringify("host-watch-input"));
        const changed = await watch.nextReport();
        assert.equal(changed.trigger, "change");
        assertReportsAlign(
          changed,
          await runInstalledSdk(host, nativeConfig),
          "watch-input-edited",
        );

        host.writeText(rootInputPath, initialInput);
        const restored = await watch.nextReport();
        assertReportsAlign(
          restored,
          await runInstalledSdk(host, nativeConfig),
          "watch-input-restored",
        );
      } finally {
        await watch.close();
      }

      let capturedRef: SyntaxRef | undefined;
      const captureRefRule = sdk.defineRule({
        id: "provider-session-capture-ref",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({
            files: [sourceRelPath],
            kinds: ["CallExpression"],
          });
          capturedRef = calls[0]?.ref;
        },
      });
      const editSession = await sdk.openSession({
        cwd: host.hostDir,
        config: {
          ...config,
          rules: [...config.rules, captureRefRule],
        },
        adapterResolutionRoot: dirname(configPath),
        observe: "detail",
      });
      try {
        const initialSnapshotId = editSession.snapshotId;
        const initialSessionReport = await editSession.check();
        assert.deepEqual(nativeExtractionProviders(initialSessionReport), [
          "drizzle",
          "third-party-fixture",
          "third-party-fixture-complement",
        ]);
        assert.ok(
          capturedRef,
          "expected a syntax reference from the initial snapshot",
        );
        assert.equal(providerSessionRules.lastComplementInvocation, 1);

        host.replaceText(
          sourceRelPath,
          "getProduct(id)",
          "getProduct(productId)",
        );
        const sourceUpdate = await editSession.update({
          changed: [sourceRelPath],
        });
        assert.notEqual(sourceUpdate.snapshotId, initialSnapshotId);
        await assert.rejects(
          () =>
            editSession.check([
              sdk.defineRule({
                id: "provider-session-use-stale-ref",
                run: async (ctx) => {
                  await ctx.typeAt([capturedRef!]);
                },
              }),
            ]),
          (error: unknown) =>
            (error as VeruleExecutionError).code === "STALE_REFERENCE",
        );

        const editedSessionReport = await editSession.check();
        const editedSessionFact = editedSessionReport.diagnostics.find(
          (diagnostic) => diagnostic.ruleId === "provider-session-facts",
        );
        assert.match(
          editedSessionFact?.message ?? "",
          /getProduct\(productId\)/u,
        );
        assert.equal(providerSessionRules.lastComplementInvocation, 2);
        assert.deepEqual(nativeExtractionProviders(editedSessionReport), [
          "drizzle",
          "third-party-fixture",
          "third-party-fixture-complement",
        ]);
      } finally {
        host.writeText(sourceRelPath, initialSource);
        await editSession.close();
      }

      const filtered = await host.check({
        config:
          "packages/app/provider-session-overlay/app/verule.provider-session.filtered.config.ts",
        observe: "detail",
      });
      assert.equal(filtered.status, 1, filtered.stderr + filtered.stdout);
      assert.deepEqual(nativeExtractionProviders(filtered.report), [
        "third-party-fixture-complement",
      ]);

      const replacement = await host.check({
        config:
          "packages/app/provider-session-overlay/app/verule.provider-session.replacement.config.ts",
        observe: "detail",
      });
      assert.equal(
        replacement.status,
        1,
        replacement.stderr + replacement.stdout,
      );
      assert.match(
        replacement.report.diagnostics[0]?.message ?? "",
        /complement:host-installed-input/u,
      );
      assert.deepEqual(nativeExtractionProviders(replacement.report), [
        "third-party-fixture-complement",
      ]);

      const sdkError = async (
        configName: string,
      ): Promise<VeruleExecutionError> => {
        try {
          await runInstalledSdk(
            host,
            `packages/app/provider-session-overlay/app/${configName}`,
          );
        } catch (error) {
          assert.equal((error as VeruleExecutionError).code, "FACT_CONFLICT");
          return error as VeruleExecutionError;
        }
        assert.fail("Expected the Rust provider contributions to conflict.");
      };
      const forwardError = await sdkError(
        "verule.provider-session.conflict-forward.config.ts",
      );
      const reverseError = await sdkError(
        "verule.provider-session.conflict-reverse.config.ts",
      );
      assert.equal(forwardError.message, reverseError.message);
      assert.deepEqual(forwardError.conflict, reverseError.conflict);
      assert.deepEqual(
        forwardError.conflict?.parties.map((party) => party.providerId),
        ["third-party-fixture", "third-party-fixture-complement"],
      );
      assert.ok(
        forwardError.message.includes("Fixture adapter read this call"),
      );
      assert.ok(
        forwardError.message.includes(
          "Complement fixture adapter read this call",
        ),
      );

      const conflictCli = await runCliObserveDetail(
        host,
        "packages/app/provider-session-overlay/app/verule.provider-session.conflict-forward.config.ts",
      );
      assert.equal(conflictCli.status, 2);
      assert.ok(
        `${conflictCli.stdout}\n${conflictCli.stderr}`.includes(
          "Complement fixture adapter read this call",
        ),
      );
      assert.ok(
        `${conflictCli.stdout}\n${conflictCli.stderr}`.includes(
          "Fixture adapter read this call",
        ),
      );

      assert.ok(
        realpathSync(
          createRequire(join(host.hostDir, "package.json")).resolve(
            "@verule/adapter-fixture-complement/verule-adapter",
          ),
        ).startsWith(host.hostDir),
      );
    },
  );
});
