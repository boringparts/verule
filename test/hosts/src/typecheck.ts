import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { resolvePathInsideRoot } from "./materials.ts";

const require = createRequire(import.meta.url);
const tscScriptPath = join(
  dirname(require.resolve("typescript-7/package.json")),
  "bin",
  "tsc",
);

export type HostTypecheckResult = {
  readonly tsconfigPath: string;
  readonly stdout: string;
  readonly stderr: string;
};

/**
 * Runs `tsc -p <tsconfigRelativePath> --noEmit --pretty false` inside `rootDir`,
 * rejecting with full compiler output when typechecking fails.
 */
export function runTscTypecheck(
  rootDir: string,
  tsconfigRelativePath = "tsconfig.json",
): Promise<HostTypecheckResult> {
  const tsconfigPath = resolvePathInsideRoot(rootDir, tsconfigRelativePath);
  if (!existsSync(tsconfigPath)) {
    return Promise.reject(
      new Error(`Missing tsconfig file for host typecheck: ${tsconfigPath}`),
    );
  }

  return new Promise((resolveResult, rejectResult) => {
    execFile(
      process.execPath,
      [tscScriptPath, "-p", tsconfigPath, "--noEmit", "--pretty", "false"],
      {
        cwd: rootDir,
        encoding: "utf8",
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolveResult({ tsconfigPath, stdout, stderr });
          return;
        }
        const exitCode = typeof error.code === "number" ? error.code : 1;
        const output = [stdout.trim(), stderr.trim()]
          .filter((part) => part.length > 0)
          .join("\n");
        rejectResult(
          new Error(
            `Typecheck failed for ${tsconfigRelativePath} (exit ${String(exitCode)})${output.length > 0 ? `:\n${output}` : ""}`,
          ),
        );
      },
    );
  });
}
