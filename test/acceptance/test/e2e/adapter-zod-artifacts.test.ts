import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
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
import {
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
  type ValidatorInputFieldsFactValue,
  type ValidatorOutputFieldsFactValue,
} from "@verule/adapter-zod";
import type { CallRef, CheckReport, NormalizedVeruleConfig } from "@verule/sdk";

import { copyAcceptanceHost } from "./support/host-fixtures.ts";

const adapterPackageName = "@verule/adapter-zod";

type CliEnvelope = {
  readonly kind: string;
  readonly variant: string;
  readonly data: CheckReport;
};

type ZodFactMessage = {
  readonly input: ValidatorInputFieldsFactValue;
  readonly output: ValidatorOutputFieldsFactValue;
};

void test("installs the native Zod adapter and queries real schemas from a static host", async () => {
  const environmentDir = mkdtempSync(join(tmpdir(), "verule-zod-native-host-"));
  const hostDir = join(environmentDir, "host");
  const storeDir = join(environmentDir, "pnpm-store");
  mkdirSync(storeDir);
  copyAcceptanceHost(hostDir, "zod");

  const env = process.env;
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: [adapterPackageName],
  });
  try {
    const adapterArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === adapterPackageName,
    );
    const engineArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/engine",
    );
    assert.ok(adapterArtifact);
    assert.ok(engineArtifact?.binarySha256);

    const exports = adapterArtifact.manifest.exports as
      | Record<string, unknown>
      | undefined;
    assert.deepEqual(exports?.["."], {
      types: "./dist/index.d.ts",
      default: "./dist/index.js",
    });
    assert.deepEqual(exports?.["./verule-adapter"], {
      types: "./dist/verule-adapter.d.ts",
      default: "./dist/verule-adapter.js",
    });
    assert.equal(exports?.["./verule-native"], "./dist/verule-native.json");
    assert.equal(
      exports?.["./native/linux-x64"],
      "./dist/native/libverule_adapter_zod.so",
    );

    const installation = await installArtifactPackages({
      checkoutDir: hostDir,
      packageManager: "pnpm",
      artifacts: bundle.artifacts,
      directPackages: ["@verule/sdk", "@verule/cli", adapterPackageName],
      storeDir,
      env,
    });
    assert.equal(installation.status, "ready", JSON.stringify(installation));

    const audit = await verifyHostArtifactResolution({
      checkoutDir: hostDir,
      artifacts: bundle.artifacts,
      allowedStorePaths: [storeDir],
    });
    assert.equal(audit.engineBinarySha256, engineArtifact.binarySha256);

    const appRequire = createRequire(
      join(hostDir, "packages/app/package.json"),
    );
    const nativeDescriptorPath = appRequire.resolve(
      `${adapterPackageName}/verule-native`,
    );
    const nativeDescriptor = JSON.parse(
      readFileSync(nativeDescriptorPath, "utf8"),
    ) as { readonly id: string; readonly "linux-x64": string };
    assert.equal(nativeDescriptor.id, "zod");
    assert.equal(nativeDescriptor["linux-x64"], "./native/linux-x64");
    const libraryPath = realpathSync(
      appRequire.resolve(`${adapterPackageName}/native/linux-x64`),
    );
    assert.ok(libraryPath.startsWith(realpathSync(hostDir)));
    assert.ok(libraryPath.startsWith(hostDir));
    assert.ok(libraryPath.endsWith("libverule_adapter_zod.so"));

    const result = await runBareVeruleInHost({
      checkoutDir: hostDir,
      args: [
        "check",
        "--config",
        "packages/app/verule.zod.native.config.ts",
        "--output",
        "json",
      ],
      isolated: true,
      pnpmStoreDir: storeDir,
      env,
    });
    assert.equal(result.status, 1, result.stderr + result.stdout);
    assert.equal(result.isolation?.controlProbeBlocked, true);
    assert.notEqual(result.stdout.trim(), "", result.stderr);

    const envelope = JSON.parse(result.stdout) as CliEnvelope;
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    const zodDiagnostics = envelope.data.diagnostics.filter(
      (diagnostic) => diagnostic.ruleId === "zod-native-facts",
    );
    assert.equal(zodDiagnostics.length, 2, JSON.stringify(zodDiagnostics));

    const parseFacts = zodDiagnostics.map((diagnostic) => ({
      diagnostic,
      facts: JSON.parse(diagnostic.message) as ZodFactMessage,
    }));
    const account = parseFacts.find(
      ({ facts }) => facts.input.schemaName === "accountSchema",
    );
    const user = parseFacts.find(
      ({ facts }) => facts.input.schemaName === "userSchema",
    );
    assert.ok(account, JSON.stringify(parseFacts));
    assert.ok(user, JSON.stringify(parseFacts));

    assert.equal(account.facts.input.validatorMethod, "safeParse");
    assert.deepEqual(account.facts.input.requiredFields, [
      "id",
      "nullableName",
    ]);
    assert.deepEqual(account.facts.input.optionalFields, [
      "fallback",
      "nickname",
      "state",
    ]);
    assert.deepEqual(account.facts.input.defaultedFields, [
      "fallback",
      "state",
    ]);
    assert.equal(account.facts.input.fields.nullableName?.nullable, true);
    assert.equal(account.facts.input.hasDynamicFields, true);
    assert.deepEqual(account.facts.output.presentFields, [
      "fallback",
      "id",
      "nullableName",
      "state",
    ]);
    assert.deepEqual(account.facts.output.optionalFields, ["nickname"]);
    assert.deepEqual(account.facts.output.defaultedFields, [
      "fallback",
      "state",
    ]);

    assert.equal(user.facts.input.validatorMethod, "parse");
    assert.deepEqual(user.facts.input.requiredFields, [
      "id",
      "name",
      "nickname",
    ]);
    assert.deepEqual(user.facts.input.defaultedFields, ["age"]);
    assert.deepEqual(user.facts.output.presentFields, [
      "age",
      "id",
      "name",
      "nickname",
    ]);
    assert.deepEqual(user.facts.output.defaultedFields, ["age"]);
    assert.ok(
      user.diagnostic.evidence.some(
        (item) => item.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );
    assert.ok(
      user.facts.input.fields.id?.evidence?.some(
        (item) => item.at?.file === "packages/data/src/user-table.ts",
      ),
    );
    assert.ok(
      user.facts.input.fields.id?.evidence?.some(
        (item) => item.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );

    assert.ok(
      envelope.data.gaps.some(
        (gap) =>
          gap.kind === "dynamic-schema-spread" &&
          gap.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );
    assert.ok(
      envelope.data.gaps.some(
        (gap) =>
          gap.kind === "dynamic-schema-field" &&
          gap.at?.file === "packages/app/src/zod-fields.ts",
      ),
    );

    const hostRequire = createRequire(join(hostDir, "package.json"));
    const sdkPath = realpathSync(hostRequire.resolve("@verule/sdk"));
    const sdk: typeof import("@verule/sdk") = await import(
      pathToFileURL(sdkPath).href
    );
    const configPath = join(
      hostDir,
      "packages/app/verule.zod.native.config.ts",
    );
    const configModule = (await import(pathToFileURL(configPath).href)) as {
      readonly default: NormalizedVeruleConfig;
    };
    assert.deepEqual(configModule.default.adapterPackages, [
      adapterPackageName,
    ]);
    assert.deepEqual(
      await sdk.runCheck({
        cwd: hostDir,
        adapterResolutionRoot: dirname(configPath),
        config: configModule.default,
      }),
      envelope.data,
    );

    let targetCallHandle: string | undefined;
    let targetCallSyntaxHandle: string | undefined;
    let targetCallRef: CallRef | undefined;
    let targetDeclarationHandle: string | undefined;
    let targetSchemaHandle: string | undefined;
    let firstCallFacts: readonly {
      readonly subject: { readonly handleId: string };
      readonly value: ValidatorInputFieldsFactValue;
    }[] = [];
    let fullCallFacts = firstCallFacts;
    let repeatedCallFacts = firstCallFacts;
    let callAliasFacts: readonly {
      readonly subject: { readonly handleId: string };
    }[] = [];
    let declarationFacts = firstCallFacts;
    let explicitSchemaFacts = firstCallFacts;
    let cachedSchemaFacts = firstCallFacts;
    let allSchemaFacts = firstCallFacts;
    const factProbe = sdk.defineRule({
      id: "zod-native-reference-probe",
      run: async (ctx) => {
        const callSyntax = (
          await ctx.findSyntax({
            files: ["packages/app/src/zod-fields.ts"],
            kinds: ["CallExpression"],
            textIncludes: ["userSchema.parse(row)"],
          })
        )[0];
        assert.ok(callSyntax);
        const [resolvedCall] = await ctx.resolveCalls([callSyntax.ref]);
        assert.ok(resolvedCall?.call);
        targetCallRef = resolvedCall.call;
        targetCallHandle = resolvedCall.call.handleId;
        targetCallSyntaxHandle = callSyntax.ref.handleId;
        fullCallFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        });
        firstCallFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
          targets: [resolvedCall.call],
        });
        repeatedCallFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
          targets: [resolvedCall.call],
        });
        callAliasFacts = await ctx.facts(ValidatorOutputFieldsFact, {
          condition: { scope: "calls" },
          targets: [resolvedCall.call, callSyntax.ref],
        });

        const schemaVariable = (
          await ctx.findSyntax({
            files: ["packages/app/src/zod-fields.ts"],
            kinds: ["VariableDeclaration"],
            textIncludes: ["accountSchema ="],
          })
        )[0];
        assert.ok(schemaVariable);
        const [resolvedDeclaration] = await ctx.resolveDeclarations([
          schemaVariable.ref,
        ]);
        assert.ok(resolvedDeclaration?.declaration);
        targetDeclarationHandle = resolvedDeclaration.declaration.handleId;
        declarationFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "schemas" },
          targets: [resolvedDeclaration.declaration],
        });

        const directSchema = (
          await ctx.findSyntax({
            files: ["packages/app/src/zod-fields.ts"],
            kinds: ["CallExpression"],
            textIncludes: ["standaloneOnly"],
          })
        )[0];
        assert.ok(directSchema);
        targetSchemaHandle = directSchema.ref.handleId;
        explicitSchemaFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "schemas" },
          targets: [directSchema.ref],
        });
        allSchemaFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "schemas" },
        });
        cachedSchemaFacts = await ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "schemas" },
          targets: [directSchema.ref],
        });
      },
    });
    const referenceSession = await sdk.openSession({
      cwd: hostDir,
      adapterResolutionRoot: dirname(configPath),
      config: configModule.default,
    });
    try {
      await referenceSession.check([factProbe]);
      assert.ok(
        fullCallFacts.some((fact) => fact.value.validatorMethod === "parse"),
      );
      assert.ok(targetCallHandle);
      assert.ok(targetCallSyntaxHandle);
      assert.equal(firstCallFacts.length, 1);
      assert.equal(firstCallFacts[0]!.subject.handleId, targetCallHandle);
      assert.deepEqual(firstCallFacts[0]!.value.requiredFields, [
        "id",
        "name",
        "nickname",
      ]);
      assert.deepEqual(repeatedCallFacts, firstCallFacts);
      assert.deepEqual(
        callAliasFacts.map((fact) => fact.subject.handleId).toSorted(),
        [targetCallHandle, targetCallSyntaxHandle].toSorted(),
      );
      assert.equal(declarationFacts.length, 1);
      assert.equal(
        declarationFacts[0]!.subject.handleId,
        targetDeclarationHandle,
      );
      assert.equal(explicitSchemaFacts.length, 1);
      assert.equal(
        explicitSchemaFacts[0]!.subject.handleId,
        targetSchemaHandle,
      );
      assert.deepEqual(explicitSchemaFacts[0]!.value.requiredFields, [
        "standaloneOnly",
      ]);
      assert.equal(
        allSchemaFacts.filter((fact) =>
          fact.value.requiredFields.includes("standaloneOnly"),
        ).length,
        1,
      );
      assert.deepEqual(cachedSchemaFacts, explicitSchemaFacts);

      const staleCallRef = targetCallRef;
      assert.ok(staleCallRef);
      const oldSnapshotId = referenceSession.snapshotId;
      await referenceSession.update({
        changed: ["packages/app/src/zod-fields.ts"],
      });
      assert.notEqual(referenceSession.snapshotId, oldSnapshotId);
      const staleTargetRule = sdk.defineRule({
        id: "zod-native-stale-reference-probe",
        run: async (ctx) => {
          await ctx.facts(ValidatorInputFieldsFact, {
            condition: { scope: "calls" },
            targets: [staleCallRef],
          });
        },
      });
      await assert.rejects(
        referenceSession.check([staleTargetRule]),
        (error: unknown) =>
          typeof error === "object" &&
          error !== null &&
          "code" in error &&
          error.code === "STALE_REFERENCE",
      );
    } finally {
      await referenceSession.close();
    }
  } finally {
    bundle.dispose();
    rmSync(environmentDir, { recursive: true, force: true });
  }
});
