import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };

async function captureCli(argv: readonly string[], cwd?: string) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    argv: ["node", "verule", ...argv],
    ...(cwd !== undefined ? { cwd } : {}),
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

function createCliTempProject(
  configSource: string,
  tsconfigText?: string,
): string {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-int-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "tsconfig.json"),
    tsconfigText ??
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
    join(root, "src", "index.ts"),
    [
      "function sink(value: string | number): string {",
      "  return String(value);",
      "}",
      "export function demo(input: string | number): string {",
      '  if (typeof input === "string") {',
      "    return sink(input);",
      "  }",
      "  return sink(input);",
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(join(root, "verule.config.mjs"), configSource, "utf8");
  return root;
}

void test("treats a closed stdout pipe as a normal exit", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity,
    argv: ["node", "verule", "--version"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw Object.assign(new Error("closed"), { code: "EPIPE" });
    },
  });
  assert.equal(status, 0);
  assert.deepEqual(destinations, ["stdout"]);
});

void test("returns an execution failure even when its diagnostic cannot be written", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity,
    argv: ["node", "verule", "--version"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw new Error("write failed");
    },
  });
  assert.equal(status, 2);
  assert.deepEqual(destinations, ["stdout", "stderr"]);
});

void test("does not retry a failed stderr write", async () => {
  const destinations: string[] = [];
  const status = await runCli({
    identity,
    argv: ["node", "verule", "--unknown"],
    write: ({ destination }) => {
      destinations.push(destination);
      throw Object.assign(new Error("closed"), { code: "EPIPE" });
    },
  });
  assert.equal(status, 2);
  assert.deepEqual(destinations, ["stderr"]);
});

void test("preserves bare command, --version, --help, --schema, and --unknown", async () => {
  const bare = await captureCli([]);
  assert.equal(bare.status, 0, bare.stderr);
  assert.match(bare.stdout, /^verule 0\.0\.0 \(engine \d+\.\d+\.\d+\)\n$/u);

  const version = await captureCli(["--version"]);
  assert.equal(version.status, 0, version.stderr);
  assert.equal(version.stdout, "verule 0.0.0\n");

  const help = await captureCli(["--help"]);
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /check/u);
  assert.match(help.stdout, /watch/u);
  assert.match(help.stdout, /--schema/u);

  const schema = await captureCli(["--schema"]);
  assert.equal(schema.status, 0, schema.stderr);
  assert.partialDeepStrictEqual(JSON.parse(schema.stdout), {
    kind: "directory",
    command: "verule",
  });

  const unknown = await captureCli(["--unknown"]);
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, "");
  assert.match(unknown.stderr, /--unknown/u);
});

void test("check exits 0 with default zero rules in text and json modes", async () => {
  const root = createCliTempProject(
    'export default { tsconfig: "tsconfig.json" };\n',
  );
  try {
    const textResult = await captureCli(["check"], root);
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.equal(textResult.stderr, "");
    assert.match(textResult.stdout, /No violations found/u);

    const jsonResult = await captureCli(["check", "--output", "json"], root);
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.equal(jsonResult.stderr, "");
    const envelope = JSON.parse(jsonResult.stdout) as {
      kind: string;
      variant: string;
      data: { reportVersion: string; status: string; diagnostics: unknown[] };
    };
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "clean");
    assert.equal(envelope.data.reportVersion, "1");
    assert.equal(envelope.data.status, "clean");
    assert.deepEqual(envelope.data.diagnostics, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

void test("check exits 1 when rules report violations and distinguishes failures with exit 2", async () => {
  const findingsRoot = createCliTempProject(`
    export default {
      tsconfig: "tsconfig.json",
      rules: [
        {
          id: "no-narrowed-string",
          run: async (ctx) => {
            const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
            const sinks = calls.filter((c) => c.text.startsWith("sink("));
            const args = sinks.map((c) => c.arguments?.[0]).filter(Boolean);
            const types = await ctx.typeAt(args);
            for (const [i, ty] of types.entries()) {
              if (ty.typeText === "string") {
                ctx.report({
                  at: sinks[i].location,
                  message: "Disallowed string call",
                  basis: [{ kind: "type", message: "Argument narrowed to string" }],
                });
              }
            }
          },
        },
      ],
    };
  `);
  try {
    const textFindings = await captureCli(["check"], findingsRoot);
    assert.equal(textFindings.status, 1);
    assert.match(textFindings.stdout, /no-narrowed-string/u);
    assert.match(textFindings.stdout, /src\/index\.ts:6:12/u);

    const jsonFindings = await captureCli(
      ["check", "--output", "json"],
      findingsRoot,
    );
    assert.equal(jsonFindings.status, 1);
    const envelope = JSON.parse(jsonFindings.stdout) as {
      kind: string;
      variant: string;
      data: { status: string; diagnostics: { ruleId: string }[] };
    };
    assert.equal(envelope.kind, "data");
    assert.equal(envelope.variant, "findings");
    assert.equal(envelope.data.status, "findings");
    assert.equal(envelope.data.diagnostics.length, 1);
  } finally {
    rmSync(findingsRoot, { recursive: true, force: true });
  }

  // Missing config -> exit 2
  const emptyRoot = mkdtempSync(join(tmpdir(), "verule-cli-missing-"));
  try {
    const missingText = await captureCli(["check"], emptyRoot);
    assert.equal(missingText.status, 2);
    assert.match(missingText.stderr, /Check failed/u);

    const missingJson = await captureCli(
      ["check", "--output", "json"],
      emptyRoot,
    );
    assert.equal(missingJson.status, 2);
    const errEnvelope = JSON.parse(missingJson.stderr) as {
      kind: string;
      variant: string;
      data: { reportVersion: string; code: string; message: string };
    };
    assert.equal(errEnvelope.kind, "failure");
    assert.equal(errEnvelope.variant, "failed");
    assert.equal(errEnvelope.data.reportVersion, "1");
    assert.equal(errEnvelope.data.code, "INVALID_CONFIG");
  } finally {
    rmSync(emptyRoot, { recursive: true, force: true });
  }

  // Throwing rule -> exit 2
  const throwingRoot = createCliTempProject(`
    export default {
      tsconfig: "tsconfig.json",
      rules: [
        {
          id: "throwing-rule",
          run: () => {
            throw new Error("boom");
          },
        },
      ],
    };
  `);
  try {
    const failJson = await captureCli(
      ["check", "--output", "json"],
      throwingRoot,
    );
    assert.equal(failJson.status, 2);
    const errEnvelope = JSON.parse(failJson.stderr) as {
      kind: string;
      variant: string;
      data: { code: string; message: string };
    };
    assert.equal(errEnvelope.kind, "failure");
    assert.equal(errEnvelope.variant, "failed");
    assert.equal(errEnvelope.data.code, "RULE_EXECUTION_ERROR");
  } finally {
    rmSync(throwingRoot, { recursive: true, force: true });
  }
});

void test("check reports multi-project scope, entry chains, divergent types, and merged diagnostics in text and json modes", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-multiproj-"));
  try {
    mkdirSync(join(root, "packages/shared"), { recursive: true });
    mkdirSync(join(root, "packages/web/src"), { recursive: true });
    mkdirSync(join(root, "packages/node/src"), { recursive: true });

    writeFileSync(
      join(root, "packages/shared/shared.ts"),
      [
        'import { mode } from "@runtime";',
        "function sink(v: string): string { return v; }",
        "export const out = sink(mode);",
        "",
      ].join("\n"),
      "utf8",
    );
    writeFileSync(
      join(root, "packages/web/src/web.ts"),
      'export const mode = "web" as const;\n',
      "utf8",
    );
    writeFileSync(
      join(root, "packages/node/src/node.ts"),
      'export const mode = "node" as const;\n',
      "utf8",
    );
    writeFileSync(
      join(root, "packages/web/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@runtime": ["./src/web.ts"] },
        },
        include: ["src/**/*.ts", "../shared/shared.ts"],
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "packages/node/tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          strict: false,
          allowJs: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          baseUrl: ".",
          paths: { "@runtime": ["./src/node.ts"] },
        },
        include: ["src/**/*.ts", "../shared/shared.ts"],
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({
        files: [],
        references: [{ path: "./packages/web" }, { path: "./packages/node" }],
      }),
      "utf8",
    );
    writeFileSync(
      join(root, "verule.config.mjs"),
      [
        "export default {",
        '  tsconfig: "tsconfig.json",',
        "  rules: [",
        "    {",
        '      id: "runtime-check",',
        "      run: async (ctx) => {",
        '        const calls = await ctx.findSyntax({ files: ["packages/shared/shared.ts"], kinds: ["CallExpression"] });',
        '        const sinks = calls.filter((c) => c.text.startsWith("sink("));',
        "        for (const call of sinks) {",
        "          const arg = call.arguments?.[0];",
        "          if (!arg) continue;",
        "          const [ty] = await ctx.typeAt([arg]);",
        "          if (!ty) continue;",
        "          ctx.report({",
        "            at: call.location,",
        "            message: `Runtime resolved to ${ty.typeText}`,",
        '            findingKey: "runtime-divergent",',
        '            basis: [{ kind: "type", message: `type=${ty.typeText}`, at: call.location }],',
        "          });",
        "          ctx.report({",
        "            at: call.location,",
        '            message: "Shared sink call",',
        '            findingKey: "shared-sink",',
        '            basis: [{ kind: "source", message: "Shared call site", at: call.location }],',
        "          });",
        "        }",
        "      },",
        "    },",
        "  ],",
        "};",
        "",
      ].join("\n"),
      "utf8",
    );

    const textResult = await captureCli(["check"], root);
    assert.equal(textResult.status, 1);
    assert.match(
      textResult.stdout,
      /tsconfig\.json -> packages\/web\/tsconfig\.json/u,
    );
    assert.match(
      textResult.stdout,
      /tsconfig\.json -> packages\/node\/tsconfig\.json/u,
    );
    assert.match(
      textResult.stdout,
      /packages\/shared\/shared\.ts <- .*packages\/node\/tsconfig\.json.*packages\/web\/tsconfig\.json/u,
    );
    assert.match(
      textResult.stdout,
      /\[projects: packages\/node\/tsconfig\.json, packages\/web\/tsconfig\.json\]/u,
    );

    const jsonResult = await captureCli(["check", "--output", "json"], root);
    assert.equal(jsonResult.status, 1);
    const envelope = JSON.parse(jsonResult.stdout) as {
      kind: string;
      variant: string;
      data: {
        projects: {
          configFile: string;
          entryConfig: string;
          entryChain: string[];
          compilerOptions: { strict: boolean; allowJs: boolean };
        }[];
        fileOrigins: {
          file: string;
          projects: { projectId: string; entryChain: string[] }[];
        }[];
        diagnostics: { message: string; projects: string[] }[];
      };
    };

    assert.equal(envelope.data.projects.length, 3);
    const webMeta = envelope.data.projects.find(
      (p) => p.configFile === "packages/web/tsconfig.json",
    );
    assert.deepEqual(webMeta?.entryChain, [
      "tsconfig.json",
      "packages/web/tsconfig.json",
    ]);
    assert.equal(webMeta?.compilerOptions.strict, true);

    const sharedOrigin = envelope.data.fileOrigins.find(
      (o) => o.file === "packages/shared/shared.ts",
    );
    assert.deepEqual(
      sharedOrigin?.projects.map((p) => p.projectId),
      ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
    );

    assert.equal(envelope.data.diagnostics.length, 3);
    assert.deepEqual(
      envelope.data.diagnostics.find((d) => d.message === "Shared sink call")
        ?.projects,
      ["packages/node/tsconfig.json", "packages/web/tsconfig.json"],
    );
    assert.deepEqual(
      envelope.data.diagnostics.find((d) => d.message.includes('"web"'))
        ?.projects,
      ["packages/web/tsconfig.json"],
    );
    assert.deepEqual(
      envelope.data.diagnostics.find((d) => d.message.includes('"node"'))
        ?.projects,
      ["packages/node/tsconfig.json"],
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
