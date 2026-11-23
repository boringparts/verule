import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";

import {
  installArtifactPackages,
  packWorkspaceArtifacts,
  runBareVeruleInHost,
  verifyHostArtifactResolution,
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

import { copyAcceptanceHost } from "./support/host-fixtures.ts";

const packageNames = [
  "@verule/adapter-fixture",
  "@verule/adapter-fixture-complement",
  "@verule/adapter-drizzle",
] as const;
const nativeConfig =
  "packages/app/provider-session-overlay/app/verule.provider-session.native.config.ts";

type CliEnvelope = {
  readonly kind: string;
  readonly data: CheckReport;
};

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

async function runCliCheck(
  hostDir: string,
  storeDir: string,
  configPath: string,
): Promise<{
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}> {
  return runBareVeruleInHost({
    checkoutDir: hostDir,
    args: [
      "check",
      "--config",
      configPath,
      "--observe",
      "detail",
      "--output",
      "json",
    ],
    isolated: true,
    pnpmStoreDir: storeDir,
  });
}

async function runInstalledSdk(
  hostDir: string,
  configPath: string,
): Promise<CheckReport> {
  const hostRequire = createRequire(join(hostDir, "package.json"));
  const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
  const sdk: typeof import("@verule/sdk") = await import(
    pathToFileURL(sdkPath).href
  );
  const resolvedConfigPath = join(hostDir, configPath);
  const configModule = (await import(
    pathToFileURL(resolvedConfigPath).href
  )) as {
    readonly default: NormalizedVeruleConfig;
  };
  return sdk.runCheck({
    cwd: hostDir,
    adapterResolutionRoot: dirname(resolvedConfigPath),
    config: configModule.default,
    observe: "detail",
  });
}

function parseCliReport(stdout: string): CheckReport {
  const envelope = JSON.parse(stdout) as CliEnvelope;
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
  const environmentDir = mkdtempSync(
    join(tmpdir(), "verule-native-provider-session-"),
  );
  const hostDir = join(environmentDir, "host");
  const storeDir = join(environmentDir, "pnpm-store");
  mkdirSync(storeDir);
  const { appDir: hostAppDir } = copyAcceptanceHost(
    hostDir,
    "provider-session",
  );

  const bundle = await packWorkspaceArtifacts({
    additionalPackages: [...packageNames],
  });
  try {
    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      directPackages: ["@verule/sdk", "@verule/cli", ...packageNames],
      storeDir,
    });
    assert.equal(installation.status, "ready", JSON.stringify(installation));

    const noAdapters = await runCliCheck(
      hostDir,
      storeDir,
      "packages/app/verule.config.ts",
    );
    assert.equal(noAdapters.status, 1, noAdapters.stderr + noAdapters.stdout);
    const baselineReport = parseCliReport(noAdapters.stdout);
    assert.deepEqual(nativeExtractionProviders(baselineReport), []);
    assert.deepEqual(nativeAdapterObservations(baselineReport), []);
    assert.deepEqual(baselineReport.observation?.engineExtractions, {});

    const unqueried = await runCliCheck(
      hostDir,
      storeDir,
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
    const hostRequire = createRequire(join(hostDir, "package.json"));

    const queried = await runCliCheck(hostDir, storeDir, nativeConfig);
    assert.equal(queried.status, 1, queried.stderr + queried.stdout);
    const report = parseCliReport(queried.stdout);
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
        detail.kind === "query" && detail.name === "facts:fixture.call-source",
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
        (report.observation?.engineExtractions[providerId]?.extractions ?? 0) >
          0,
        `expected extraction count for ${providerId}`,
      );
    }
    assert.equal(
      report.projects[0]?.sourceFiles.includes(
        "packages/data/src/provider-session-query.ts",
      ),
      true,
    );

    const rootInput = join(hostDir, "fixture.inputs.json");
    const initialInput = readFileSync(rootInput, "utf8");
    const sourcePath = join(
      hostDir,
      "packages/app/provider-session-overlay/app/src/provider-session.ts",
    );
    const initialSource = readFileSync(sourcePath, "utf8");
    const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
    const sdk: typeof import("@verule/sdk") = await import(
      pathToFileURL(sdkPath).href
    );
    const configPath = join(hostDir, nativeConfig);
    const configModule = (await import(pathToFileURL(configPath).href)) as {
      readonly default: NormalizedVeruleConfig;
    };
    const providerSessionRules = (await import(
      pathToFileURL(
        join(
          hostAppDir,
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
            files: [
              "packages/app/provider-session-overlay/app/src/provider-session.ts",
            ],
            kinds: ["CallExpression"],
            textIncludes: ["getProduct(id)"],
          })
        )[0];
        assert.ok(syntax);
        const [resolved] = await ctx.resolveCalls([syntax.ref]);
        assert.ok(resolved?.call);

        const condition = { mode: "targeted-conflict" as const };
        const full = await ctx.facts(providerSessionRules.providerSessionFact, {
          condition,
        });
        const fullProduct = full.find(
          (fact) => fact.value.text === "getProduct(id)",
        );
        assert.ok(fullProduct, JSON.stringify(full));
        const expectedInput = readFileSync(
          join(hostDir, "fixture.inputs.json"),
          "utf8",
        );
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
              conflictError.conflict?.parties.map((party) => party.providerId),
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

        writeFileSync(rootInput, JSON.stringify("target-retry-input"), "utf8");
        const recovered = await ctx.facts(
          providerSessionRules.providerSessionFact,
          query,
        );
        assert.equal(recovered.length, 1);
        const retryInput = readFileSync(rootInput, "utf8");
        assert.notEqual(retryInput, expectedInput);
        assert.equal(recovered[0]?.value.input, retryInput);
        assert.ok(
          recovered[0]!.value.secondaryInvocation! >
            fullProduct.value.secondaryInvocation!,
        );
      },
    });
    const conflictCacheSession = await sdk.openSession({
      cwd: hostDir,
      config: { ...configModule.default, rules: [targetConflictProbe] },
      adapterResolutionRoot: dirname(configPath),
    });
    try {
      await conflictCacheSession.check();
    } finally {
      writeFileSync(rootInput, initialInput, "utf8");
      await conflictCacheSession.close();
    }

    const sharedAbort = new AbortController();
    const shared = await sdk.startSharedSession({
      cwd: hostDir,
      endpoint: join(environmentDir, "provider-session.sock"),
      config: configModule.default,
      adapterResolutionRoot: dirname(configPath),
      observe: "detail",
      signal: sharedAbort.signal,
      debounceMs: 20,
    });
    try {
      const sourceFiles = [...shared.projects[0]!.sourceFiles];
      const initial = await sdk.requestSharedReport({
        endpoint: shared.endpoint,
        cwd: hostDir,
        observe: "detail",
      });
      assertReportsAlign(
        initial,
        await runInstalledSdk(hostDir, nativeConfig),
        "shared-initial",
      );
      assert.deepEqual(initial.projects[0]?.sourceFiles, sourceFiles);

      writeFileSync(rootInput, JSON.stringify("host-edited-input"), "utf8");
      const editedInput = await sdk.requestSharedReport({
        endpoint: shared.endpoint,
        cwd: hostDir,
        observe: "detail",
      });
      const coldEditedInput = await runInstalledSdk(hostDir, nativeConfig);
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

      writeFileSync(
        sourcePath,
        initialSource.replace("getProduct(id)", "getProduct(productId)"),
        "utf8",
      );
      const editedSource = await sdk.requestSharedReport({
        endpoint: shared.endpoint,
        cwd: hostDir,
        observe: "detail",
      });
      assertReportsAlign(
        editedSource,
        await runInstalledSdk(hostDir, nativeConfig),
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

      writeFileSync(sourcePath, initialSource, "utf8");
      writeFileSync(rootInput, initialInput, "utf8");
      const restored = await sdk.requestSharedReport({
        endpoint: shared.endpoint,
        cwd: hostDir,
        observe: "detail",
      });
      assertReportsAlign(
        restored,
        await runInstalledSdk(hostDir, nativeConfig),
        "shared-restored",
      );
      assert.deepEqual(restored.projects[0]?.sourceFiles, sourceFiles);
    } finally {
      sharedAbort.abort();
      await shared.close();
    }

    const watchAbort = new AbortController();
    const watchEvents = sdk.watchProject({
      cwd: hostDir,
      config: configModule.default,
      adapterResolutionRoot: dirname(configPath),
      observe: "detail",
      debounceMs: 20,
      signal: watchAbort.signal,
    });
    try {
      const first = await watchEvents.next();
      assert.equal(first.done, false);
      assert.equal(first.value.kind, "report");
      assertReportsAlign(
        first.value.report,
        await runInstalledSdk(hostDir, nativeConfig),
        "watch-initial",
      );

      writeFileSync(rootInput, JSON.stringify("host-watch-input"), "utf8");
      const changed = await watchEvents.next();
      assert.equal(changed.done, false);
      assert.equal(changed.value.kind, "report");
      assert.equal(changed.value.trigger, "change");
      assertReportsAlign(
        changed.value.report,
        await runInstalledSdk(hostDir, nativeConfig),
        "watch-input-edited",
      );

      writeFileSync(rootInput, initialInput, "utf8");
      const restored = await watchEvents.next();
      assert.equal(restored.done, false);
      assert.equal(restored.value.kind, "report");
      assertReportsAlign(
        restored.value.report,
        await runInstalledSdk(hostDir, nativeConfig),
        "watch-input-restored",
      );
    } finally {
      watchAbort.abort();
      await watchEvents.return();
    }

    let capturedRef: SyntaxRef | undefined;
    const captureRefRule = sdk.defineRule({
      id: "provider-session-capture-ref",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({
          files: [
            "packages/app/provider-session-overlay/app/src/provider-session.ts",
          ],
          kinds: ["CallExpression"],
        });
        capturedRef = calls[0]?.ref;
      },
    });
    const editSession = await sdk.openSession({
      cwd: hostDir,
      config: {
        ...configModule.default,
        rules: [...configModule.default.rules, captureRefRule],
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

      writeFileSync(
        sourcePath,
        initialSource.replace("getProduct(id)", "getProduct(productId)"),
        "utf8",
      );
      const sourceUpdate = await editSession.update({
        changed: [
          "packages/app/provider-session-overlay/app/src/provider-session.ts",
        ],
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
      writeFileSync(sourcePath, initialSource, "utf8");
      await editSession.close();
    }

    const filtered = await runCliCheck(
      hostDir,
      storeDir,
      "packages/app/provider-session-overlay/app/verule.provider-session.filtered.config.ts",
    );
    assert.equal(filtered.status, 1, filtered.stderr + filtered.stdout);
    const filteredReport = parseCliReport(filtered.stdout);
    assert.deepEqual(nativeExtractionProviders(filteredReport), [
      "third-party-fixture-complement",
    ]);

    const replacement = await runCliCheck(
      hostDir,
      storeDir,
      "packages/app/provider-session-overlay/app/verule.provider-session.replacement.config.ts",
    );
    assert.equal(
      replacement.status,
      1,
      replacement.stderr + replacement.stdout,
    );
    const replacementReport = parseCliReport(replacement.stdout);
    assert.match(
      replacementReport.diagnostics[0]?.message ?? "",
      /complement:host-installed-input/u,
    );
    assert.deepEqual(nativeExtractionProviders(replacementReport), [
      "third-party-fixture-complement",
    ]);

    const sdkError = async (
      configName: string,
    ): Promise<VeruleExecutionError> => {
      try {
        await runInstalledSdk(
          hostDir,
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
    assert.ok(forwardError.message.includes("Fixture adapter read this call"));
    assert.ok(
      forwardError.message.includes(
        "Complement fixture adapter read this call",
      ),
    );

    const conflictCli = await runCliCheck(
      hostDir,
      storeDir,
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

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      allowedStorePaths: [storeDir],
    });
    assert.ok(audit.engineBinarySha256);
    assert.ok(
      realpathSync(
        createRequire(join(hostDir, "package.json")).resolve(
          "@verule/adapter-fixture-complement/verule-adapter",
        ),
      ).startsWith(hostDir),
    );
  } finally {
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
