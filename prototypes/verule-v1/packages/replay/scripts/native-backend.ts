import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { installedBin, oxlint, runOxlint } from "./oxlint.ts";

const rule = "typescript/no-floating-promises";
const file = "test/error-boundaries.test.ts";

/** Measure the released type-aware engines on one built-in rule. The project
 * rules use a separate JS-plugin measurement because they cannot borrow this checker. */
export function measureNativeBackends(cwd: string) {
  const backends = {
    tsgolint: installedBin("oxlint-tsgolint", "tsgolint"),
    tsrs: installedBin("tsrs", "tsrs-lint"),
  };
  const target = join(cwd, file);
  const original = readFileSync(target, "utf8");
  const probe = (result: string) =>
    `${original}\ndeclare function replayNativeOperation(): ${result};\nreplayNativeOperation();\n`;
  const directory = mkdtempSync(join(tmpdir(), "verule-native-config-"));
  const config = join(directory, "oxlint.json");
  function run(engine: keyof typeof backends) {
    // Oxlint checks the explicit executable before searching node_modules or PATH.
    const { ms, report } = runOxlint(
      cwd,
      config,
      ["--type-aware", "--tsconfig", "tsconfig.json"],
      { OXLINT_TSGOLINT_PATH: backends[engine].path },
    );
    assert.equal(report.number_of_rules, 1);
    assert.ok(report.number_of_files > 0);
    const diagnostics = report.diagnostics
      .map(({ code, filename, labels }) => {
        assert.equal(code, "typescript(no-floating-promises)");
        assert.ok(labels[0]);
        return { code, file: filename, ...labels[0].span };
      })
      .sort((a, b) => a.file.localeCompare(b.file) || a.offset - b.offset);
    return { ms, files: report.number_of_files, diagnostics };
  }

  try {
    writeFileSync(
      config,
      JSON.stringify({
        plugins: ["typescript"],
        categories: { correctness: "off" },
        rules: { [rule]: "warn" },
      }),
    );
    // Changing only the declared return type leaves the call's syntax constant.
    const cases = [
      { label: "original", source: original },
      { label: "void-return", source: probe("void") },
      { label: "promise-return", source: probe("Promise<void>") },
      { label: "restored", source: original },
    ];
    const rounds = cases.map(({ label, source }, index) => {
      if (index) writeFileSync(target, source);
      // Alternate the first engine to distribute the effect of a warm page cache.
      const results =
        index % 2 === 0
          ? { tsgolint: run("tsgolint"), tsrs: run("tsrs") }
          : { tsrs: run("tsrs"), tsgolint: run("tsgolint") };
      assert.deepEqual(
        results.tsrs.diagnostics,
        results.tsgolint.diagnostics,
        label,
      );
      assert.equal(results.tsrs.files, results.tsgolint.files);
      return { label, ...results };
    });
    const [base, clean, affected, restored] = rounds;
    assert.ok(base && clean && affected && restored);
    assert.deepEqual(clean.tsrs.diagnostics, base.tsrs.diagnostics);
    assert.deepEqual(restored.tsrs.diagnostics, base.tsrs.diagnostics);
    const newFindings = affected.tsrs.diagnostics.filter(
      (item) =>
        item.file === file && item.offset >= Buffer.byteLength(original),
    );
    assert.equal(newFindings.length, 1);
    assert.equal(
      newFindings[0]?.line,
      probe("Promise<void>").split("\n").length - 1,
    );
    assert.deepEqual(
      affected.tsrs.diagnostics.filter((item) => !newFindings.includes(item)),
      base.tsrs.diagnostics,
    );
    return {
      rule,
      oxlint: oxlint.version,
      backends: Object.fromEntries(
        Object.entries(backends).map(
          ([name, { packageName, version, entry }]) => [
            name,
            { packageName, version, entry },
          ],
        ),
      ),
      rounds,
    };
  } finally {
    writeFileSync(target, original);
    rmSync(directory, { recursive: true, force: true });
  }
}
