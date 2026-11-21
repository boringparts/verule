import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export function installedBin(packageName: string, command: string) {
  const manifest = fileURLToPath(
    import.meta.resolve(packageName + "/package.json"),
  );
  const { version, bin } = JSON.parse(readFileSync(manifest, "utf8")) as {
    version: string;
    bin: Record<string, string>;
  };
  const entry = bin[command];
  assert.ok(entry, `Missing ${command} executable in ${packageName}.`);
  return { packageName, version, entry, path: join(dirname(manifest), entry) };
}

interface OxlintDiagnostic {
  message: string;
  code: string;
  filename: string;
  labels: {
    span: { offset: number; length: number; line: number; column: number };
  }[];
}

export const oxlint = installedBin("oxlint", "oxlint");

/** Both comparisons time a fresh process with one Oxlint worker on the same source directories.
 * Stop timing on process exit, before the harness parses or checks the report. */
export function runOxlint(
  cwd: string,
  config: string,
  args: string[],
  env: Record<string, string>,
) {
  const start = performance.now();
  const run = spawnSync(
    process.execPath,
    [
      oxlint.path,
      ...args,
      "--threads",
      "1",
      "--disable-nested-config",
      "--format",
      "json",
      "-c",
      config,
      "src",
      "test",
    ],
    {
      cwd,
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      env: { ...process.env, ...env },
    },
  );
  const ms = performance.now() - start;
  if (run.error) throw run.error;
  assert.equal(run.status, 0, run.stderr + " " + run.stdout.slice(0, 1000));
  const report = JSON.parse(run.stdout) as {
    diagnostics: OxlintDiagnostic[];
    number_of_rules: number;
    number_of_files: number;
  };
  return { ms, report };
}
