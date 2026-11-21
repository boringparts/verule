import { deepStrictEqual, equal } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, release, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

import { contractModels, contractRules } from "@verule/examples";
import { openProject, Project, type Node, type Report } from "@verule/sdk";
import { isCallExpression } from "tsrs/ast";

import { processMemory } from "./memory.ts";

const modes = ["compiler", "full", "incremental"] as const;
type Mode = (typeof modes)[number];
type Scenario =
  | "cold"
  | "repeat"
  | "local"
  | "localRestore"
  | "broad"
  | "broadRestore";

interface Sample {
  scenario: Scenario;
  latencyMs: number;
  nodeRssMiB: number;
  compilerTreeRssMiB: number | null;
  facts?: number;
  digest?: string;
  diagnostics?: number;
  gaps?: number;
}

interface FileEdit {
  file: string;
  before: string;
  after: string;
}

function edit(file: string, oldText: string, newText: string): FileEdit {
  const before = readFileSync(file, "utf8");
  if (before.split(oldText).length !== 2)
    throw new Error(`Expected one edit anchor in ${file}.`);
  return { file, before, after: before.replace(oldText, newText) };
}

function readCompilerFacts(project: Project): number {
  let resolved = 0;
  for (const source of project.sourceFiles) {
    const callees: Node[] = [];
    function visit(node: Node): void {
      if (isCallExpression(node)) callees.push(node.expression);
      node.forEachChild(visit);
    }
    visit(source);
    if (callees.length) {
      resolved += project.raw.checker
        .getSymbolAtLocation(callees)
        .filter(Boolean).length;
    }
  }
  return resolved;
}

function record(
  scenario: Scenario,
  start: number,
  result: Report | number,
): Sample {
  const latencyMs = performance.now() - start;
  const sample = {
    scenario,
    latencyMs,
    nodeRssMiB: process.memoryUsage.rss() / 2 ** 20,
    compilerTreeRssMiB: processMemory(process.pid)?.childrenMiB ?? null,
  };
  if (typeof result === "number") return { ...sample, facts: result };
  return {
    ...sample,
    diagnostics: result.diagnostics.length,
    gaps: result.gaps.length,
    digest: createHash("sha256")
      .update(JSON.stringify([result.diagnostics, result.gaps]))
      .digest("hex"),
  };
}

function trial(directory: string, mode: Mode): Sample[] {
  const tsconfig = join(directory, "tsconfig.json");
  const local = edit(
    join(directory, "test/error-boundaries.test.ts"),
    "executeCli(second, {",
    "executeCli(first, {",
  );
  const broad = edit(
    join(directory, "src/cli-contract.ts"),
    "  readonly grammar: [Commands] extends [never]",
    "  readonly measurementTag?: string;\n  readonly grammar: [Commands] extends [never]",
  );

  const start = performance.now();
  const session = mode === "compiler" ? undefined : openProject(tsconfig);
  const project = session?.project ?? new Project(tsconfig);
  const rows: Sample[] = [];
  function run(
    scenario: Scenario,
    changedFiles: string[],
    begin = performance.now(),
  ) {
    let result: Report | number;
    if (session) {
      result = session.check(
        { rules: contractRules, models: contractModels },
        { changedFiles, full: mode === "full" },
      );
    } else {
      project.update(changedFiles);
      result = readCompilerFacts(project);
    }
    rows.push(record(scenario, begin, result));
  }
  try {
    run("cold", [], start);
    run("repeat", []);
    writeFileSync(local.file, local.after);
    run("local", [local.file]);
    writeFileSync(local.file, local.before);
    run("localRestore", [local.file]);
    writeFileSync(broad.file, broad.after);
    run("broad", [broad.file]);
    writeFileSync(broad.file, broad.before);
    run("broadRestore", [broad.file]);
  } finally {
    try {
      writeFileSync(local.file, local.before);
      writeFileSync(broad.file, broad.before);
    } finally {
      project.close();
    }
  }
  if (mode !== "compiler") {
    const [cold, repeat, localChange, localRestore, , broadRestore] = rows;
    if (cold?.diagnostics === undefined)
      throw new Error("Missing baseline report.");
    equal(
      localChange?.diagnostics,
      cold.diagnostics - 1,
      "Fixing the mismatch removes its finding.",
    );
    for (const row of [repeat, localRestore, broadRestore]) {
      equal(
        row?.digest,
        cold.digest,
        "Restored sources must reproduce the complete initial report.",
      );
    }
  }
  return rows;
}

function percentile(values: number[], fraction: number): number {
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * fraction) - 1]!;
}

function summarize(rows: Sample[]) {
  return [...new Set(rows.map((entry) => entry.scenario))].map((scenario) => {
    const values = rows.filter((entry) => entry.scenario === scenario);
    const times = values.map((entry) => entry.latencyMs);
    const compiler = values.flatMap((entry) =>
      entry.compilerTreeRssMiB === null ? [] : [entry.compilerTreeRssMiB],
    );
    return {
      scenario,
      samples: times.length,
      medianMs: percentile(times, 0.5),
      p95Ms: percentile(times, 0.95),
      maxSampledNodeRssMiB: Math.max(
        ...values.map((entry) => entry.nodeRssMiB),
      ),
      maxSampledCompilerTreeRssMiB: compiler.length
        ? Math.max(...compiler)
        : null,
      raw: values,
    };
  });
}

/** Run only on a prepared scratch checkout of cli-contract@0.5.0. Each
 * trial starts a fresh Node process and compiler, then replays the same edits. */
export function measureProject(libraryDirectory: string, samples = 3) {
  if (!Number.isSafeInteger(samples) || samples < 1)
    throw new Error("Expected a positive sample count.");
  const directory = resolve(libraryDirectory);
  const results: Record<Mode, Sample[]> = {
    compiler: [],
    full: [],
    incremental: [],
  };
  for (let i = 0; i < samples; i++) {
    // Rotate the first runner to distribute the warm filesystem cache across modes.
    for (let j = 0; j < modes.length; j++) {
      const mode = modes[(i + j) % modes.length]!;
      const child = spawnSync(
        process.execPath,
        [import.meta.filename, "--trial", mode, directory],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      if (child.error) throw child.error;
      if (child.status !== 0)
        throw new Error(
          `Measurement for ${mode} failed: ${child.stderr || child.signal}`,
        );
      const rows = JSON.parse(child.stdout) as Sample[];
      results[mode].push(...rows);
    }
  }
  // Include gaps, stable IDs, evidence and every location. Revision labels are
  // per-session, so comparisons hash the report payload identical to a consumer's view.
  deepStrictEqual(
    results.incremental.map((row) => row.digest),
    results.full.map((row) => row.digest),
  );
  return {
    hardware: {
      platform: platform(),
      kernel: release(),
      arch: arch(),
      cpu: cpus()[0]?.model,
      logicalCpus: cpus().length,
      ramMiB: totalmem() / 2 ** 20,
    },
    node: process.version,
    compilerVersion: "tsrs@7.1.0-beta.tsrs4",
    project: "cli-contract@8698e58b730da0034676362ffbe2f6bd425e8ddc",
    cost: "Cold starts at compiler construction after JS module loading. Warm spans start after the edit is written and end when the synchronous query returns. RSS is sampled just after each query. Linux compiler RSS sums worker descendants. Compiler-only counts resolved call-head symbols via one batch per file; it does not produce a rule report.",
    matchedReportPairs: results.full.length,
    compiler: summarize(results.compiler),
    full: summarize(results.full),
    incremental: summarize(results.incremental),
  };
}

if (import.meta.main) {
  if (process.argv[2] === "--trial") {
    const mode = modes.find((value) => value === process.argv[3]);
    if (!mode || !process.argv[4])
      throw new Error("Expected --trial MODE LIBRARY_DIRECTORY.");
    process.stdout.write(JSON.stringify(trial(resolve(process.argv[4]), mode)));
  } else {
    if (!process.argv[2])
      throw new Error("Expected LIBRARY_DIRECTORY [SAMPLES].");
    console.log(
      JSON.stringify(
        measureProject(process.argv[2], Number(process.argv[3] ?? 3)),
        null,
        2,
      ),
    );
  }
}
