import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { runCli } from "../../src/main.ts";

const identity = { commandName: "verule", version: "0.0.0" };

type StreamRecord =
  | {
      readonly kind: "stream";
      readonly command: string;
      readonly outputMode: string;
    }
  | {
      readonly kind: "record";
      readonly variant: "ready";
      readonly data: {
        readonly endpoint: string;
        readonly snapshotId: number;
      };
    }
  | {
      readonly kind: "record";
      readonly variant: "report";
      readonly data: CheckData & {
        readonly sequence: number;
        readonly trigger: "initial" | "change";
        readonly recomputation: {
          readonly recomputedProjects: readonly string[];
          readonly reusedProjects: readonly string[];
          readonly invalidatedBy: readonly string[];
        };
      };
    }
  | {
      readonly kind: "record";
      readonly variant: "failed";
      readonly data: {
        readonly sequence: number;
        readonly code: string;
        readonly message: string;
      };
    }
  | {
      readonly kind: "streamSuccess";
    };

type CheckData = {
  readonly reportVersion: string;
  readonly status: "clean" | "findings";
  readonly projects: readonly {
    readonly projectId: string;
    readonly sourceFiles: readonly string[];
  }[];
  readonly fileOrigins: readonly {
    readonly file: string;
  }[];
  readonly additionalInputs: readonly {
    readonly file: string;
    readonly exists: boolean;
    readonly digest?: string;
    readonly sources: readonly (
      | { readonly kind: "config" }
      | { readonly kind: "rule"; readonly id: string }
      | { readonly kind: "adapter"; readonly id: string }
    )[];
  }[];
  readonly diagnostics: readonly {
    readonly id: string;
    readonly ruleId: string;
    readonly at: { readonly file: string; readonly line: number };
    readonly message: string;
    readonly evidence: readonly unknown[];
    readonly projects: readonly string[];
  }[];
  readonly gaps: readonly unknown[];
  readonly identity: unknown;
};

async function runCliJson(cwd: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    cwd,
    argv: ["node", "verule", ...args],
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  const raw = status === 2 ? stderr : stdout;
  return {
    status,
    stdout,
    stderr,
    envelope: JSON.parse(raw) as {
      readonly kind: "data" | "failure";
      readonly variant: string;
      readonly data: CheckData;
    },
  };
}

async function runCliText(cwd: string, args: readonly string[]) {
  let stdout = "";
  let stderr = "";
  const status = await runCli({
    identity,
    cwd,
    argv: ["node", "verule", ...args],
    write: ({ destination, chunk }) => {
      if (destination === "stdout") stdout += chunk;
      else stderr += chunk;
    },
  });
  return { status, stdout, stderr };
}

function createTsConfig(include: readonly string[]): string {
  return JSON.stringify(
    {
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include,
    },
    null,
    2,
  );
}

void test("verule session, check --session, and watch update diagnostics immediately when only allowed-packages.json changes", async () => {
  const root = mkdtempSync(join(tmpdir(), "verule-cli-add-inputs-"));
  const socketDir = mkdtempSync(join(tmpdir(), "verule-cli-add-sock-"));
  const socketPath = join(socketDir, "shared.sock");
  mkdirSync(join(root, "src"), { recursive: true });

  const tsconfigPath = join(root, "tsconfig.json");
  const appPath = join(root, "src", "app.ts");
  const allowlistPath = join(root, "allowed-packages.json");
  const configPath = join(root, "verule.config.mjs");

  writeFileSync(tsconfigPath, createTsConfig(["src/**/*.ts"]), "utf8");
  writeFileSync(
    appPath,
    [
      "declare function usePackage(name: string): void;",
      "export function boot(): void {",
      '  usePackage("zod");',
      "}",
      "",
    ].join("\n"),
    "utf8",
  );
  writeFileSync(
    allowlistPath,
    JSON.stringify({ allowed: ["zod"] }, null, 2),
    "utf8",
  );
  writeFileSync(
    configPath,
    [
      `const absAllowlist = ${JSON.stringify(allowlistPath)};`,
      "export default {",
      '  tsconfig: "tsconfig.json",',
      '  additionalInputs: ["./allowed-packages.json"],',
      "  rules: [",
      "    {",
      '      id: "allowed-package-check",',
      "      run: async (ctx) => {",
      '        const raw = ctx.readAdditionalInput("allowed-packages.json");',
      "        const manifest = JSON.parse(raw);",
      '        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });',
      "        for (const call of calls) {",
      '          if (!call.text.startsWith("usePackage(")) continue;',
      '          const match = /usePackage\\("([^"]+)"\\)/u.exec(call.text);',
      "          const pkg = match?.[1];",
      "          if (pkg && !manifest.allowed.includes(pkg)) {",
      "            ctx.report({",
      "              at: call.location,",
      '              message: `Disallowed package "${pkg}"`,',
      "              findingKey: `pkg:${pkg}`,",
      "              evidence: [{ kind: 'source', message: `Used ${pkg}`, at: call.location }],",
      "            });",
      "          }",
      "        }",
      "      },",
      "    },",
      "    {",
      '      id: "allowed-package-auditor",',
      "      run: (ctx) => {",
      "        ctx.registerAdditionalInput(absAllowlist);",
      "      },",
      "    },",
      "  ],",
      "};",
      "",
    ].join("\n"),
    "utf8",
  );

  function createStreamHarness() {
    const records: StreamRecord[] = [];
    let buffer = "";
    let stderr = "";
    let waiters: (() => void)[] = [];

    return {
      records,
      getStderr: () => stderr,
      write: ({
        destination,
        chunk,
      }: {
        readonly destination: "stdout" | "stderr";
        readonly chunk: string;
      }) => {
        if (destination === "stderr") {
          stderr += chunk;
          return;
        }
        buffer += chunk;
        while (true) {
          const idx = buffer.indexOf("\n");
          if (idx === -1) break;
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 1);
          if (raw.length > 0) {
            records.push(JSON.parse(raw) as StreamRecord);
            const pending = waiters;
            waiters = [];
            for (const wake of pending) wake();
          }
        }
      },
      waitFor: async (
        predicate: (record: StreamRecord) => boolean,
      ): Promise<StreamRecord> => {
        const deadline = Date.now() + 10_000;
        let cursor = 0;
        while (true) {
          while (cursor < records.length) {
            const item = records[cursor]!;
            cursor += 1;
            if (predicate(item)) return item;
          }
          if (Date.now() >= deadline) {
            throw new Error(
              `Timed out waiting for stream record. Records=${JSON.stringify(records)} stderr=${stderr}`,
            );
          }
          await new Promise<void>((resolveWait) => {
            const timer = setTimeout(resolveWait, 50);
            waiters.push(() => {
              clearTimeout(timer);
              resolveWait();
            });
          });
        }
      },
    };
  }

  async function queryAndCompare(expectedStatus: 0 | 1) {
    const sharedRes = await runCliJson(tmpdir(), [
      "check",
      "--session",
      socketPath,
      "--output",
      "json",
    ]);
    assert.equal(sharedRes.status, expectedStatus, sharedRes.stderr);
    assert.equal(sharedRes.envelope.kind, "data");

    const coldRes = await runCliJson(root, [
      "check",
      "--config",
      configPath,
      "--output",
      "json",
    ]);
    assert.equal(coldRes.status, expectedStatus, coldRes.stderr);
    assert.equal(coldRes.envelope.kind, "data");

    assert.deepEqual(sharedRes.envelope.data, coldRes.envelope.data);
    assert.deepEqual(sharedRes.envelope.data.projects[0]?.sourceFiles, [
      "src/app.ts",
    ]);
    assert.deepEqual(
      sharedRes.envelope.data.fileOrigins.map((o) => o.file),
      ["src/app.ts"],
    );
    assert.equal(sharedRes.envelope.data.additionalInputs.length, 1);
    assert.equal(
      sharedRes.envelope.data.additionalInputs[0]?.file,
      "allowed-packages.json",
    );
    assert.deepEqual(sharedRes.envelope.data.additionalInputs[0]?.sources, [
      { kind: "config" },
      { kind: "rule", id: "allowed-package-auditor" },
      { kind: "rule", id: "allowed-package-check" },
    ]);
    return sharedRes.envelope.data;
  }

  const sessionAbort = new AbortController();
  const watchAbort = new AbortController();
  try {
    // 1. Start explicit shared session
    const sessionHarness = createStreamHarness();
    const sessionPromise = runCli({
      identity,
      cwd: root,
      argv: [
        "node",
        "verule",
        "session",
        "--config",
        configPath,
        "--socket",
        socketPath,
        "--output",
        "ndjson",
      ],
      signal: sessionAbort.signal,
      write: sessionHarness.write,
    });

    await sessionHarness.waitFor(
      (r) => r.kind === "record" && r.variant === "ready",
    );
    assert.equal(existsSync(socketPath), true);

    // 2. Initial clean state
    await queryAndCompare(0);

    // Text output displays merged additional input and all sources
    const textCheck = await runCliText(tmpdir(), [
      "check",
      "--session",
      socketPath,
    ]);
    assert.equal(textCheck.status, 0, textCheck.stderr);
    assert.match(textCheck.stdout, /Additional inputs \(1\):/u);
    assert.match(
      textCheck.stdout,
      /allowed-packages\.json <- config, rule:allowed-package-auditor, rule:allowed-package-check/u,
    );

    // 3. Edit ONLY allowed-packages.json -> immediate query -> exit 1
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["lodash"] }, null, 2),
      "utf8",
    );
    const findingsReport = await queryAndCompare(1);
    assert.equal(findingsReport.diagnostics.length, 1);
    assert.equal(findingsReport.diagnostics[0]?.at.file, "src/app.ts");
    assert.equal(findingsReport.diagnostics[0]?.at.line, 3);

    // 4. Restore ONLY allowed-packages.json -> immediate query -> exit 0 (retracted)
    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["zod"] }, null, 2),
      "utf8",
    );
    const cleanReport = await queryAndCompare(0);
    assert.equal(cleanReport.diagnostics.length, 0);

    sessionAbort.abort();
    const sessionCode = await sessionPromise;
    assert.equal(sessionCode, 0, sessionHarness.getStderr());
    assert.equal(existsSync(socketPath), false);

    // 5. Verify verule watch pushes updated complete reports on manifest edits
    const watchHarness = createStreamHarness();
    const watchPromise = runCli({
      identity,
      cwd: root,
      argv: [
        "node",
        "verule",
        "watch",
        "--config",
        configPath,
        "--output",
        "ndjson",
      ],
      signal: watchAbort.signal,
      write: watchHarness.write,
    });

    const w1 = await watchHarness.waitFor(
      (r) =>
        r.kind === "record" && r.variant === "report" && r.data.sequence === 1,
    );
    assert.equal(w1.kind, "record");
    assert.equal(w1.variant, "report");
    assert.equal(w1.data.status, "clean");

    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["lodash"] }, null, 2),
      "utf8",
    );
    const w2 = await watchHarness.waitFor(
      (r) =>
        r.kind === "record" && r.variant === "report" && r.data.sequence === 2,
    );
    assert.equal(w2.kind, "record");
    assert.equal(w2.variant, "report");
    assert.equal(w2.data.status, "findings");
    assert.deepEqual(w2.data.diagnostics, findingsReport.diagnostics);
    assert.deepEqual(w2.data.projects[0]?.sourceFiles, ["src/app.ts"]);

    writeFileSync(
      allowlistPath,
      JSON.stringify({ allowed: ["zod"] }, null, 2),
      "utf8",
    );
    const w3 = await watchHarness.waitFor(
      (r) =>
        r.kind === "record" && r.variant === "report" && r.data.sequence === 3,
    );
    assert.equal(w3.kind, "record");
    assert.equal(w3.variant, "report");
    assert.equal(w3.data.status, "clean");
    assert.deepEqual(w3.data.diagnostics, []);

    watchAbort.abort();
    const watchCode = await watchPromise;
    assert.equal(watchCode, 0, watchHarness.getStderr());
  } finally {
    sessionAbort.abort();
    watchAbort.abort();
    rmSync(root, { recursive: true, force: true });
    rmSync(socketDir, { recursive: true, force: true });
  }
});
