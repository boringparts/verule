import assert from "node:assert/strict";
import { test } from "node:test";

import { checkReportSchema } from "../../src/report-wire.ts";
import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { captureCli } from "./cli-test-helpers.ts";

void test("verule check supports provider replacement without rule changes and explicit providerId filtering", async () => {
  await withCliTempHost(
    { host: "integration/fact-providers-replacement" },
    async (host) => {
      await host.typecheck();

      const alphaRes = await captureCli(
        ["check", "--config", "verule.alpha.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(alphaRes.status, 1, alphaRes.stderr);
      const alphaEnv = JSON.parse(alphaRes.stdout) as {
        data: {
          diagnostics: {
            message: string;
            at: { line: number };
            evidence: { message: string }[];
          }[];
        };
      };
      assert.equal(alphaEnv.data.diagnostics.length, 1);
      assert.match(
        alphaEnv.data.diagnostics[0]!.message,
        /alphaSchema.*alpha-validator/u,
      );
      assert.equal(alphaEnv.data.diagnostics[0]!.at.line, 4);

      // Swap provider to betaProvider while shared-rule.ts is untouched
      const betaRes = await captureCli(
        ["check", "--config", "verule.beta.config.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(betaRes.status, 1, betaRes.stderr);
      const betaEnv = JSON.parse(betaRes.stdout) as {
        data: {
          diagnostics: {
            message: string;
            at: { line: number };
            evidence: { message: string }[];
          }[];
        };
      };
      assert.equal(betaEnv.data.diagnostics.length, 1);
      assert.match(
        betaEnv.data.diagnostics[0]!.message,
        /betaSchema.*beta-validator/u,
      );
      assert.equal(betaEnv.data.diagnostics[0]!.at.line, 7);

      // Explicit providerId filtering reflected in observation & explanation
      const scopedRes = await captureCli(
        [
          "check",
          "--config",
          "verule.scoped.config.ts",
          "--observe",
          "detail",
          "--at",
          "src/app.ts:7:10",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(scopedRes.status, 1, scopedRes.stderr);
      const scopedEnv = JSON.parse(scopedRes.stdout) as {
        data: {
          diagnostics: { message: string }[];
          observation: { providers: string[] };
          explanation: {
            providers: string[];
            queries: { op: string; provider: string; candidateCount: number }[];
          };
        };
      };
      assert.equal(scopedEnv.data.diagnostics.length, 1);
      assert.equal(
        scopedEnv.data.diagnostics[0]!.message,
        "Scoped to [beta-validator]",
      );
      assert.equal(
        scopedEnv.data.observation.providers.includes("beta-validator"),
        true,
      );
      assert.equal(
        scopedEnv.data.observation.providers.includes("alpha-validator"),
        false,
      );
      assert.deepEqual(scopedEnv.data.explanation.providers, [
        "beta-validator",
      ]);
      assert.equal(
        scopedEnv.data.explanation.queries.find((q) =>
          q.op.startsWith("facts:"),
        )?.candidateCount,
        1,
      );
    },
  );
});

void test("verule check merges complementary partial facts identically and exits 2 with structured FACT_CONFLICT regardless of adapter order", async () => {
  await withCliTempHost(
    { host: "integration/fact-providers-merge" },
    async (host) => {
      await host.typecheck();

      // 1. Partial merge AB vs BA -> identical exit code, diagnostics, gaps, identity
      const mergeAB = await captureCli(
        ["check", "--config", "verule.merge.ab.ts", "--output", "json"],
        host.rootDir,
      );
      const mergeBA = await captureCli(
        ["check", "--config", "verule.merge.ba.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(
        mergeAB.status,
        1,
        `stdout=${mergeAB.stdout}\nstderr=${mergeAB.stderr}`,
      );
      assert.equal(
        mergeBA.status,
        1,
        `stdout=${mergeBA.stdout}\nstderr=${mergeBA.stderr}`,
      );
      assert.equal(mergeAB.stdout, mergeBA.stdout);

      const mergeEnv = JSON.parse(mergeAB.stdout) as {
        data: {
          diagnostics: { message: string; evidence: { message: string }[] }[];
          gaps: { kind: string }[];
        };
      };
      assert.equal(
        mergeEnv.data.diagnostics.length,
        1,
        JSON.stringify(mergeEnv.data.diagnostics),
      );
      assert.match(
        mergeEnv.data.diagnostics[0]!.message,
        /\[provider-a, provider-b\]/u,
      );
      assert.equal(mergeEnv.data.diagnostics[0]!.evidence.length, 2);
      assert.equal(mergeEnv.data.gaps.length, 1);

      // 2. Mutual exclusion conflict AC vs CA -> exit code 2 + identical structured JSON & text
      const conflictJsonAC = await captureCli(
        ["check", "--config", "verule.conflict.ac.ts", "--output", "json"],
        host.rootDir,
      );
      const conflictJsonCA = await captureCli(
        ["check", "--config", "verule.conflict.ca.ts", "--output", "json"],
        host.rootDir,
      );
      assert.equal(conflictJsonAC.status, 2);
      assert.equal(conflictJsonCA.status, 2);
      assert.equal(conflictJsonAC.stdout, "");
      assert.equal(conflictJsonCA.stdout, "");
      assert.equal(conflictJsonAC.stderr, conflictJsonCA.stderr);

      const errEnv = JSON.parse(conflictJsonAC.stderr) as {
        kind: string;
        variant: string;
        data: {
          reportVersion: string;
          code: string;
          message: string;
          conflict?: {
            factTypeId: string;
            parties: {
              providerId: string;
              conclusionSummary: string;
              evidence: { message: string }[];
            }[];
          };
        };
      };
      assert.equal(errEnv.kind, "failure");
      assert.equal(errEnv.variant, "failed");
      assert.equal(errEnv.data.code, "FACT_CONFLICT");
      assert.ok(errEnv.data.conflict);
      assert.equal(
        errEnv.data.conflict.factTypeId,
        "thirdparty.validator.contract",
      );
      assert.deepEqual(
        errEnv.data.conflict.parties.map((p) => p.providerId),
        ["provider-a", "provider-c"],
      );
      assert.deepEqual(
        errEnv.data.conflict.parties.map((p) => p.conclusionSummary),
        ["id=required", "id=optional"],
      );
      assert.equal(
        errEnv.data.conflict.parties[0]!.evidence[0]!.message,
        "provider-a id=required",
      );
      assert.equal(
        errEnv.data.conflict.parties[1]!.evidence[0]!.message,
        "provider-c id=optional",
      );

      const conflictTextAC = await captureCli(
        ["check", "--config", "verule.conflict.ac.ts"],
        host.rootDir,
      );
      const conflictTextCA = await captureCli(
        ["check", "--config", "verule.conflict.ca.ts"],
        host.rootDir,
      );
      assert.equal(conflictTextAC.status, 2);
      assert.equal(conflictTextCA.status, 2);
      assert.equal(conflictTextAC.stderr, conflictTextCA.stderr);
      assert.match(conflictTextAC.stderr, /Check failed \[FACT_CONFLICT\]/u);
      assert.match(conflictTextAC.stderr, /provider-a/u);
      assert.match(conflictTextAC.stderr, /provider-c/u);
      assert.match(conflictTextAC.stderr, /provider-a id=required/u);
      assert.match(conflictTextAC.stderr, /provider-c id=optional/u);
    },
  );
});

void test("verule check --at surfaces blocked_by_gap, localGaps (unresolved and resolved_by_override), and skipped providers in JSON and text output", async () => {
  await withCliTempHost(
    { host: "integration/fact-providers-local-gaps" },
    async (host) => {
      await host.typecheck();

      const blockedJson = await captureCli(
        [
          "check",
          "--config",
          "verule.local-gaps.config.ts",
          "--at",
          "src/consumer.ts:6:28",
          "--output",
          "json",
        ],
        host.rootDir,
      );
      assert.equal(blockedJson.status, 1, blockedJson.stderr);
      const blockedParsed = checkReportSchema.parse(
        (JSON.parse(blockedJson.stdout) as { readonly data: unknown }).data,
      );
      assert.equal(blockedParsed.gaps.length, 1);
      assert.equal(blockedParsed.explanation?.status, "blocked_by_gap");
      assert.equal(blockedParsed.explanation?.gaps.length, 1);
      assert.equal(
        blockedParsed.explanation?.localGaps[0]?.status,
        "unresolved",
      );
      assert.equal(
        blockedParsed.explanation?.localGaps[0]?.field,
        "couponCode",
      );
      assert.ok(
        blockedParsed.explanation?.providerEvaluations.some(
          (ev) =>
            ev.providerId === "cli-adapter-unused" && ev.status === "skipped",
        ),
      );

      const overriddenText = await captureCli(
        [
          "check",
          "--config",
          "verule.local-gaps.config.ts",
          "--at",
          "src/consumer.ts:7:35",
        ],
        host.rootDir,
      );
      assert.equal(overriddenText.status, 1, overriddenText.stderr);
      assert.match(
        overriddenText.stdout,
        /localGap \[resolved_by_override\] cli\.explain\.source \(cli-adapter-a\) field=couponCode/u,
      );
      assert.match(
        overriddenText.stdout,
        /resolved_by cli-adapter-b \(override: couponCode=defaulted/u,
      );
      assert.match(
        overriddenText.stdout,
        /provider \[skipped\] cli-adapter-unused/u,
      );
    },
  );
});
