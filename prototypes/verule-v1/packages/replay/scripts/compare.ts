import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import type { Location, Report } from "@verule/sdk";

import type { ComparisonFinding } from "../src/oxlint-plugin.ts";
import { processMemory } from "./memory.ts";

const cli = fileURLToPath(import.meta.resolve("@verule/cli/bin"));
const oxlintManifest = fileURLToPath(
  import.meta.resolve("oxlint/package.json"),
);
const oxlint = join(
  dirname(oxlintManifest),
  JSON.parse(readFileSync(oxlintManifest, "utf8")).bin.oxlint,
);

function checkedReplace(source: string, before: string, after: string) {
  assert.equal(
    source.split(before).length,
    2,
    `Expected a unique edit: ${before}`,
  );
  return source.replace(before, after);
}
function atomic(cwd: string) {
  const start = performance.now();
  const run = spawnSync(process.execPath, [cli, "check", "--output", "json"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
  assert.ok(run.status === 0 || run.status === 1, run.stderr);
  const report = (JSON.parse(run.stdout) as { data: Report }).data;
  assert.equal(run.status, report.diagnostics.length ? 1 : 0);
  return { report, ms: performance.now() - start };
}
function lint(cwd: string, config: string) {
  const start = performance.now();
  const run = spawnSync(
    process.execPath,
    [oxlint, "--threads", "1", "--format", "json", "-c", config, "src", "test"],
    { cwd, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
  );
  assert.equal(run.status, 0, run.stderr + " " + run.stdout.slice(0, 1000));
  const diagnostics = (
    JSON.parse(run.stdout) as { diagnostics: { message: string }[] }
  ).diagnostics;
  const entries = diagnostics.map(
    (d) => JSON.parse(d.message) as ComparisonFinding,
  );
  return { entries, ms: performance.now() - start };
}

// Use source anchors from the pinned upstream cases so moving an edit also moves
// its expected location. The marker may span lines; the selected token is on one line.
function anchor(
  file: string,
  source: string,
  marker: string,
  token: string,
): Location {
  const offset = source.indexOf(marker);
  assert.ok(
    offset >= 0 && source.indexOf(marker, offset + 1) === -1,
    `Expected one ${file} anchor: ${marker}`,
  );
  const within = marker.indexOf(token);
  assert.notEqual(within, -1, token);
  const prefix = source.slice(0, offset + within);
  const line = prefix.split("\n").length;
  const column = prefix.length - prefix.lastIndexOf("\n");
  return {
    file,
    line,
    column,
    endLine: line,
    endColumn: column + token.length,
  };
}

function site(rule: string, at: Location) {
  return `${rule} ${at.file}:${at.line}:${at.column}-${at.endLine}:${at.endColumn}`;
}

interface ExpectedFinding {
  rule: string;
  at: Location;
  evidence: Location[];
}

function assertFindings(
  actual: ExpectedFinding[],
  expected: ExpectedFinding[],
  round: string,
) {
  const locations = (findings: ExpectedFinding[]) =>
    findings.map((item) => site(item.rule, item.at)).sort();
  assert.deepEqual(locations(actual), locations(expected), round);
  for (const finding of expected) {
    const observed = actual.find(
      (item) => site(item.rule, item.at) === site(finding.rule, finding.at),
    )!;
    for (const required of finding.evidence) {
      assert.ok(
        observed.evidence.some(
          (point) =>
            point.file === required.file &&
            point.line === required.line &&
            point.column === required.column &&
            (point.endLine > required.endLine ||
              (point.endLine === required.endLine &&
                point.endColumn >= required.endColumn)),
        ),
        `${round}: missing evidence at ${site(finding.rule, required)}`,
      );
    }
  }
}

/** Wall-clock times bracket the actual CLI process or watch edit and the final
 * byte of its report. The wire span separately measures first to last chunk. */
export async function compareTools(cwd: string) {
  const config = join(cwd, "verule.config.ts");
  const examples = import.meta.resolve("@verule/examples");
  writeFileSync(
    config,
    `import {contractRules,contractModels} from ${JSON.stringify(examples)};\nexport default {tsconfig:"./tsconfig.json",rules:contractRules,models:contractModels};\n`,
  );
  const oxConfig = join(cwd, ".oxlintrc.comparison.json");
  writeFileSync(
    oxConfig,
    JSON.stringify({
      plugins: [],
      jsPlugins: [
        fileURLToPath(new URL("../src/oxlint-plugin.ts", import.meta.url)),
      ],
      categories: { correctness: "off" },
      rules: {
        "contract-comparison/contract-instance": "warn",
        "contract-comparison/validated-input": "warn",
      },
    }),
  );
  const idPath = "test/error-boundaries.test.ts";
  const dispatchPath = "src/cli-execution.ts";
  const helperPath = "src/replay-forward.ts";
  const idFile = join(cwd, idPath);
  const dispatchFile = join(cwd, dispatchPath);
  const helperFile = join(cwd, helperPath);
  const originalId = readFileSync(idFile, "utf8");
  const originalDispatch = readFileSync(dispatchFile, "utf8");
  writeFileSync(
    helperFile,
    "export function forward<T>(value: T): T { return value; }\n",
  );
  const crossImport =
    'import {forward as carry} from "../src/replay-forward.ts";\n';
  const alias = checkedReplace(
    originalId,
    "const invocation = parseCliInvocation(first, []);",
    "const alias = first;\n  const invocation = parseCliInvocation(first, []);",
  );
  const raw = checkedReplace(
    originalDispatch,
    "        validation.value,",
    "        options.invocation.input,",
  );
  const successfulOutput = checkedReplace(
    originalDispatch,
    "      return executeApplicationResult(",
    "      const resultInput = validation.value;\n      return executeApplicationResult(",
  );
  const aliasedValidation = checkedReplace(
    checkedReplace(
      successfulOutput,
      "  validateCliInput,",
      "  validateCliInput as checkInput,",
    ),
    "const validation = validateCliInput(",
    "const validation = checkInput(",
  );
  const rounds = [
    { label: "original", id: true, raw: false },
    {
      label: "same-instance-alias",
      file: idFile,
      text: checkedReplace(alias, "executeCli(second,", "executeCli(alias,"),
      id: false,
      raw: false,
    },
    {
      label: "renamed-import",
      file: idFile,
      text: originalId
        .replaceAll("parseCliInvocation", "parseRequest")
        .replace("  parseRequest,", "  parseCliInvocation as parseRequest,"),
      id: true,
      raw: false,
    },
    {
      label: "forwarded-invocation",
      file: idFile,
      text:
        crossImport +
        checkedReplace(
          originalId,
          "const invocation = parseCliInvocation(first, []);",
          "const invocation = carry(parseCliInvocation(first, []));",
        ),
      id: true,
      raw: false,
    },
    {
      label: "unknown-factory",
      file: idFile,
      text:
        "declare function opaque<T>(value:T):T;\n" +
        checkedReplace(
          originalId,
          "executeCli(second,",
          "executeCli(opaque(second),",
        ),
      id: false,
      raw: false,
    },
    {
      label: "restore-instance",
      file: idFile,
      text: originalId,
      id: true,
      raw: false,
    },
    { label: "raw-input", file: dispatchFile, text: raw, id: true, raw: true },
    {
      label: "forwarded-raw-input",
      file: dispatchFile,
      text:
        'import {forward as carry} from "./replay-forward.ts";\n' +
        checkedReplace(
          raw,
          "        options.invocation.input,\n        options,",
          "        carry(options.invocation.input),\n        options,",
        ),
      id: true,
      raw: true,
    },
    {
      label: "forwarded-valid-input",
      file: dispatchFile,
      text:
        'import {forward as carry} from "./replay-forward.ts";\n' +
        checkedReplace(
          originalDispatch,
          "        validation.value,",
          "        carry(validation.value),",
        ),
      id: true,
      raw: false,
    },
    {
      label: "renamed-validator-and-output-alias",
      file: dispatchFile,
      text: checkedReplace(
        aliasedValidation,
        "        validation.value,",
        "        resultInput,",
      ),
      id: true,
      raw: false,
    },
    {
      label: "unknown-input",
      file: dispatchFile,
      text:
        "declare function opaque<T>(value:T):T;\n" +
        checkedReplace(
          originalDispatch,
          "        validation.value,",
          "        opaque(validation.value),",
        ),
      id: true,
      raw: false,
    },
    {
      label: "restore-dispatch",
      file: dispatchFile,
      text: originalDispatch,
      id: true,
      raw: false,
    },
  ];
  const start = performance.now();
  const watch = spawn(process.execPath, [cli, "watch", "--output", "ndjson"], {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(watch, "exit");
  let stderr = "";
  watch.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const chunks = watch.stdout.setEncoding("utf8")[Symbol.asyncIterator]();
  let buffer = "";
  let firstByte = 0;
  async function reportLine() {
    for (;;) {
      const end = buffer.indexOf("\n");
      if (end !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const endAt = performance.now();
        const span = endAt - firstByte;
        if (buffer.length) firstByte = endAt;
        const envelope = JSON.parse(line);
        if (envelope.kind === "stream") continue;
        assert.equal(envelope.variant, "report", line);
        return {
          report: envelope.data as Report,
          bytes: Buffer.byteLength(line) + 1,
          wireSpanMs: span,
          at: endAt,
        };
      }
      const chunk = await chunks.next();
      assert.ok(!chunk.done, "Watch closed: " + stderr);
      if (!buffer.length) firstByte = performance.now();
      buffer += chunk.value.toString("utf8");
    }
  }
  const rows = [];
  let originalReports:
    | {
        verule: Pick<Report, "diagnostics" | "gaps">;
        oxlint: ComparisonFinding[];
      }
    | undefined;
  try {
    for (const round of rounds) {
      const before = round.file ? performance.now() : start;
      if (round.file && round.text) writeFileSync(round.file, round.text);
      const timeout = AbortSignal.timeout(60000);
      const live = await Promise.race([
        reportLine(),
        new Promise<never>((_, reject) =>
          timeout.addEventListener(
            "abort",
            () =>
              reject(
                new Error(
                  "Timed out waiting for watch: " + round.label + " " + stderr,
                ),
              ),
            { once: true },
          ),
        ),
      ]);
      const watchMemory = watch.pid ? processMemory(watch.pid) : null;
      const fresh = atomic(cwd);
      assert.deepEqual(
        live.report.diagnostics,
        fresh.report.diagnostics,
        round.label,
      );
      assert.deepEqual(live.report.gaps, fresh.report.gaps, round.label);
      const baseline = lint(cwd, oxConfig);
      const idSource = readFileSync(idFile, "utf8");
      const dispatchSource = readFileSync(dispatchFile, "utf8");
      const idAt = (marker: string, token: string) =>
        anchor(idPath, idSource, marker, token);
      const dispatchAt = (marker: string, token: string) =>
        anchor(dispatchPath, dispatchSource, marker, token);
      const helperReturn = anchor(
        helperPath,
        readFileSync(helperFile, "utf8"),
        "return value;",
        "value",
      );
      const identity = "cli/contract-instance";
      const validated = "cli/validated-input";
      const factory = idAt("return defineCli()({", "defineCli");
      const forged = idAt("executeCli({} as typeof cli,", "{} as typeof cli");
      const expected: ExpectedFinding[] = [
        {
          rule: identity,
          at: forged,
          evidence: [
            idAt("executeCli({} as typeof cli,", "{}"),
            factory,
            idAt(
              "const cli = createCompletionCli(() => undefined);",
              "createCompletionCli",
            ),
          ],
        },
      ];
      if (round.id) {
        const issued =
          round.label === "renamed-import"
            ? "parseRequest"
            : "parseCliInvocation";
        const target = idAt("executeCli(second,", "second");
        expected.push({
          rule: identity,
          at: target,
          evidence: [
            factory,
            idAt("const first = createCompletionCli(", "createCompletionCli"),
            idAt("const second = createCompletionCli(", "createCompletionCli"),
            idAt(issued + "(first, [])", issued + "(first, [])"),
            target,
            ...(round.label === "forwarded-invocation" ? [helperReturn] : []),
          ],
        });
      }
      if (round.raw) {
        const forwarded = round.label === "forwarded-raw-input";
        const arg = forwarded
          ? "carry(options.invocation.input)"
          : "options.invocation.input";
        const marker = "        " + arg + ",\n        options,";
        const target = dispatchAt(marker, arg);
        expected.push({
          rule: validated,
          at: target,
          evidence: [
            dispatchAt(
              "  options: ExecuteCliOptions<Contract, Invocation>,\n): Promise<CliTermination<Contract>> {\n  const compiled = ",
              "options",
            ),
            dispatchAt(marker, "options.invocation.input"),
            target,
            ...(forwarded ? [helperReturn] : []),
          ],
        });
      }
      const findings = baseline.entries.filter((e) => e.kind === "violation");
      const veruleFindings = fresh.report.diagnostics.map((d) => ({
        rule: d.rule,
        at: d.at,
        evidence: d.evidence.map((e) => e.at),
      }));
      const oxlintFindings = findings.map((d) => ({
        rule: d.ruleId,
        at: d.location,
        evidence: d.evidence,
      }));
      assertFindings(veruleFindings, expected, "Verule " + round.label);
      assertFindings(oxlintFindings, expected, "Oxlint " + round.label);
      const oxlintGaps = baseline.entries
        .filter((e) => e.kind === "unknown")
        .map((entry) => ({
          rule: entry.ruleId,
          at: entry.location,
          reason: entry.reason,
        }));
      const veruleGaps = fresh.report.gaps;
      for (const gaps of [veruleGaps, oxlintGaps]) {
        if (round.label === "unknown-factory") {
          const opaque = idAt("executeCli(opaque(second),", "opaque(second)");
          assert.ok(
            gaps.some((g) => site(g.rule, g.at) === site(identity, opaque)),
            round.label,
          );
        }
        const inputGaps = gaps.filter((g) => g.rule === validated);
        if (round.label === "unknown-input") {
          const opaque = dispatchAt(
            "        opaque(validation.value),",
            "opaque(validation.value)",
          );
          assert.ok(
            inputGaps.some(
              (g) => site(g.rule, g.at) === site(validated, opaque),
            ),
            round.label,
          );
        } else {
          // The dispatch in the upstream case is the only call to this function.
          // A valid alias or forwarding helper must preserve the known validation output.
          assert.deepEqual(inputGaps, [], round.label);
        }
      }
      // Gap reasons and path granularity differ between implementations. Preserve
      // every unmatched location and its explanation rather than comparing counts.
      const missingFrom = (
        left: typeof veruleGaps,
        right: typeof veruleGaps,
      ) => {
        const locations = new Set(right.map((g) => site(g.rule, g.at)));
        return left.filter((g) => !locations.has(site(g.rule, g.at)));
      };
      const orderedOxlint = [...baseline.entries].sort((a, b) =>
        JSON.stringify(a).localeCompare(JSON.stringify(b)),
      );
      const verulePayload = {
        diagnostics: fresh.report.diagnostics,
        gaps: veruleGaps,
      };
      if (round.label === "original")
        originalReports = { verule: verulePayload, oxlint: orderedOxlint };
      if (
        round.label === "restore-instance" ||
        round.label === "restore-dispatch"
      ) {
        assert.deepEqual(verulePayload, originalReports?.verule, round.label);
        assert.deepEqual(orderedOxlint, originalReports?.oxlint, round.label);
      }
      rows.push({
        label: round.label,
        watchMs: live.at - before,
        watchMemory,
        checkMs: fresh.ms,
        oxlintMs: baseline.ms,
        bytes: live.bytes,
        wireSpanMs: live.wireSpanMs,
        coverageDifferences: {
          gapsOnlyInVerule: missingFrom(veruleGaps, oxlintGaps),
          gapsOnlyInOxlint: missingFrom(oxlintGaps, veruleGaps),
        },
        verule: {
          violations: fresh.report.diagnostics.length,
          gaps: fresh.report.gaps.length,
          findings: fresh.report.diagnostics,
        },
        oxlint: {
          violations: findings.length,
          gaps: baseline.entries.length - findings.length,
          findings,
        },
      });
    }
  } finally {
    watch.kill("SIGTERM");
    await exited;
    writeFileSync(idFile, originalId);
    writeFileSync(dispatchFile, originalDispatch);
    for (const path of [config, oxConfig, helperFile]) unlinkSync(path);
  }
  return rows;
}
