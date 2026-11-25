import assert from "node:assert/strict";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { describe, it } from "node:test";

import { withTempHost } from "@verule/test-hosts";

import {
  prepareCliTempHost,
  resolveCliHostDir,
  spawnNdjsonProcess,
  withCliTempHost,
} from "../helpers/cli-hosts.ts";

void describe("@verule/cli-hosts", () => {
  void it("links workspace @boringparts/verule by default, supports custom sdkPackageDir and linkSdk=false, and cleans up on dispose", async () => {
    assert.throws(() => resolveCliHostDir("missing/host"), /does not exist/u);

    let capturedRoot = "";
    await withCliTempHost(
      {
        files: {
          "tsconfig.json": JSON.stringify({
            compilerOptions: {
              strict: true,
              target: "ES2022",
              module: "NodeNext",
              moduleResolution: "NodeNext",
            },
            include: ["src/**/*.ts"],
          }),
          "src/rule.ts": [
            'import { defineRule } from "@boringparts/verule";',
            "export const rule = defineRule({",
            '  id: "cli-hosts/sample",',
            "  run() {},",
            "});",
            "",
          ].join("\n"),
        },
      },
      async (host) => {
        capturedRoot = host.rootDir;
        const linkedSdkPath = host.resolvePath(
          "node_modules/@boringparts/verule",
        );
        assert.equal(existsSync(linkedSdkPath), true);
        assert.equal(lstatSync(linkedSdkPath).isSymbolicLink(), true);
        await host.typecheck();
      },
    );
    assert.equal(existsSync(capturedRoot), false);

    await withTempHost({}, async (customSdkHost) => {
      customSdkHost.writeText(
        "package.json",
        JSON.stringify({
          name: "@boringparts/verule",
          version: "0.0.0",
          type: "module",
          exports: { ".": { types: "./index.d.ts", default: "./index.js" } },
        }),
      );
      customSdkHost.writeText(
        "index.d.ts",
        "export declare const customSdkMarker: string;\n",
      );
      customSdkHost.writeText(
        "index.js",
        'export const customSdkMarker = "custom";\n',
      );

      await withCliTempHost(
        {
          sdkPackageDir: customSdkHost.rootDir,
          files: {
            "tsconfig.json": JSON.stringify({
              compilerOptions: {
                strict: true,
                target: "ES2022",
                module: "NodeNext",
                moduleResolution: "NodeNext",
              },
              include: ["src/**/*.ts"],
            }),
            "src/use-custom.ts":
              'import { customSdkMarker } from "@boringparts/verule";\nexport const marker: string = customSdkMarker;\n',
          },
        },
        async (host) => {
          const linkedPath = host.resolvePath(
            "node_modules/@boringparts/verule",
          );
          assert.equal(
            realpathSync(linkedPath),
            realpathSync(customSdkHost.rootDir),
          );
          await host.typecheck();
        },
      );
    });

    const unlinkedHost = await prepareCliTempHost({ linkSdk: false });
    try {
      assert.equal(
        existsSync(
          unlinkedHost.resolvePath("node_modules/@boringparts/verule"),
        ),
        false,
      );
    } finally {
      await unlinkedHost.dispose();
    }
  });

  void it("spawnNdjsonProcess resolves matching records and rejects immediately when child exits early", async () => {
    await withCliTempHost({ linkSdk: false }, async (host) => {
      host.writeText(
        "emit-and-exit.mjs",
        [
          'console.log(JSON.stringify({ kind: "stream" }));',
          'console.error("fatal startup error");',
          "process.exit(2);",
          "",
        ].join("\n"),
      );

      using session = spawnNdjsonProcess(
        host.resolvePath("emit-and-exit.mjs"),
        [],
        { cwd: host.rootDir, defaultTimeoutMs: 10_000 },
      );

      const streamRecord = await session.waitForRecord(
        (item) => item.kind === "stream",
      );
      assert.equal(streamRecord.kind, "stream");

      const start = Date.now();
      await assert.rejects(
        () => session.waitForRecord((item) => item.kind === "never-emitted"),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.match(error.message, /exited early \(code=2/u);
          assert.match(error.message, /fatal startup error/u);
          return true;
        },
      );
      assert.ok(
        Date.now() - start < 2_000,
        "Expected early exit to reject immediately without waiting for timeout",
      );
    });
  });
});
