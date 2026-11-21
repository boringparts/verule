import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { fileURLToPath } from "node:url";

export const cliArgs = [
  "--conditions=source",
  fileURLToPath(new URL("../src/cli.ts", import.meta.url)),
];

export async function project(t: TestContext) {
  const cwd = await mkdtemp(join(tmpdir(), "verule-cli-"));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  await Promise.all([
    writeFile(join(cwd, "package.json"), '{"type":"module"}'),
    writeFile(
      join(cwd, "tsconfig.json"),
      '{"compilerOptions":{"target":"esnext"},"files":["app.ts"]}',
    ),
    writeFile(
      join(cwd, "verule.config.ts"),
      [
        `import { defineConfig } from ${JSON.stringify(import.meta.resolve("@verule/sdk"))};`,
        'import { rules } from "./rules.ts";',
        'export default defineConfig({ tsconfig: "./tsconfig.json", rules });',
      ].join("\n"),
    ),
    writeFile(
      join(cwd, "rules.ts"),
      [
        'export const rules = [{ id: "no-publish", run(q) {',
        '  const publish = q.symbol({ file: "app.ts", name: "publish" }).value;',
        '  if (publish) for (const at of q.calls(publish)) q.report({ at, message: "Unexpected publication." });',
        "} }];",
      ].join("\n"),
    ),
    writeFile(
      join(cwd, "app.ts"),
      "export function publish() {}\npublish();\npublish();\n",
    ),
  ]);
  return cwd;
}
