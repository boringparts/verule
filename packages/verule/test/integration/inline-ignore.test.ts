import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { runCliScenario } from "@boringparts/cli-contract/testing";
import { INLINE_IGNORE_RULE_ID } from "@boringparts/verule";
import { API as Ts7Api } from "typescript-7/unstable/sync";

import { withCliTempHost } from "../helpers/cli-hosts.ts";
import { testCliContract } from "./cli-test-helpers.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const oxfmtBin = join(repoRoot, "node_modules", ".bin", "oxfmt");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

void test("verule check exits 1 on standalone unused/ambiguous/malformed/unknown directives, supports explain, and keeps partial --rule undetermined", async () => {
  await withCliTempHost(
    { host: "integration/inline-ignore-directives" },
    async (host) => {
      await host.typecheck();

      // 1. Suppressed cleanly -> exit 0.
      const cleanRes = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(cleanRes.termination.kind === "applicationResult");
      assert.equal(cleanRes.termination.exitCode, 0, cleanRes.stderr);
      assert.ok(cleanRes.termination.result.kind === "data");
      assert.ok(cleanRes.termination.result.command === "check");
      assert.equal(cleanRes.termination.result.variant, "clean");
      assert.equal(cleanRes.termination.result.data.status, "clean");
      assert.deepEqual(cleanRes.termination.result.data.diagnostics, []);

      // 2. Explain suppressed line -> reports suppressed_by_ignore with comment location and reason.
      const explainJson = await runCliScenario(testCliContract, {
        argv: [
          "check",
          "--rule",
          "no-danger",
          "--at",
          "src/app.ts:5:3",
          "--output",
          "json",
        ],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(explainJson.termination.kind === "applicationResult");
      assert.equal(explainJson.termination.exitCode, 0, explainJson.stderr);
      assert.ok(explainJson.termination.result.kind === "data");
      assert.ok(explainJson.termination.result.command === "check");
      const explain = explainJson.termination.result.data.explanation;
      assert.ok(explain);
      assert.equal(explain.status, "suppressed_by_ignore");
      assert.equal(explain.inlineIgnore?.matched, true);
      assert.equal(explain.inlineIgnore?.ruleId, "no-danger");
      assert.equal(explain.inlineIgnore?.reason, "Approved legacy entry.");
      assert.equal(explain.inlineIgnore?.commentAt?.line, 4);

      const explainText = await runCliScenario(testCliContract, {
        argv: ["check", "--rule", "no-danger", "--at", "src/app.ts:5:3"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(explainText.termination.exitCode, 0, explainText.stderr);
      assert.match(explainText.stdout, /suppressed_by_ignore/u);
      assert.match(explainText.stdout, /Approved legacy entry\./u);

      // 3. Remove the violation while keeping the ignore directive -> unused alone exits 1 with full report.
      host.writeText(
        "src/app.ts",
        [
          "export function execute(): number {",
          "  // verule-ignore-next-code-line no-danger -- Approved legacy entry.",
          "  return 1;",
          "}",
          "",
        ].join("\n"),
      );

      const unusedJson = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(unusedJson.termination.kind === "applicationResult");
      assert.equal(unusedJson.termination.exitCode, 1, unusedJson.stderr);
      assert.ok(unusedJson.termination.result.kind === "data");
      assert.ok(unusedJson.termination.result.command === "check");
      assert.equal(unusedJson.termination.result.variant, "findings");
      const unusedData = unusedJson.termination.result.data;
      assert.equal(unusedData.projects.length, 1);
      assert.equal(unusedData.diagnostics.length, 1);
      assert.equal(unusedData.diagnostics[0]?.ruleId, INLINE_IGNORE_RULE_ID);
      assert.equal(unusedData.diagnostics[0]?.at.line, 2);

      const unusedText = await runCliScenario(testCliContract, {
        argv: ["check"],
        dependencies: { cwd: host.rootDir },
      });
      assert.equal(unusedText.termination.exitCode, 1);
      assert.match(unusedText.stdout, /verule\/inline-ignore/u);
      assert.match(unusedText.stdout, /Unused inline ignore directive/u);

      // 4. Partial check (--rule no-other) must leave no-danger directive undetermined and exit 0.
      const partialRes = await runCliScenario(testCliContract, {
        argv: ["check", "--rule", "no-other", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(partialRes.termination.kind === "applicationResult");
      assert.equal(partialRes.termination.exitCode, 0, partialRes.stderr);
      assert.ok(partialRes.termination.result.kind === "data");
      assert.ok(partialRes.termination.result.command === "check");
      assert.deepEqual(partialRes.termination.result.data.diagnostics, []);
      assert.equal(
        partialRes.termination.result.data.inlineIgnores?.[0]?.status,
        "undetermined",
      );
    },
  );
});

void test("coexists with oxlint line directives and preserves JSDoc types and documentation when placed before JSDoc", async () => {
  await withCliTempHost(
    { host: "integration/inline-ignore-jsdoc" },
    async (host) => {
      await host.typecheck();

      // 1. Verule check passes cleanly: formatDocumented suppressed, JSDoc @param type read as '"alpha" | "beta"',
      //    and withOxlintDirective suppressed across stacked oxlint-disable-next-line.
      const veruleRes = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(veruleRes.termination.kind === "applicationResult");
      assert.equal(
        veruleRes.termination.exitCode,
        0,
        veruleRes.stdout + veruleRes.stderr,
      );
      assert.ok(veruleRes.termination.result.kind === "data");
      assert.ok(veruleRes.termination.result.command === "check");
      assert.deepEqual(veruleRes.termination.result.data.diagnostics, []);
      assert.deepEqual(
        veruleRes.termination.result.data.inlineIgnores?.map((item) => ({
          status: item.status,
          ruleId: item.ruleId,
        })),
        [
          { status: "suppressed", ruleId: "no-sync-export" },
          { status: "suppressed", ruleId: "no-eval-like" },
        ],
      );

      // 2. Workspace oxlint also honors oxlint-disable-next-line when Verule directive sits above it.
      execFileSync(
        oxlintBin,
        ["-D", "no-unused-vars", host.resolvePath("src/documented.js")],
        { encoding: "utf8" },
      );

      // 3. Compiler JSDoc extraction + immediate-preceding-comment attachment comparison:
      //    Verule directive BEFORE JSDoc keeps both tsrs docs/tags AND direct JSDoc attachment identical to control,
      //    whereas a plain block comment BETWEEN JSDoc and function breaks direct JSDoc attachment.
      const ts7Api = new Ts7Api({ cwd: host.rootDir });
      try {
        const snap = ts7Api.updateSnapshot({
          openProject: host.resolvePath("tsconfig.json"),
        });
        const project = snap.getProject(host.resolvePath("tsconfig.json"));
        assert.ok(project);
        const checker = project.checker;

        const controlSf = project.program.getSourceFile(
          host.resolvePath("src/control.js"),
        );
        const docSf = project.program.getSourceFile(
          host.resolvePath("src/documented.js"),
        );
        assert.ok(controlSf && docSf);

        const getExportDoc = (sf: typeof controlSf, name: string) => {
          const modSym = checker.getSymbolAtLocation(sf);
          assert.ok(modSym);
          const sym = checker
            .getExportsOfModule(modSym)
            .find((s) => s.name === name);
          assert.ok(sym, `Expected export ${name}`);
          return {
            doc: checker.getDocumentationCommentOfSymbol(sym),
            tags: checker.getJsDocTagsOfSymbol(sym),
          };
        };

        const controlDoc = getExportDoc(controlSf, "formatControl");
        const documentedDoc = getExportDoc(docSf, "formatDocumented");
        assert.deepEqual(documentedDoc, controlDoc);
        assert.equal(documentedDoc.doc, "Formats a delivery mode.");
        assert.deepEqual(documentedDoc.tags, [
          { name: "param", text: "mode - Delivery mode." },
        ]);

        // Verify JSDoc 4.0.5 immediate-preceding-comment attachment invariant:
        // The comment immediately before `export function formatDocumented` starts with `/**`,
        // whereas the comment immediately before `export function formatBrokenAttachment` is a plain `/*` block.
        const docText = host.readText("src/documented.js");
        const immediatelyPrecedingComment = (fnHeader: string) => {
          const beforeFn = docText
            .slice(0, docText.indexOf(fnHeader))
            .trimEnd();
          const commentStart = beforeFn.lastIndexOf("/*");
          return beforeFn.slice(commentStart);
        };
        assert.ok(
          immediatelyPrecedingComment(
            "export function formatDocumented",
          ).startsWith("/**"),
        );
        assert.equal(
          immediatelyPrecedingComment(
            "export function formatBrokenAttachment",
          ).startsWith("/**"),
          false,
        );
      } finally {
        ts7Api.close();
      }
    },
  );
});

void test("oxfmt 80-column formatting triggers ambiguity when merging calls onto one line and restores single match when placed inside array", async () => {
  await withCliTempHost(
    { host: "integration/inline-ignore-oxfmt" },
    async (host) => {
      await host.typecheck();

      const targetFile = host.resolvePath("src/register.ts");
      const oxfmtConfig = host.resolvePath(".oxfmtrc.json");

      // Write an unformatted two-line array so oxfmt collapses both calls onto line 4.
      host.writeText(
        "src/register.ts",
        [
          "declare function register(name: string): string;",
          "",
          "// verule-ignore-next-code-line no-legacy-register -- Old host id.",
          'export const list = [register("old"),',
          'register("new")];',
          "",
        ].join("\n"),
      );

      // 1. Before oxfmt: directive targets line 4 (`register("old")`), so only `register("new")` on line 5 is reported.
      const beforeFmt = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(beforeFmt.termination.kind === "applicationResult");
      assert.equal(beforeFmt.termination.exitCode, 1, beforeFmt.stderr);
      assert.ok(beforeFmt.termination.result.kind === "data");
      assert.ok(beforeFmt.termination.result.command === "check");
      assert.equal(beforeFmt.termination.result.data.diagnostics.length, 1);
      assert.equal(
        beforeFmt.termination.result.data.diagnostics[0]?.ruleId,
        "no-legacy-register",
      );
      assert.equal(
        beforeFmt.termination.result.data.diagnostics[0]?.at.line,
        5,
      );

      // 2. Run oxfmt with 80-column printWidth: merges both calls onto line 4.
      execFileSync(oxfmtBin, ["-c", oxfmtConfig, "--write", targetFile], {
        encoding: "utf8",
      });
      const formattedSingleLine = host.readText("src/register.ts");
      assert.match(
        formattedSingleLine,
        /export const list = \[register\("old"\), register\("new"\)\];/u,
      );

      const afterMerge = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(afterMerge.termination.kind === "applicationResult");
      assert.equal(afterMerge.termination.exitCode, 1, afterMerge.stderr);
      assert.ok(afterMerge.termination.result.kind === "data");
      assert.ok(afterMerge.termination.result.command === "check");
      const afterMergeDiags = afterMerge.termination.result.data.diagnostics;
      const ambiguous = afterMergeDiags.find(
        (d) => d.ruleId === INLINE_IGNORE_RULE_ID,
      );
      const originals = afterMergeDiags.filter(
        (d) => d.ruleId === "no-legacy-register",
      );
      assert.ok(ambiguous, "merged calls must trigger ambiguity diagnostic");
      assert.match(ambiguous.message, /Ambiguous inline ignore directive/u);
      assert.equal(ambiguous.evidence.length, 2);
      assert.equal(originals.length, 2, "both original violations must remain");

      // 3. Place directive inside the array directly above `register("old")` and re-format with oxfmt.
      host.writeText(
        "src/register.ts",
        [
          "declare function register(name: string): string;",
          "",
          "export const list = [",
          "  // verule-ignore-next-code-line no-legacy-register -- Old host id.",
          '  register("old"),',
          '  register("new"),',
          "];",
          "",
        ].join("\n"),
      );
      execFileSync(oxfmtBin, ["-c", oxfmtConfig, "--write", targetFile], {
        encoding: "utf8",
      });

      const afterLocalFix = await runCliScenario(testCliContract, {
        argv: ["check", "--output", "json"],
        dependencies: { cwd: host.rootDir },
      });
      assert.ok(afterLocalFix.termination.kind === "applicationResult");
      assert.equal(afterLocalFix.termination.exitCode, 1, afterLocalFix.stderr);
      assert.ok(afterLocalFix.termination.result.kind === "data");
      assert.ok(afterLocalFix.termination.result.command === "check");
      const afterLocalData = afterLocalFix.termination.result.data;
      assert.equal(
        afterLocalData.diagnostics.some(
          (d) => d.ruleId === INLINE_IGNORE_RULE_ID,
        ),
        false,
      );
      assert.equal(afterLocalData.diagnostics.length, 1);
      assert.match(afterLocalData.diagnostics[0]!.message, /"new"/u);
      assert.equal(afterLocalData.inlineIgnores?.[0]?.status, "suppressed");
    },
  );
});
