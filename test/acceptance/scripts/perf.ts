import { resolve } from "node:path";

import {
  formatPerfCliUsage,
  formatPerfMarkdownReport,
  formatPerfSummaryTable,
  parsePerfCliArgs,
  runPoolOwnershipPerfBaseline,
  writeReportFile,
} from "../src/index.ts";

async function main(): Promise<void> {
  let options;
  try {
    options = parsePerfCliArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
    return;
  }

  if (options.help) {
    process.stdout.write(`${formatPerfCliUsage()}\n`);
    return;
  }

  const invocationCwd =
    process.env.VERULE_PERF_CWD ?? process.env.INIT_CWD ?? process.cwd();
  const report = await runPoolOwnershipPerfBaseline({
    scenario: options.scenario,
    tiers: options.tiers,
    samples: options.samples,
    retries: options.retries,
    logProgress: (line) => {
      process.stderr.write(`[perf] ${line}\n`);
    },
  });

  process.stdout.write(`${formatPerfSummaryTable(report)}\n`);

  if (options.jsonOut !== undefined) {
    const jsonPath = writeReportFile(
      resolve(invocationCwd, options.jsonOut),
      `${JSON.stringify(report, null, 2)}\n`,
    );
    process.stderr.write(`[perf] Wrote JSON report to ${jsonPath}\n`);
  }

  if (options.markdownOut !== undefined) {
    const markdownPath = writeReportFile(
      resolve(invocationCwd, options.markdownOut),
      formatPerfMarkdownReport(report),
    );
    process.stderr.write(`[perf] Wrote Markdown report to ${markdownPath}\n`);
  }

  if (report.status !== "succeeded") {
    process.exitCode = 1;
  }
}

await main();
