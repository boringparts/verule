import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { INLINE_IGNORE_RULE_ID } from "@verule/sdk";
import { API as Ts7Api } from "typescript-7/unstable/sync";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "../../../..");
const oxfmtBin = join(repoRoot, "node_modules", ".bin", "oxfmt");
const oxlintBin = join(repoRoot, "node_modules", ".bin", "oxlint");

async function captureCli(argv: readonly string[], cwd: string) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    argv: ["node", "verule", ...argv],
    cwd,
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

function writeFiles(root: string, files: Record<string, string>): void {
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, relPath);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  }
}

void test("verule check exits 1 on standalone unused/ambiguous/malformed/unknown directives, supports explain, and keeps partial --rule undetermined", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-inline-ignore-"));
  try {
    writeFiles(root, {
      "tsconfig.json": JSON.stringify(
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
      "src/app.ts": [
        "declare function danger(tag: string): void;",
        "",
        "export function execute(): void {",
        "  // verule-ignore-next-code-line no-danger -- Approved legacy entry.",
        '  danger("ok");',
        "}",
        "",
      ].join("\n"),
      "verule.config.mjs": `export default {
  tsconfig: "tsconfig.json",
  rules: [
    {
      id: "no-danger",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (call.text.startsWith("danger(")) {
            ctx.report({ at: call.location, message: "Avoid danger()" });
          }
        }
      },
    },
    {
      id: "no-other",
      run: () => {},
    },
  ],
};
`,
    });

    // 1. Suppressed cleanly -> exit 0.
    const cleanRes = await captureCli(["check", "--output", "json"], root);
    assert.equal(cleanRes.status, 0, cleanRes.stderr);
    const cleanEnv = JSON.parse(cleanRes.stdout) as {
      variant: string;
      data: { status: string; diagnostics: unknown[] };
    };
    assert.equal(cleanEnv.variant, "clean");
    assert.equal(cleanEnv.data.status, "clean");
    assert.deepEqual(cleanEnv.data.diagnostics, []);

    // 2. Explain suppressed line -> reports suppressed_by_ignore with comment location and reason.
    const explainJson = await captureCli(
      [
        "check",
        "--rule",
        "no-danger",
        "--at",
        "src/app.ts:5:3",
        "--output",
        "json",
      ],
      root,
    );
    assert.equal(explainJson.status, 0, explainJson.stderr);
    const explainEnv = JSON.parse(explainJson.stdout) as {
      data: {
        explanation: {
          status: string;
          inlineIgnore?: {
            matched: boolean;
            ruleId?: string;
            reason?: string;
            commentAt?: { file: string; line: number };
          };
        };
      };
    };
    assert.equal(explainEnv.data.explanation.status, "suppressed_by_ignore");
    assert.equal(explainEnv.data.explanation.inlineIgnore?.matched, true);
    assert.equal(explainEnv.data.explanation.inlineIgnore?.ruleId, "no-danger");
    assert.equal(
      explainEnv.data.explanation.inlineIgnore?.reason,
      "Approved legacy entry.",
    );
    assert.equal(explainEnv.data.explanation.inlineIgnore?.commentAt?.line, 4);

    const explainText = await captureCli(
      ["check", "--rule", "no-danger", "--at", "src/app.ts:5:3"],
      root,
    );
    assert.equal(explainText.status, 0, explainText.stderr);
    assert.match(explainText.stdout, /suppressed_by_ignore/u);
    assert.match(explainText.stdout, /Approved legacy entry\./u);

    // 3. Remove the violation while keeping the ignore directive -> unused alone exits 1 with full report.
    writeFiles(root, {
      "src/app.ts": [
        "export function execute(): number {",
        "  // verule-ignore-next-code-line no-danger -- Approved legacy entry.",
        "  return 1;",
        "}",
        "",
      ].join("\n"),
    });

    const unusedJson = await captureCli(["check", "--output", "json"], root);
    assert.equal(unusedJson.status, 1, unusedJson.stderr);
    const unusedEnv = JSON.parse(unusedJson.stdout) as {
      variant: string;
      data: {
        status: string;
        projects: unknown[];
        diagnostics: {
          ruleId: string;
          at: { line: number };
          message: string;
        }[];
      };
    };
    assert.equal(unusedEnv.variant, "findings");
    assert.equal(unusedEnv.data.projects.length, 1);
    assert.equal(unusedEnv.data.diagnostics.length, 1);
    assert.equal(unusedEnv.data.diagnostics[0]?.ruleId, INLINE_IGNORE_RULE_ID);
    assert.equal(unusedEnv.data.diagnostics[0]?.at.line, 2);

    const unusedText = await captureCli(["check"], root);
    assert.equal(unusedText.status, 1);
    assert.match(unusedText.stdout, /verule\/inline-ignore/u);
    assert.match(unusedText.stdout, /Unused inline ignore directive/u);

    // 4. Partial check (--rule no-other) must leave no-danger directive undetermined and exit 0.
    const partialRes = await captureCli(
      ["check", "--rule", "no-other", "--output", "json"],
      root,
    );
    assert.equal(partialRes.status, 0, partialRes.stderr);
    const partialEnv = JSON.parse(partialRes.stdout) as {
      data: {
        diagnostics: unknown[];
        inlineIgnores?: { status: string; ruleId?: string }[];
      };
    };
    assert.deepEqual(partialEnv.data.diagnostics, []);
    assert.equal(partialEnv.data.inlineIgnores?.[0]?.status, "undetermined");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("coexists with oxlint line directives and preserves JSDoc types and documentation when placed before JSDoc", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-coexist-jsdoc-"));
  try {
    writeFiles(root, {
      "tsconfig.json": JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            allowJs: true,
            checkJs: false,
            noEmit: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.js"],
        },
        null,
        2,
      ),
      "src/control.js": [
        "/**",
        " * Formats a delivery mode.",
        " * @param {'alpha' | 'beta'} mode - Delivery mode.",
        " */",
        "export function formatControl(mode) {",
        "  return mode;",
        "}",
        "",
      ].join("\n"),
      "src/documented.js": [
        "/* verule-ignore-next-code-line no-sync-export --",
        " * Exported synchronously for legacy host callers.",
        " */",
        "/**",
        " * Formats a delivery mode.",
        " * @param {'alpha' | 'beta'} mode - Delivery mode.",
        " */",
        "export function formatDocumented(mode) {",
        "  return mode;",
        "}",
        "",
        "/**",
        " * Broken JSDoc attachment reference.",
        " * @param {string} item - Item label.",
        " */",
        "/* Plain block comment between JSDoc and declaration */",
        "export function formatBrokenAttachment(item) {",
        "  return item;",
        "}",
        "",
        "export function withOxlintDirective() {",
        "  // verule-ignore-next-code-line no-eval-like -- Allowed compatibility shim.",
        "  // oxlint-disable-next-line no-unused-vars",
        "  const shim = 42;",
        "}",
        "",
      ].join("\n"),
      "verule.config.mjs": `export default {
  tsconfig: "tsconfig.json",
  rules: [
    {
      id: "no-sync-export",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        for (const fn of fns) {
          if (fn.text.includes("formatDocumented")) {
            const modeParam = fn.parameters?.[0];
            if (modeParam) {
              const [paramType] = await ctx.typeAt([modeParam]);
              // Assert tsrs resolved the JSDoc @param {'alpha' | 'beta'} union type.
              if (paramType?.typeText !== '"alpha" | "beta"') {
                ctx.report({
                  at: fn.location,
                  message: "Lost JSDoc parameter type: " + (paramType?.typeText ?? "none"),
                });
              }
            }
            ctx.report({ at: fn.location, message: "Sync export disallowed" });
          }
        }
      },
    },
    {
      id: "no-eval-like",
      run: async (ctx) => {
        const decls = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
        for (const decl of decls) {
          if (decl.text.startsWith("shim")) {
            ctx.report({ at: decl.location, message: "shim declaration disallowed" });
          }
        }
      },
    },
  ],
};
`,
    });

    // 1. Verule check passes cleanly: formatDocumented suppressed, JSDoc @param type read as '"alpha" | "beta"',
    //    and withOxlintDirective suppressed across stacked oxlint-disable-next-line.
    const veruleRes = await captureCli(["check", "--output", "json"], root);
    assert.equal(veruleRes.status, 0, veruleRes.stdout + veruleRes.stderr);
    const veruleEnv = JSON.parse(veruleRes.stdout) as {
      data: {
        diagnostics: unknown[];
        inlineIgnores?: { status: string; ruleId?: string }[];
      };
    };
    assert.deepEqual(veruleEnv.data.diagnostics, []);
    assert.deepEqual(
      veruleEnv.data.inlineIgnores?.map((item) => ({
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
      ["-D", "no-unused-vars", join(root, "src", "documented.js")],
      { encoding: "utf8" },
    );

    // 3. Compiler JSDoc extraction + immediate-preceding-comment attachment comparison:
    //    Verule directive BEFORE JSDoc keeps both tsrs docs/tags AND direct JSDoc attachment identical to control,
    //    whereas a plain block comment BETWEEN JSDoc and function breaks direct JSDoc attachment.
    const ts7Api = new Ts7Api({ cwd: root });
    try {
      const snap = ts7Api.updateSnapshot({
        openProject: join(root, "tsconfig.json"),
      });
      const project = snap.getProject(join(root, "tsconfig.json"));
      assert.ok(project);
      const checker = project.checker;

      const controlSf = project.program.getSourceFile(
        join(root, "src", "control.js"),
      );
      const docSf = project.program.getSourceFile(
        join(root, "src", "documented.js"),
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
      const docText = readFileSync(join(root, "src", "documented.js"), "utf8");
      const immediatelyPrecedingComment = (fnHeader: string) => {
        const beforeFn = docText.slice(0, docText.indexOf(fnHeader)).trimEnd();
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
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("oxfmt 80-column formatting triggers ambiguity when merging calls onto one line and restores single match when placed inside array", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-oxfmt-"));
  try {
    const targetFile = join(root, "src", "register.ts");
    const oxfmtConfig = join(root, ".oxfmtrc.json");
    writeFiles(root, {
      ".oxfmtrc.json": JSON.stringify({ printWidth: 80 }, null, 2),
      "tsconfig.json": JSON.stringify(
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
      "src/register.ts": [
        "declare function register(name: string): string;",
        "",
        "// verule-ignore-next-code-line no-legacy-register -- Old host id.",
        'export const list = [register("old"),',
        'register("new")];',
        "",
      ].join("\n"),
      "verule.config.mjs": `export default {
  tsconfig: "tsconfig.json",
  rules: [
    {
      id: "no-legacy-register",
      run: async (ctx) => {
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        for (const call of calls) {
          if (!call.text.startsWith("register(")) continue;
          const arg = call.arguments?.[0];
          if (!arg) continue;
          const [argSyntax] = await ctx.syntaxOf([call.ref], { select: { arguments: true } });
          void argSyntax;
          const strings = await ctx.findSyntax({
            kinds: ["StringLiteral"],
            range: {
              file: call.location.file,
              start: call.location.start,
              end: call.location.end,
              match: "within",
            },
          });
          for (const s of strings) {
            ctx.report({
              at: s.location,
              message: "Disallowed register key " + s.text,
              findingKey: "reg:" + s.text,
            });
          }
        }
      },
    },
  ],
};
`,
    });

    // 1. Before oxfmt: directive targets line 4 (`register("old")`), so only `register("new")` on line 5 is reported.
    const beforeFmt = await captureCli(["check", "--output", "json"], root);
    assert.equal(beforeFmt.status, 1, beforeFmt.stderr);
    const beforeEnv = JSON.parse(beforeFmt.stdout) as {
      data: {
        diagnostics: {
          ruleId: string;
          at: { line: number };
          message: string;
        }[];
      };
    };
    assert.equal(beforeEnv.data.diagnostics.length, 1);
    assert.equal(beforeEnv.data.diagnostics[0]?.ruleId, "no-legacy-register");
    assert.equal(beforeEnv.data.diagnostics[0]?.at.line, 5);

    // 2. Run oxfmt with 80-column printWidth: merges both calls onto line 4.
    execFileSync(oxfmtBin, ["-c", oxfmtConfig, "--write", targetFile], {
      encoding: "utf8",
    });
    const formattedSingleLine = readFileSync(targetFile, "utf8");
    assert.match(
      formattedSingleLine,
      /export const list = \[register\("old"\), register\("new"\)\];/u,
    );

    const afterMerge = await captureCli(["check", "--output", "json"], root);
    assert.equal(afterMerge.status, 1, afterMerge.stderr);
    const afterMergeEnv = JSON.parse(afterMerge.stdout) as {
      data: {
        diagnostics: {
          ruleId: string;
          at: { line: number };
          message: string;
          evidence: { at?: { line: number; start: number } }[];
        }[];
      };
    };
    const ambiguous = afterMergeEnv.data.diagnostics.find(
      (d) => d.ruleId === INLINE_IGNORE_RULE_ID,
    );
    const originals = afterMergeEnv.data.diagnostics.filter(
      (d) => d.ruleId === "no-legacy-register",
    );
    assert.ok(ambiguous, "merged calls must trigger ambiguity diagnostic");
    assert.match(ambiguous.message, /Ambiguous inline ignore directive/u);
    assert.equal(ambiguous.evidence.length, 2);
    assert.equal(originals.length, 2, "both original violations must remain");

    // 3. Place directive inside the array directly above `register("old")` and re-format with oxfmt.
    writeFiles(root, {
      "src/register.ts": [
        "declare function register(name: string): string;",
        "",
        "export const list = [",
        "  // verule-ignore-next-code-line no-legacy-register -- Old host id.",
        '  register("old"),',
        '  register("new"),',
        "];",
        "",
      ].join("\n"),
    });
    execFileSync(oxfmtBin, ["-c", oxfmtConfig, "--write", targetFile], {
      encoding: "utf8",
    });

    const afterLocalFix = await captureCli(["check", "--output", "json"], root);
    assert.equal(afterLocalFix.status, 1, afterLocalFix.stderr);
    const afterLocalEnv = JSON.parse(afterLocalFix.stdout) as {
      data: {
        diagnostics: {
          ruleId: string;
          at: { line: number };
          message: string;
        }[];
        inlineIgnores?: { status: string; ruleId?: string }[];
      };
    };
    assert.equal(
      afterLocalEnv.data.diagnostics.some(
        (d) => d.ruleId === INLINE_IGNORE_RULE_ID,
      ),
      false,
    );
    assert.equal(afterLocalEnv.data.diagnostics.length, 1);
    assert.match(afterLocalEnv.data.diagnostics[0]!.message, /"new"/u);
    assert.equal(afterLocalEnv.data.inlineIgnores?.[0]?.status, "suppressed");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
