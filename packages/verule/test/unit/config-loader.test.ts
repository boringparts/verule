import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { loadProjectConfigWithDependencies } from "../../src/config-loader.ts";

const CONFIG_LOADER_MODULE_URL = new URL(
  "../../src/config-loader.ts",
  import.meta.url,
).href;

const processEmitWarningHost: { emitWarning: typeof process.emitWarning } =
  process;

function createTempDir(): string {
  // Realpath tmpdir so symlink comparisons remain canonical on platforms where /tmp is symlinked.
  return realpathSync(mkdtempSync(join(tmpdir(), "verule-config-loader-")));
}

void describe("config-loader", () => {
  void it("suppresses Type Stripping ExperimentalWarning during .ts config import while forwarding other warnings", async () => {
    const dir = createTempDir();
    const originalEmitWarning = processEmitWarningHost.emitWarning;
    const forwarded: Array<{
      readonly message: string;
      readonly typeOrOptions: unknown;
    }> = [];
    const spyEmitWarning: typeof process.emitWarning = (warning, ...args) => {
      forwarded.push({
        message: typeof warning === "string" ? warning : warning.message,
        typeOrOptions: args[0],
      });
    };

    try {
      writeFileSync(
        join(dir, "verule.config.ts"),
        [
          'process.emitWarning("Type Stripping is an experimental feature and might change at any time", { type: "ExperimentalWarning", code: "EXPERIMENTAL_TYPE_STRIPPING" });',
          'process.emitWarning("Type Stripping positional warning", "ExperimentalWarning");',
          'process.emitWarning("Custom deprecation notice", { type: "DeprecationWarning", code: "DEP_TEST" });',
          'process.emitWarning("Other experimental notice", { type: "ExperimentalWarning", code: "EXP_OTHER" });',
          "export default {",
          '  tsconfig: "./tsconfig.json",',
          "  rules: [],",
          "};",
          "",
        ].join("\n"),
      );

      processEmitWarningHost.emitWarning = spyEmitWarning;
      const loaded = await loadProjectConfigWithDependencies(dir);

      assert.equal(loaded.config.tsconfig, "./tsconfig.json");
      assert.equal(processEmitWarningHost.emitWarning, spyEmitWarning);
      assert.deepStrictEqual(
        forwarded.map((entry) => entry.message),
        ["Custom deprecation notice", "Other experimental notice"],
      );
    } finally {
      processEmitWarningHost.emitWarning = originalEmitWarning;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("restores the exact original process.emitWarning reference after load errors and concurrent imports", async () => {
    const dir = createTempDir();
    const originalEmitWarning = processEmitWarningHost.emitWarning;
    const spyEmitWarning: typeof process.emitWarning = () => {};

    try {
      writeFileSync(
        join(dir, "throwing.config.ts"),
        'throw new Error("boom during config evaluation");\n',
      );
      writeFileSync(
        join(dir, "slow-valid.config.ts"),
        [
          "await new Promise((resolve) => setTimeout(resolve, 30));",
          "export default {",
          '  tsconfig: "./tsconfig.json",',
          "  rules: [],",
          "};",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "missing-default.config.ts"),
        "export const notDefault = 1;\n",
      );

      processEmitWarningHost.emitWarning = spyEmitWarning;

      await assert.rejects(
        () => loadProjectConfigWithDependencies(dir, "throwing.config.ts"),
        /Failed to load Verule configuration/u,
      );
      assert.equal(processEmitWarningHost.emitWarning, spyEmitWarning);

      await assert.rejects(
        () =>
          loadProjectConfigWithDependencies(dir, "missing-default.config.ts"),
        /must export a default configuration object/u,
      );
      assert.equal(processEmitWarningHost.emitWarning, spyEmitWarning);

      const [throwingOutcome, validOutcome] = await Promise.allSettled([
        loadProjectConfigWithDependencies(dir, "throwing.config.ts"),
        loadProjectConfigWithDependencies(dir, "slow-valid.config.ts"),
      ]);
      assert.equal(throwingOutcome.status, "rejected");
      assert.equal(validOutcome.status, "fulfilled");
      assert.equal(processEmitWarningHost.emitWarning, spyEmitWarning);
    } finally {
      processEmitWarningHost.emitWarning = originalEmitWarning;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  void it("tracks both local symlink path and canonical realpath in watchFiles unless NODE_OPTIONS sets --preserve-symlinks", async () => {
    const dir = createTempDir();

    try {
      const projectDir = join(dir, "project");
      const sharedDir = join(dir, "shared");
      const nmPkgDir = join(projectDir, "node_modules", "linked-pkg");
      mkdirSync(projectDir, { recursive: true });
      mkdirSync(sharedDir, { recursive: true });
      mkdirSync(nmPkgDir, { recursive: true });

      const realSubmodulePath = join(sharedDir, "helper.ts");
      writeFileSync(
        realSubmodulePath,
        'export const ruleName = "symlinked-rule";\n',
      );

      const nmTargetPath = join(nmPkgDir, "index.mjs");
      writeFileSync(nmTargetPath, 'export const pkgFlag = "from-nm";\n');

      const localSymlinkPath = join(projectDir, "linked-helper.ts");
      symlinkSync(realSubmodulePath, localSymlinkPath);

      const localToNmSymlinkPath = join(projectDir, "linked-nm.mjs");
      symlinkSync(nmTargetPath, localToNmSymlinkPath);

      writeFileSync(
        join(projectDir, "verule.config.ts"),
        [
          'import { ruleName } from "./linked-helper.ts";',
          'import { pkgFlag } from "./linked-nm.mjs";',
          "export default {",
          '  tsconfig: "./tsconfig.json",',
          "  rules: [{ id: `${ruleName}-${pkgFlag}`, run() {} }],",
          "};",
          "",
        ].join("\n"),
      );

      const loadViaChild = (nodeOptions: string | undefined) => {
        const env: Record<string, string | undefined> = { ...process.env };
        if (nodeOptions === undefined) {
          delete env.NODE_OPTIONS;
        } else {
          env.NODE_OPTIONS = nodeOptions;
        }
        const script = [
          `import { loadProjectConfigWithDependencies } from ${JSON.stringify(CONFIG_LOADER_MODULE_URL)};`,
          `const loaded = await loadProjectConfigWithDependencies(${JSON.stringify(projectDir)});`,
          "console.log(JSON.stringify(loaded.watchFiles));",
        ].join("\n");
        const stdout = execFileSync(
          process.execPath,
          ["--conditions=source", "--input-type=module", "-e", script],
          {
            cwd: fileURLToPath(new URL("../../", import.meta.url)),
            env,
            encoding: "utf8",
          },
        );
        return JSON.parse(stdout.trim()) as string[];
      };

      // Similar flag `--preserve-symlinks-main` must NOT disable symlink canonicalization.
      const canonicalizedFiles = loadViaChild("--preserve-symlinks-main");
      assert.ok(
        canonicalizedFiles.includes(localSymlinkPath),
        "Expected local symlink path to be tracked in watchFiles",
      );
      assert.ok(
        canonicalizedFiles.includes(realSubmodulePath),
        "Expected realpath of local submodule to be tracked in watchFiles",
      );
      assert.ok(
        canonicalizedFiles.includes(localToNmSymlinkPath),
        "Expected local symlink pointing to node_modules to be tracked in watchFiles",
      );
      assert.equal(
        canonicalizedFiles.includes(nmTargetPath),
        false,
        "Expected node_modules realpath target to be excluded from watchFiles",
      );

      // Exact `--preserve-symlinks` token in NODE_OPTIONS must skip realpathSync canonicalization.
      const preservedFiles = loadViaChild(
        "  --no-warnings   --preserve-symlinks  ",
      );
      assert.ok(preservedFiles.includes(localSymlinkPath));
      assert.equal(
        preservedFiles.includes(realSubmodulePath),
        false,
        "Expected realpath to be omitted when NODE_OPTIONS sets --preserve-symlinks",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
