#!/usr/bin/env node
import { fstatSync } from "node:fs";
import { createRequire } from "node:module";

import { nodeCliOutput } from "@boringparts/cli-contract/node";

import { cliCommandIdentity } from "./cli-command-identity.ts";
import { runCli } from "./main.ts";

const require = createRequire(import.meta.url);
const shutdownController = new AbortController();
const abortShutdown = () => shutdownController.abort();

process.on("SIGINT", abortShutdown);
process.on("SIGTERM", abortShutdown);

let watchStdin = false;
try {
  const stdinStat = fstatSync(0);
  watchStdin = stdinStat.isFIFO() || stdinStat.isSocket();
} catch {
  watchStdin = false;
}
if (watchStdin) {
  process.stdin.once("end", abortShutdown);
  process.stdin.resume();
}

try {
  process.exitCode = await runCli({
    argv: process.argv,
    signal: shutdownController.signal,
    write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
    // Keep manifest reading and identity validation inside runCli's unexpected-failure boundary.
    get identity() {
      return cliCommandIdentity(require("../package.json"));
    },
  });
} finally {
  process.off("SIGINT", abortShutdown);
  process.off("SIGTERM", abortShutdown);
  if (watchStdin) {
    process.stdin.off("end", abortShutdown);
    process.stdin.pause();
  }
}
