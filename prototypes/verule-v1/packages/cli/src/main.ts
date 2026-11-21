import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import {
  CliWriteError,
  defineCli,
  executeCli,
  helpCapability,
  parseCliInvocation,
  text,
  type DataOutcome,
  type FailureOutcome,
  type StreamHandlerContext,
  type WriteCliOutput,
} from "@ykdz/cli-contract";
import { isNodeBrokenPipe } from "@ykdz/cli-contract/node";
import { z } from "zod";

import {
  errorMessage,
  failureSchema,
  presentFailure,
  presentReport,
  reportSchema,
} from "./report.ts";
import { watchProject } from "./watch.ts";

const input = z.object({ config: z.string().optional() });
const fields = {
  config: {
    kind: "valueOption",
    longOption: "--config",
    description:
      "Path to the TypeScript configuration (default: verule.config.ts).",
  },
} as const;
const variants = {
  clean: { description: "No violations.", schema: reportSchema, exitCode: 0 },
  findings: {
    description: "Violations found.",
    schema: reportSchema,
    exitCode: 1,
  },
};
const failure = {
  description: "Check failed.",
  schema: failureSchema,
  exitCode: 2,
};
const failures = { failed: failure };
const textFailures = { failed: { ...failure, text: presentFailure } };
const records = {
  report: {
    description: "Complete report for this version.",
    schema: reportSchema,
  },
  failed: {
    description: "This version could not be checked.",
    schema: failureSchema,
  },
};

type Input = z.infer<typeof input>;
type Dependencies = { signal: AbortSignal };

async function check({
  input,
  outcome,
}: {
  input: Input;
  outcome: DataOutcome<"check", typeof variants> &
    FailureOutcome<"check", typeof failures>;
}) {
  const { Analysis } = await import("./analysis.ts");
  const analysis = new Analysis();
  const version = randomUUID();
  try {
    const { round } = await analysis.check({
      configFile: resolve(input.config ?? "verule.config.ts"),
      version,
      changedFiles: [],
    });
    if ("failure" in round) return outcome.failure.failed(round.failure);
    return round.report.diagnostics.length
      ? outcome.data.findings(round.report)
      : outcome.data.clean(round.report);
  } catch (error) {
    return outcome.failure.failed({ version, message: errorMessage(error) });
  } finally {
    analysis.close();
  }
}

async function* watch({
  input,
  outcome,
  dependencies,
}: StreamHandlerContext<
  "watch",
  Dependencies,
  Input,
  typeof records,
  typeof failures
>) {
  try {
    for await (const round of watchProject(
      resolve(input.config ?? "verule.config.ts"),
      dependencies.signal,
    )) {
      yield "failure" in round
        ? outcome.record.failed(round.failure)
        : outcome.record.report(round.report);
    }
    return outcome.streamSuccess();
  } catch (error) {
    return outcome.failure.failed({
      version: "watch",
      message: errorMessage(error),
    });
  }
}

const define = defineCli<Dependencies>();
const cli = define({
  root: "verule",
  help: helpCapability({
    shortAlias: "-h",
    wording: {
      commandPlaceholder: "command",
      choices: "(choices: {choices})",
      default: "(default: {value})",
    },
  }),
  usageFailureExitCode: 2,
  commands: {
    verule: {
      kind: "rootGroup",
      name: "verule",
      description: "Check project-defined semantic rules.",
    },
    ...define.command("check")({
      parent: "verule",
      kind: "command",
      name: "check",
      description: "Check the configured project once.",
      input,
      fields,
      outputs: define.outputModes("check", input, (mode) => ({
        default: "text",
        modes: {
          json: mode.atomic({
            format: "structured",
            description: "JSON report.",
            success: { kind: "data", variants },
            failures,
            handler: check,
          }),
          text: mode.atomic({
            format: "text",
            description: "Readable report.",
            success: {
              kind: "data",
              variants: {
                clean: { ...variants.clean, text: presentReport },
                findings: { ...variants.findings, text: presentReport },
              },
            },
            failures: textFailures,
            handler: check,
          }),
        },
      })),
    }),
    ...define.command("watch")({
      parent: "verule",
      kind: "command",
      name: "watch",
      description: "Check the project after each edit.",
      input,
      fields,
      outputs: define.outputModes("watch", input, (mode) => ({
        default: "text",
        modes: {
          ndjson: mode.stream({
            format: "structured",
            description: "One JSON record per line.",
            success: { kind: "stream", records },
            failures,
            handler: watch,
          }),
          text: mode.stream({
            format: "text",
            description: "Readable report after each edit.",
            success: {
              kind: "stream",
              text: () => text.silent,
              records: {
                report: {
                  ...records.report,
                  text: (r) =>
                    text.fragment(presentReport(r).lines.join("\n") + "\n"),
                },
                failed: {
                  ...records.failed,
                  text: (f) =>
                    text.fragment(presentFailure(f).lines.join("\n") + "\n"),
                },
              },
            },
            failures: textFailures,
            handler: watch,
          }),
        },
      })),
    }),
  },
});

export async function runCli(
  argv: string[],
  write: WriteCliOutput,
  signal: AbortSignal,
) {
  try {
    const { exitCode } = await executeCli(cli, {
      invocation: parseCliInvocation(cli, argv),
      write,
      dependencies: { signal },
    });
    return exitCode;
  } catch (error) {
    if (
      error instanceof CliWriteError &&
      error.destination === "stdout" &&
      isNodeBrokenPipe(error)
    )
      return 0;
    await write({
      destination: "stderr",
      chunk: `Could not execute command: ${errorMessage(error)}\n`,
    });
    return 2;
  }
}
