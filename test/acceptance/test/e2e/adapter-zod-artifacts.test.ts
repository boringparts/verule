import assert from "node:assert/strict";
import { dirname } from "node:path";
import { test } from "node:test";

import type { CallRef } from "@boringparts/verule";
import { withAcceptanceHost } from "@verule/acceptance";
import {
  ValidatorInputFieldsFact,
  ValidatorOutputFieldsFact,
  type ValidatorInputFieldsFactValue,
  type ValidatorOutputFieldsFactValue,
} from "@verule/adapter-zod";

const adapterPackageName = "@verule/adapter-zod";
const configPath = "packages/app/verule.zod.native.config.ts";

type ZodFactMessage = {
  readonly input: ValidatorInputFieldsFactValue;
  readonly output: ValidatorOutputFieldsFactValue;
};

void test("installs the native Zod adapter and queries real schemas from a static host", async () => {
  await withAcceptanceHost(
    {
      overlay: "zod",
      additionalPackages: [adapterPackageName],
      verifyNativeAdapters: [adapterPackageName],
    },
    async (host) => {
      const adapterArtifact = host.artifact(adapterPackageName);
      const engineArtifact = host.artifact("@verule/engine");
      assert.ok(engineArtifact.binarySha256);
      assert.equal(host.audit.engineBinarySha256, engineArtifact.binarySha256);

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

      const nativeLibrary = host.nativeLibraries[adapterPackageName];
      assert.ok(nativeLibrary);
      assert.equal(nativeLibrary.providerId, "zod");
      assert.ok(nativeLibrary.path.endsWith("libverule_adapter_zod.so"));

      const result = await host.check({ config: configPath });
      assert.equal(result.status, 1, result.stderr + result.stdout);
      assert.equal(result.isolation?.controlProbeBlocked, true);
      assert.equal(result.variant, "findings");

      const zodDiagnostics = result.report.diagnostics.filter(
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
      // Single-Zod retains explicit .extend({ age: z.number().default(18) }) conclusions
      // while surfacing unresolved-schema for base createSelectSchema(userTable) fields.
      assert.deepEqual(user.facts.input.requiredFields, []);
      assert.deepEqual(user.facts.input.optionalFields, ["age"]);
      assert.deepEqual(user.facts.input.defaultedFields, ["age"]);
      assert.equal(user.facts.input.hasDynamicFields, true);
      assert.deepEqual(user.facts.output.presentFields, ["age"]);
      assert.deepEqual(user.facts.output.defaultedFields, ["age"]);
      assert.ok(
        user.diagnostic.evidence.some(
          (item) => item.at?.file === "packages/app/src/zod-fields.ts",
        ),
      );
      assert.equal(
        user.diagnostic.evidence.some(
          (item) => item.at?.file === "packages/data/src/user-table.ts",
        ),
        false,
      );
      assert.ok(
        result.report.gaps.some(
          (gap) =>
            gap.kind === "unresolved-schema" &&
            gap.at?.file === "packages/app/src/zod-fields.ts" &&
            gap.at.line === 21,
        ),
        JSON.stringify(result.report.gaps),
      );

      assert.ok(
        result.report.gaps.some(
          (gap) =>
            gap.kind === "dynamic-schema-spread" &&
            gap.at?.file === "packages/app/src/zod-fields.ts",
        ),
      );
      assert.ok(
        result.report.gaps.some(
          (gap) =>
            gap.kind === "dynamic-schema-field" &&
            gap.at?.file === "packages/app/src/zod-fields.ts",
        ),
      );

      const sdk = await host.loadSdk();
      const resolvedConfigPath = host.resolvePath(configPath);
      const config = await host.loadConfig(configPath);
      assert.deepEqual(config.adapterPackages, [adapterPackageName]);
      assert.deepEqual(
        await sdk.runCheck({
          cwd: host.hostDir,
          adapterResolutionRoot: dirname(resolvedConfigPath),
          config,
        }),
        result.report,
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
        cwd: host.hostDir,
        adapterResolutionRoot: dirname(resolvedConfigPath),
        config,
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
        assert.deepEqual(firstCallFacts[0]!.value.requiredFields, []);
        assert.deepEqual(firstCallFacts[0]!.value.defaultedFields, ["age"]);
        assert.equal(firstCallFacts[0]!.value.hasDynamicFields, true);
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
    },
  );
});
