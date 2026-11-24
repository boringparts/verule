import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  defineConfig,
  defineRule,
  resolveRetainedObjectFields,
  runCheck,
  type ObjectFieldShape,
  type ValuePropagationPath,
} from "@verule/sdk";

function createTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-row-field-prop-"));
  writeFileSync(
    join(root, "tsconfig.json"),
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
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

void describe("@verule/sdk structured member & rest-destructuring propagation", () => {
  void it("tracks sourcePath, omittedProperties, destructuring step provenance, and wrapper composition independently of step.description", async () => {
    const root = createTempProject({
      "src/app.ts": [
        "interface Owner { id: number; email: string }",
        "interface Workspace { id: number; plan: string; owner: Owner }",
        "interface PageRow { id: number; slug: string; customDomain: string | null; workspace: Workspace }",
        "declare function fetchPage(): PageRow;",
        "declare function sink(tag: string, value: unknown): void;",
        "",
        "export function run(): void {",
        "  const page = fetchPage();",
        '  sink("direct", page);',
        '  sink("dotProp", page.workspace);',
        '  sink("bracketProp", page["workspace"]);',
        "  const { workspace } = page;",
        '  sink("destructuredSame", workspace);',
        "  const { workspace: ws } = page;",
        '  sink("destructuredAlias", ws);',
        '  sink("nestedOwner", ws.owner);',
        "  const { slug, ...rest1 } = page;",
        '  sink("rest1", rest1);',
        "  const { customDomain, ...rest2 } = rest1;",
        '  sink("rest2", rest2);',
        '  sink("omittedSlugAccess", rest1.slug);',
        '  sink("survivingWsAccess", rest1.workspace);',
        "  const { plan, ...wsRest } = page.workspace;",
        '  sink("nestedRest", wsRest);',
        "  const wrapped = { w: page.workspace };",
        '  sink("wrappedMember", wrapped.w);',
        "  void slug;",
        "  void customDomain;",
        "  void plan;",
        "}",
        "",
      ].join("\n"),
    });

    const observedByTag = new Map<
      string,
      {
        readonly reachable: boolean;
        readonly path?: ValuePropagationPath;
      }
    >();
    const defaultModeReachable = new Map<string, boolean>();
    let rest1StepLine: number | undefined;
    let destructuredAliasStepLine: number | undefined;

    try {
      const rule = defineRule({
        id: "inspect-row-field-propagation",
        run: async (ctx) => {
          const calls = await ctx.findSyntax({
            files: ["src/app.ts"],
            kinds: ["CallExpression"],
          });
          const fetchCall = calls.find((c) => c.text.startsWith("fetchPage("));
          assert.ok(fetchCall);
          const sinkCalls = calls.filter((c) => c.text.startsWith("sink("));
          const resolvedSinks = await ctx.resolveCalls(
            sinkCalls.map((c) => c.ref),
            { select: { location: true, arguments: true } },
          );

          const tagAndArg: {
            readonly tag: string;
            readonly argRef: NonNullable<
              NonNullable<(typeof resolvedSinks)[number]["arguments"]>[number]
            >;
            readonly callLoc: NonNullable<
              (typeof resolvedSinks)[number]["location"]
            >;
          }[] = [];

          const tagRefs = resolvedSinks.map((r) => r.arguments![0]!);
          const tagTexts = await ctx.syntaxOf(tagRefs, {
            select: { text: true },
          });
          for (const [idx, row] of resolvedSinks.entries()) {
            const rawTag = tagTexts[idx]?.text ?? "";
            const tag = rawTag.replaceAll('"', "");
            const argRef = row.arguments?.[1];
            const callLoc = row.location;
            assert.ok(argRef && callLoc);
            tagAndArg.push({ tag, argRef, callLoc });
          }

          const withMembers = await ctx.valuePropagation({
            propagation: "value",
            includeMemberAccess: true,
            from: fetchCall.ref,
            to: tagAndArg.map((entry) => entry.argRef),
          });
          const defaultOnly = await ctx.valuePropagation({
            propagation: "value",
            from: fetchCall.ref,
            to: tagAndArg.map((entry) => entry.argRef),
          });

          for (const [idx, entry] of tagAndArg.entries()) {
            const res = withMembers.results[idx]!;
            const path = res.paths[0];
            observedByTag.set(
              entry.tag,
              path
                ? { reachable: res.reachable, path }
                : { reachable: res.reachable },
            );
            defaultModeReachable.set(
              entry.tag,
              defaultOnly.results[idx]!.reachable,
            );
          }

          const rest1Path = observedByTag.get("rest1")?.path;
          assert.ok(rest1Path);
          rest1StepLine = rest1Path.steps.find(
            (s) =>
              s.kind === "restDestructure" && s.omittedProperties !== undefined,
          )?.toLocation.line;

          const aliasPath = observedByTag.get("destructuredAlias")?.path;
          assert.ok(aliasPath);
          destructuredAliasStepLine = aliasPath.steps.find(
            (s) => s.kind === "destructure",
          )?.toLocation.line;

          // Emit diagnostic using rest1Path as basis to verify destructuring site provenance.
          const rest1Sink = tagAndArg.find((e) => e.tag === "rest1")!;
          ctx.report({
            at: rest1Sink.callLoc,
            message: "Rest-destructured row inspected.",
            basis: [rest1Path],
          });
        },
      });

      const report = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          rules: [rule],
        }),
      });

      assert.equal(observedByTag.get("direct")?.reachable, true);
      assert.deepEqual(observedByTag.get("direct")?.path?.sourcePath, []);
      assert.deepEqual(
        observedByTag.get("direct")?.path?.omittedProperties,
        [],
      );

      for (const memberTag of [
        "dotProp",
        "bracketProp",
        "destructuredSame",
        "destructuredAlias",
        "survivingWsAccess",
        "wrappedMember",
      ]) {
        const obs = observedByTag.get(memberTag);
        assert.equal(obs?.reachable, true, `Expected ${memberTag} reachable`);
        assert.deepEqual(
          obs?.path?.sourcePath,
          ["workspace"],
          `Unexpected sourcePath for ${memberTag}`,
        );
        assert.deepEqual(
          obs?.path?.omittedProperties,
          [],
          `Unexpected omittedProperties for ${memberTag}`,
        );
      }

      assert.equal(observedByTag.get("nestedOwner")?.reachable, true);
      assert.deepEqual(observedByTag.get("nestedOwner")?.path?.sourcePath, [
        "workspace",
        "owner",
      ]);
      assert.deepEqual(
        observedByTag.get("nestedOwner")?.path?.omittedProperties,
        [],
      );

      assert.equal(observedByTag.get("rest1")?.reachable, true);
      assert.deepEqual(observedByTag.get("rest1")?.path?.sourcePath, []);
      assert.deepEqual(observedByTag.get("rest1")?.path?.omittedProperties, [
        "slug",
      ]);
      assert.equal(rest1StepLine, 17);

      assert.equal(destructuredAliasStepLine, 14);
      const aliasDestructureStep = observedByTag
        .get("destructuredAlias")
        ?.path?.steps.find((s) => s.kind === "destructure");
      assert.equal(aliasDestructureStep?.property, "workspace");

      assert.equal(observedByTag.get("rest2")?.reachable, true);
      assert.deepEqual(observedByTag.get("rest2")?.path?.sourcePath, []);
      assert.deepEqual(observedByTag.get("rest2")?.path?.omittedProperties, [
        "customDomain",
        "slug",
      ]);

      // Rest-omitted property `rest1.slug` MUST NOT propagate!
      assert.equal(observedByTag.get("omittedSlugAccess")?.reachable, false);

      // Nested member + rest destructuring: `sourcePath: ["workspace"]`, `omittedProperties: ["plan"]`.
      assert.equal(observedByTag.get("nestedRest")?.reachable, true);
      assert.deepEqual(observedByTag.get("nestedRest")?.path?.sourcePath, [
        "workspace",
      ]);
      assert.deepEqual(
        observedByTag.get("nestedRest")?.path?.omittedProperties,
        ["plan"],
      );

      // Default propagation mode ("value" without includeMemberAccess) keeps whole-value reachability
      // while still reporting omittedProperties on rest-destructured whole objects.
      assert.equal(defaultModeReachable.get("direct"), true);
      assert.equal(defaultModeReachable.get("rest1"), true);
      assert.equal(defaultModeReachable.get("dotProp"), false);
      assert.equal(defaultModeReachable.get("destructuredAlias"), false);

      // Diagnostic basis from rest1Path includes the destructuring site at line 17.
      assert.equal(report.diagnostics.length, 1);
      assert.ok(
        report.diagnostics[0]!.evidence.some(
          (ev) => ev.at?.file === "src/app.ts" && ev.at.line === 17,
        ),
        JSON.stringify(report.diagnostics[0]!.evidence),
      );

      // Explicit proof: mutating/ignoring step.description prose does NOT affect structured field retention.
      const rowShape: ObjectFieldShape = {
        fields: ["id", "slug", "customDomain", "workspace"],
        hasDynamicFields: false,
        nested: {
          workspace: {
            fields: ["id", "plan", "owner"],
            hasDynamicFields: false,
            nested: {
              owner: {
                fields: ["id", "email"],
                hasDynamicFields: false,
              },
            },
          },
        },
      };

      const mutateDescriptions = (
        path: ValuePropagationPath,
      ): ValuePropagationPath => ({
        ...path,
        steps: path.steps.map((step) => ({
          ...step,
          description: "mutated debug prose without omitting info",
        })),
      });

      const rest2Retained = resolveRetainedObjectFields(
        rowShape,
        mutateDescriptions(observedByTag.get("rest2")!.path!),
      );
      assert.deepEqual(rest2Retained, {
        fields: ["id", "workspace"],
        omittedFields: ["customDomain", "slug"],
        hasDynamicFields: false,
        sourcePath: [],
        matchedNested: false,
      });

      const nestedRestRetained = resolveRetainedObjectFields(
        rowShape,
        mutateDescriptions(observedByTag.get("nestedRest")!.path!),
      );
      assert.deepEqual(nestedRestRetained, {
        fields: ["id", "owner"],
        omittedFields: ["plan"],
        hasDynamicFields: false,
        sourcePath: ["workspace"],
        matchedNested: true,
      });

      const nestedOwnerRetained = resolveRetainedObjectFields(
        rowShape,
        mutateDescriptions(observedByTag.get("nestedOwner")!.path!),
      );
      assert.deepEqual(nestedOwnerRetained, {
        fields: ["id", "email"],
        omittedFields: [],
        hasDynamicFields: false,
        sourcePath: ["workspace", "owner"],
        matchedNested: true,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
