import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import {
  packWorkspaceArtifacts,
  startArtifactRegistry,
} from "@verule/acceptance";

const execFileAsync = promisify(execFile);
const maxOutputBytes = 16 * 1024 * 1024;

void test("packs @verule/adapter-zod with @verule/cli/@verule/sdk/@verule/engine, installs in an isolated project, and runs verule check via public exports", async () => {
  const bundle = await packWorkspaceArtifacts({
    additionalPackages: ["@verule/adapter-zod"],
  });
  const registry = await startArtifactRegistry(bundle.artifacts);
  const hostDir = mkdtempSync(join(tmpdir(), "verule-zod-packed-host-"));

  try {
    const adapterArtifact = bundle.artifacts.find(
      (artifact) => artifact.name === "@verule/adapter-zod",
    );
    assert.ok(adapterArtifact, "Expected packed @verule/adapter-zod artifact");
    const manifestExports = adapterArtifact.manifest.exports as
      | Record<string, Record<string, string>>
      | undefined;
    assert.equal(manifestExports?.["."]?.default, "./dist/index.js");
    assert.equal(manifestExports?.["."]?.types, "./dist/index.d.ts");
    assert.equal(manifestExports?.["."]?.source, undefined);

    const adapterDeps = adapterArtifact.manifest.dependencies as
      | Record<string, string>
      | undefined;
    assert.equal(adapterDeps?.["@verule/sdk"], adapterArtifact.version);
    assert.equal(adapterDeps?.["@verule/engine"], undefined);

    writeFileSync(
      join(hostDir, "package.json"),
      JSON.stringify(
        {
          name: "isolated-zod-consumer",
          private: true,
          type: "module",
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(hostDir, ".npmrc"),
      `@verule:registry=${registry.url}/\n`,
      "utf8",
    );

    await execFileAsync(
      "pnpm",
      [
        "add",
        "--save-dev",
        "--ignore-scripts",
        "--prefer-offline",
        `@verule/cli@${adapterArtifact.version}`,
        `@verule/sdk@${adapterArtifact.version}`,
        `@verule/adapter-zod@${adapterArtifact.version}`,
        "zod",
      ],
      {
        cwd: hostDir,
        encoding: "utf8",
        maxBuffer: maxOutputBytes,
      },
    );

    rmSync(join(hostDir, ".npmrc"), { force: true });
    await registry.close();

    // Verify all resolved Verule packages come from the isolated hostDir node_modules
    const hostRequire = createRequire(join(hostDir, "package.json"));
    const hostReal = realpathSync(hostDir) + sep;
    for (const pkgName of [
      "@verule/cli/package.json",
      "@verule/sdk",
      "@verule/adapter-zod",
    ]) {
      const resolved = realpathSync(hostRequire.resolve(pkgName));
      assert.ok(
        resolved.startsWith(hostReal),
        `Expected ${pkgName} to resolve inside ${hostReal}, got ${resolved}`,
      );
    }
    const sdkRequire = createRequire(hostRequire.resolve("@verule/sdk"));
    const resolvedEngine = realpathSync(
      sdkRequire.resolve("@verule/engine/binary"),
    );
    assert.ok(
      resolvedEngine.startsWith(hostReal),
      `Expected @verule/engine/binary to resolve inside ${hostReal}, got ${resolvedEngine}`,
    );

    mkdirSync(join(hostDir, "src"), { recursive: true });
    writeFileSync(
      join(hostDir, "tsconfig.json"),
      JSON.stringify(
        {
          compilerOptions: {
            strict: true,
            target: "ES2022",
            module: "NodeNext",
            moduleResolution: "NodeNext",
          },
          include: ["src/**/*.ts"],
        },
        null,
        2,
      ),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "src", "schema.ts"),
      [
        'import { z } from "zod";',
        "",
        'const dynKey = "extra" as string;',
        "",
        "export const baseSchema = z.object({",
        "  id: z.string(),",
        "  nullableKey: z.string().nullable(),",
        "});",
        "",
        "export const createUserSchema = baseSchema",
        "  .extend({",
        '    role: z.string().prefault("member"),',
        "    bio: z.string().optional(),",
        "    [dynKey]: z.string(),",
        "  })",
        "  .transform((v) => ({ ...v }));",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "src", "handler.ts"),
      [
        'import { createUserSchema } from "./schema.js";',
        "",
        "export function handleCreateUser(payload: unknown) {",
        "  return createUserSchema.parse(payload);",
        "}",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(hostDir, "verule.config.mjs"),
      [
        'import { defineConfig, defineRule } from "@verule/sdk";',
        'import { ValidatorInputFieldsFact, ValidatorOutputFieldsFact, zodAdapter } from "@verule/adapter-zod";',
        "",
        "const rulePrimary = defineRule({",
        '  id: "check-zod-fields",',
        "  run: async (ctx) => {",
        '    const inputs = await ctx.facts(ValidatorInputFieldsFact, { condition: { scope: "calls" } });',
        '    const outputs = await ctx.facts(ValidatorOutputFieldsFact, { condition: { scope: "calls" } });',
        "    for (const [idx, fact] of inputs.entries()) {",
        "      const outFact = outputs[idx];",
        '      if (fact.value.requiredFields.includes("nullableKey") && !fact.value.requiredFields.includes("role") && outFact?.value.presentFields.includes("role")) {',
        "        const [syn] = await ctx.syntaxOf([fact.subject], { select: { location: true } });",
        "        if (syn?.location) {",
        "          ctx.report({",
        "            at: syn.location,",
        '            message: `Required=[${fact.value.requiredFields.join(",")}], Output=[${outFact.value.presentFields.join(",")}]`,',
        "            evidence: fact.evidence,",
        "          });",
        "        }",
        "      }",
        "    }",
        "  },",
        "});",
        "",
        "const ruleSecondary = defineRule({",
        '  id: "reuse-zod-fields",',
        "  run: async (ctx) => {",
        '    await ctx.facts(ValidatorInputFieldsFact, { condition: { scope: "calls" } });',
        "  },",
        "});",
        "",
        "export default defineConfig({",
        '  tsconfig: "tsconfig.json",',
        "  adapters: [zodAdapter],",
        "  rules: [rulePrimary, ruleSecondary],",
        "});",
        "",
      ].join("\n"),
      "utf8",
    );

    const veruleBin = join(hostDir, "node_modules", ".bin", "verule");
    assert.equal(existsSync(veruleBin), true, "Missing installed verule bin");

    let stdout = "";
    let stderr = "";
    let exitCode = 0;
    try {
      const res = await execFileAsync(
        veruleBin,
        ["check", "--observe", "detail", "--output", "json"],
        { cwd: hostDir, encoding: "utf8", maxBuffer: maxOutputBytes },
      );
      stdout = res.stdout;
      stderr = res.stderr;
    } catch (err: unknown) {
      const execErr = err as {
        readonly code?: number;
        readonly stdout?: string;
        readonly stderr?: string;
      };
      exitCode = execErr.code ?? 1;
      stdout = execErr.stdout ?? "";
      stderr = execErr.stderr ?? "";
    }

    assert.equal(exitCode, 1, `Expected exit 1 (findings), stderr: ${stderr}`);
    const parsed = JSON.parse(stdout) as {
      readonly kind: string;
      readonly variant: string;
      readonly data: {
        readonly status: string;
        readonly diagnostics: readonly {
          readonly ruleId: string;
          readonly message: string;
          readonly evidence: readonly {
            readonly at?: { readonly file: string };
          }[];
        }[];
        readonly gaps: readonly {
          readonly kind: string;
          readonly at?: { readonly file: string };
        }[];
        readonly observation: {
          readonly providers: readonly string[];
          readonly details: readonly {
            readonly kind: string;
            readonly ruleId?: string;
            readonly provider?: string;
            readonly cacheStatus?: string;
            readonly candidateCount?: number;
          }[];
        };
      };
    };

    assert.equal(parsed.kind, "data");
    assert.equal(parsed.variant, "findings");
    assert.equal(parsed.data.diagnostics.length, 1);
    assert.equal(
      parsed.data.diagnostics[0]!.message,
      "Required=[id,nullableKey], Output=[id,nullableKey,role]",
    );
    assert.ok(
      parsed.data.diagnostics[0]!.evidence.some(
        (ev) => ev.at?.file === "src/schema.ts",
      ),
    );
    assert.ok(
      parsed.data.gaps.some(
        (g) =>
          g.kind === "dynamic-schema-field" && g.at?.file === "src/schema.ts",
      ),
    );
    assert.ok(parsed.data.observation.providers.includes("zod"));
    const primaryQuery = parsed.data.observation.details.find(
      (d) =>
        d.kind === "query" &&
        d.ruleId === "check-zod-fields" &&
        d.provider === "zod",
    );
    const secondaryQuery = parsed.data.observation.details.find(
      (d) =>
        d.kind === "query" &&
        d.ruleId === "reuse-zod-fields" &&
        d.provider === "zod",
    );
    assert.equal(primaryQuery?.cacheStatus, "computed");
    assert.equal(primaryQuery?.candidateCount, 1);
    assert.equal(secondaryQuery?.cacheStatus, "reused");
    assert.equal(secondaryQuery?.candidateCount, 1);

    // Check package.json in isolated host did not list @verule/engine directly
    const hostManifest = JSON.parse(
      readFileSync(join(hostDir, "package.json"), "utf8"),
    ) as { readonly devDependencies: Record<string, string> };
    assert.equal("@verule/engine" in hostManifest.devDependencies, false);
  } finally {
    await registry.close().catch(() => {});
    bundle.dispose();
    rmSync(hostDir, { recursive: true, force: true });
  }
});
