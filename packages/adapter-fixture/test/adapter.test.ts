import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import {
  VeruleExecutionError,
  defineConfig,
  defineRule,
  openSession,
  type FactResult,
} from "@verule/sdk";

import {
  FixtureCallSourceFact,
  type FixtureCallSourceValue,
} from "../src/index.ts";

const fixtureRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function createProject(): string {
  const root = mkdtempSync(join(tmpdir(), "verule-native-adapter-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
      },
      include: ["src/**/*.ts"],
    }),
    "utf8",
  );
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(
    join(root, "src/app.ts"),
    "export function run() { return target(42); }\n",
    "utf8",
  );
  writeFileSync(join(root, "fixture.inputs.json"), "first-input", "utf8");
  return root;
}

function installTestPackage(
  root: string,
  packageName: string,
  adapterId: string,
  moduleSource: string,
  nativeFile: string,
): string {
  const packageRoot = join(root, "node_modules", ...packageName.split("/"));
  mkdirSync(join(packageRoot, "dist/native"), { recursive: true });
  writeFileSync(join(packageRoot, "dist/bridge.js"), moduleSource, "utf8");
  cpSync(nativeFile, join(packageRoot, "dist/native/adapter.so"));
  writeFileSync(
    join(packageRoot, "package.json"),
    JSON.stringify({
      name: packageName,
      type: "module",
      exports: {
        "./verule-adapter": "./dist/bridge.js",
        "./verule-native": "./dist/verule-native.json",
        "./native/linux-x64": "./dist/native/adapter.so",
      },
    }),
    "utf8",
  );
  writeFileSync(
    join(packageRoot, "dist/verule-native.json"),
    JSON.stringify({ id: adapterId, "linux-x64": "./native/linux-x64" }),
    "utf8",
  );
  return packageRoot;
}

void describe("independent native adapter package", () => {
  void it("loads the installed ESM export and library, reuses facts, tracks inputs, and refreshes on update", async () => {
    const root = createProject();
    let facts: readonly FactResult<"call", FixtureCallSourceValue>[] = [];
    const rule = defineRule({
      id: "fixture-native-fact",
      run: async (context) => {
        facts = await context.facts(FixtureCallSourceFact);
      },
    });
    let session: Awaited<ReturnType<typeof openSession>> | undefined;

    try {
      session = await openSession({
        cwd: root,
        adapterResolutionRoot: fixtureRoot,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: ["@verule/adapter-fixture"],
          rules: [rule],
        }),
      });
      const report = await session.check();
      assert.equal(report.status, "clean");
      assert.equal(facts.length, 1);
      assert.deepEqual(facts[0]?.value, {
        text: "target(42)",
        input: "first-input",
        invocation: 1,
      });
      assert.equal(facts[0]?.evidence[0]?.at?.file, "src/app.ts");
      assert.equal(report.additionalInputs.length, 1);
      assert.equal(report.additionalInputs[0]?.file, "fixture.inputs.json");
      assert.deepEqual(report.additionalInputs[0]?.sources, [
        { kind: "adapter", id: "third-party-fixture" },
      ]);

      writeFileSync(join(root, "fixture.inputs.json"), "second-input", "utf8");
      writeFileSync(
        join(root, "src/app.ts"),
        "export function run() { return target(43); }\n",
        "utf8",
      );
      await session.update({ changed: ["src/app.ts"] });
      facts = [];
      const refreshedReport = await session.check();
      assert.equal(refreshedReport.status, "clean");
      assert.equal(facts.length, 1);
      assert.deepEqual(facts[0]?.value, {
        text: "target(43)",
        input: "second-input",
        invocation: 2,
      });
      assert.equal(facts[0]?.evidence[0]?.at?.file, "src/app.ts");
      assert.equal(facts[0]?.evidence[0]?.at?.line, 1);
      assert.equal(facts[0]?.evidence[0]?.at?.column, 32);
      assert.equal(refreshedReport.additionalInputs.length, 1);
      assert.equal(
        refreshedReport.additionalInputs[0]?.file,
        "fixture.inputs.json",
      );
      assert.deepEqual(refreshedReport.additionalInputs[0]?.sources, [
        { kind: "adapter", id: "third-party-fixture" },
      ]);
    } finally {
      await session?.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("reports configured package names for invalid bridges and ABI mismatches", async () => {
    const root = createProject();
    const goodLibrary = join(
      fixtureRoot,
      "dist/native/libverule_test_adapter.so",
    );
    const badAbiLibrary = join(
      fixtureRoot,
      "native/target/release/libverule_bad_abi.so",
    );
    const invalidBridgeName = "fixture-invalid-bridge";
    const abiMismatchName = "fixture-abi-mismatch";
    try {
      installTestPackage(
        root,
        invalidBridgeName,
        "invalid-bridge",
        `export default { id: "invalid-bridge", provides: [{ factType: {}, extract() {} }] };`,
        goodLibrary,
      );
      const abiPackagePath = installTestPackage(
        root,
        abiMismatchName,
        "abi-mismatch",
        `export default { id: "abi-mismatch", provides: [{ factType: { id: "fixture.call-source" }, extract() { return []; } }] };`,
        badAbiLibrary,
      );

      const configFor = (packageName: string) =>
        defineConfig({ tsconfig: "tsconfig.json", adapters: [packageName] });
      await assert.rejects(
        openSession({
          cwd: root,
          adapterResolutionRoot: root,
          config: configFor(invalidBridgeName),
        }),
        (error: unknown) =>
          error instanceof VeruleExecutionError &&
          error.message.includes(invalidBridgeName) &&
          error.message.includes("invalid JavaScript adapter bridge"),
      );

      await assert.rejects(
        openSession({
          cwd: root,
          adapterResolutionRoot: root,
          config: configFor(abiMismatchName),
        }),
        (error: unknown) =>
          error instanceof VeruleExecutionError &&
          error.code === "NATIVE_ADAPTER_LOAD" &&
          error.message.includes(abiMismatchName) &&
          error.message.includes("adapter ABI version 2 is unsupported") &&
          error.message.includes(
            resolve(abiPackagePath, "dist/native/adapter.so"),
          ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
