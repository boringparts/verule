#!/usr/bin/env node
import { createRequire } from "node:module";

import { nodeCliOutput } from "@ykdz/cli-contract/node";

import { cliCommandIdentity } from "./cli-command-identity.ts";
import { runCli } from "./main.ts";

const require = createRequire(import.meta.url);
process.exitCode = await runCli({
  argv: process.argv,
  write: nodeCliOutput({ stdout: process.stdout, stderr: process.stderr }),
  // Keep manifest reading and identity validation inside runCli's unexpected-failure boundary.
  get identity() {
    return cliCommandIdentity(require("../package.json"));
  },
});
