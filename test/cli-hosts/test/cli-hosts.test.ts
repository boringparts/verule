import assert from "node:assert/strict";
import { existsSync, lstatSync, realpathSync } from "node:fs";
import { describe, it } from "node:test";

import {
  prepareCliTempHost,
  resolveCliHostDir,
  withCliTempHost,
} from "@verule/cli-hosts";
import { withTempHost } from "@verule/test-hosts";

void describe("@verule/cli-hosts", () => {
  void it("links workspace @verule/sdk by default, supports custom sdkPackageDir and linkSdk=false, and cleans up on dispose", async () => {
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
            'import { defineRule } from "@verule/sdk";',
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
        const linkedSdkPath = host.resolvePath("node_modules/@verule/sdk");
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
          name: "@verule/sdk",
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
              'import { customSdkMarker } from "@verule/sdk";\nexport const marker: string = customSdkMarker;\n',
          },
        },
        async (host) => {
          const linkedPath = host.resolvePath("node_modules/@verule/sdk");
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
        existsSync(unlinkedHost.resolvePath("node_modules/@verule/sdk")),
        false,
      );
    } finally {
      await unlinkedHost.dispose();
    }
  });
});
