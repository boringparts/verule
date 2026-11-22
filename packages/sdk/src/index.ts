import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { engineExecutablePath } from "@verule/engine/binary";

const runEngine = promisify(execFile);

/** Runs the packaged engine and rejects if the executable cannot run. */
export async function getEngineVersion(): Promise<string> {
  const { stdout } = await runEngine(engineExecutablePath, ["--version"]);
  return stdout.trimEnd();
}
