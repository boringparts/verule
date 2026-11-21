#!/usr/bin/env node
import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { runCli } from "./main.ts";

const controller = new AbortController();
const stop = () => controller.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
try {
  process.exitCode = await runCli(
    process.argv.slice(2),
    nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
    controller.signal,
  );
} finally {
  process.off("SIGINT", stop);
  process.off("SIGTERM", stop);
}
