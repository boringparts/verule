import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { withTempHost, typecheckHostProjects } from "@verule/test-hosts";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const hostsDir = fileURLToPath(
  new URL("../test/fixtures/cli-hosts", import.meta.url),
);
const require = createRequire(import.meta.url);

function resolvePackageRootDir(entryFilePath: string): string {
  let currentDir = dirname(entryFilePath);
  while (true) {
    if (existsSync(join(currentDir, "package.json"))) {
      return currentDir;
    }
    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      throw new Error(`Could not locate package.json above ${entryFilePath}`);
    }
    currentDir = parentDir;
  }
}

const toolingConfigDir = resolvePackageRootDir(
  require.resolve("@verule/tooling-config/node.json"),
);
const typesNodeDir = resolvePackageRootDir(
  require.resolve("@types/node/package.json"),
);

try {
  await withTempHost(
    {
      hostDirs: [hostsDir],
      files: {
        "package.json": `${JSON.stringify({ name: "verule-cli-hosts-typecheck", private: true, type: "module" }, null, 2)}\n`,
      },
      packageLinks: {
        "@boringparts/verule": packageRoot,
        "@verule/tooling-config": toolingConfigDir,
        "@types/node": typesNodeDir,
      },
      prefix: "verule-cli-hosts-typecheck-",
    },
    async (host) => {
      await typecheckHostProjects(host.rootDir);
    },
  );
} catch (error) {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
}
