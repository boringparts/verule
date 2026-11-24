import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  VeruleExecutionError,
  defineConfig,
  defineRule,
  openSession,
  runCheck,
  type BranchEdgeInfo,
  type BranchRef,
  type RuleContext,
  type SyntaxRef,
} from "@verule/sdk";

function verifyBranchTypeContracts(
  ctx: RuleContext,
  syntaxRef: SyntaxRef,
  branchRef: BranchRef,
): void {
  void ctx.branchCoverage({
    // @ts-expect-error SyntaxRef cannot be passed where BranchRef is required
    branches: [syntaxRef],
    targets: [syntaxRef],
  });
  void ctx.branchCoverage({
    branches: [branchRef],
    // @ts-expect-error BranchRef cannot be passed where SyntaxRef is required
    targets: [branchRef],
  });
  void ctx.branchCoverage({
    // @ts-expect-error BranchRef cannot be passed as local scope
    scope: branchRef,
    branches: [branchRef],
    targets: [syntaxRef],
  });
  // @ts-expect-error BranchRef cannot be passed to listBranches
  void ctx.listBranches([branchRef]);
}

void verifyBranchTypeContracts;

function createTempProject(sourceText: string): string {
  const root = mkdtempSync(join(tmpdir(), "verule-branch-coverage-test-"));
  mkdirSync(join(root, "src"), { recursive: true });
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
  writeFileSync(join(root, "src", "handlers.ts"), sourceText, "utf8");
  return root;
}

const SLICE_1_SOURCE = [
  "declare function isAuthorized(req: string): boolean;",
  "declare function audit(req: string): void;",
  "declare function execute(req: string): void;",
  "",
  "export function guardedEarlyReturn(req: string): void {",
  "  if (!isAuthorized(req)) {",
  "    return;",
  "  }",
  "  execute(req);",
  "}",
  "",
  "export function bypassPossible(req: string): void {",
  "  if (isAuthorized(req)) {",
  "    audit(req);",
  "  }",
  "  execute(req);",
  "}",
  "",
].join("\n");

const JOINT_AND_SWITCH_SOURCE = [
  "declare function hasApiKey(req: string): boolean;",
  "declare function hasSession(req: string): boolean;",
  "declare function verifyApiKey(req: string): void;",
  "declare function verifySession(req: string): void;",
  "declare function verifyBearer(req: string): void;",
  "declare function execute(req: string): void;",
  "",
  "export function multiAuthIfElse(req: string): void {",
  "  if (hasApiKey(req)) {",
  "    verifyApiKey(req);",
  "  } else if (hasSession(req)) {",
  "    verifySession(req);",
  "  } else {",
  "    return;",
  "  }",
  "  execute(req);",
  "}",
  "",
  'export function switchWithDefault(authType: "bearer" | "hmac" | "none"): void {',
  "  switch (authType) {",
  '    case "bearer":',
  '      verifyBearer("bearer");',
  "      break;",
  '    case "hmac":',
  '      verifyApiKey("hmac");',
  "      break;",
  "    default:",
  '      throw new Error("unsupported");',
  "  }",
  "  execute(authType);",
  "}",
  "",
  'export function switchFallthrough(authType: "legacy" | "bearer" | "none"): void {',
  "  switch (authType) {",
  '    case "legacy":',
  '    case "bearer":',
  '      verifyBearer("ok");',
  "      break;",
  "    default:",
  "      return;",
  "  }",
  "  execute(authType);",
  "}",
  "",
  'export function switchNoDefault(authType: "bearer" | "other"): void {',
  "  switch (authType) {",
  '    case "bearer":',
  '      verifyBearer("bearer");',
  "      break;",
  "  }",
  "  execute(authType);",
  "}",
  "",
].join("\n");

const EXPRESSION_BRANCH_SOURCE = [
  "declare function isAuthorized(req: string): boolean;",
  "declare function isGuest(req: string): boolean;",
  "declare function deny(req: string): void;",
  "declare function execute(req: string): void;",
  "",
  "export class HandlerService {",
  "  handle(req: string): void {",
  "    isAuthorized(req) ? execute(req) : deny(req);",
  "  }",
  "}",
  "",
  "export const conciseAnd = (req: string): void => {",
  "  isAuthorized(req) && execute(req);",
  "};",
  "",
  "export const conciseExprBody = (req: string) => isAuthorized(req) && execute(req);",
  "",
  "export const fnExprOrNullish = function (req: string, cached: string | null): void {",
  "  isGuest(req) || execute(req);",
  "  const _v = cached ?? execute(req);",
  "};",
  "",
].join("\n");

const UNREACHABLE_AND_UNKNOWN_SOURCE = [
  "declare function isAuthorized(req: string): boolean;",
  "declare function verify(req: string): void;",
  "declare function execute(req: string): void;",
  "declare function log(err: unknown): void;",
  "",
  "export function deadAfterReturn(req: string): void {",
  "  if (isAuthorized(req)) {",
  "    verify(req);",
  "  }",
  "  return;",
  "  execute(req);",
  "}",
  "",
  "export function deadIfFalse(req: string): void {",
  "  if (false) {",
  "    execute(req);",
  "  }",
  "}",
  "",
  'export function deadAfterSwitch(mode: "a" | "b"): void {',
  "  switch (mode) {",
  '    case "a":',
  "      return;",
  "    default:",
  "      return;",
  "  }",
  "  execute(mode);",
  "}",
  "",
  "export function tryCatchHandler(req: string): void {",
  "  try {",
  "    if (isAuthorized(req)) {",
  "      execute(req);",
  "    }",
  "  } catch (err) {",
  "    log(err);",
  "  }",
  "}",
  "",
  "export function loopHandler(items: readonly string[]): void {",
  "  for (const item of items) {",
  "    if (isAuthorized(item)) {",
  "      execute(item);",
  "    }",
  "  }",
  "}",
  "",
  "export function* generatorHandler(req: string): Generator<string> {",
  "  yield req;",
  "  if (isAuthorized(req)) {",
  "    execute(req);",
  "  }",
  "}",
  "",
  "export function outerWithClosure(req: string): () => void {",
  "  const inner = () => {",
  "    execute(req);",
  "  };",
  "  return inner;",
  "}",
  "",
].join("\n");

function insideSpan(
  loc: { readonly start: number; readonly end: number },
  fnLoc: { readonly start: number; readonly end: number },
): boolean {
  return loc.start >= fnLoc.start && loc.end <= fnLoc.end;
}

void describe("@verule/sdk branchCoverage", () => {
  void it("distinguishes covered early-return guard from bypass path via listBranches and branchCoverage", async () => {
    const root = createTempProject(SLICE_1_SOURCE);
    const observed: Array<{
      fn: string;
      status: string;
      evidenceCount: number;
    }> = [];

    const rule = defineRule({
      id: "require-auth-before-execute",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const branchGroups = await ctx.listBranches(fns.map((fn) => fn.ref));

        for (const [index, fn] of fns.entries()) {
          const executeCalls = calls.filter(
            (call) =>
              call.text.startsWith("execute(") &&
              insideSpan(call.location, fn.location),
          );
          if (executeCalls.length === 0) continue;

          const branches = branchGroups[index]!.branches;
          const selected: BranchRef[] = branches
            .filter(
              (branch) =>
                (branch.kind === "if" &&
                  branch.conditionText === "!isAuthorized(req)" &&
                  branch.direction === "false") ||
                (branch.kind === "if" &&
                  branch.conditionText === "isAuthorized(req)" &&
                  branch.direction === "true"),
            )
            .map((branch) => branch.ref);

          const targets: SyntaxRef[] = executeCalls.map((call) => call.ref);
          const coverage = await ctx.branchCoverage({
            function: fn.ref,
            branches: selected,
            targets,
          });

          for (const item of coverage) {
            observed.push({
              fn: fn.text.includes("guardedEarlyReturn")
                ? "guardedEarlyReturn"
                : "bypassPossible",
              status: item.status,
              evidenceCount: item.evidence.length,
            });
            if (item.status === "bypass") {
              ctx.report({
                at: executeCalls[0]!.location,
                message:
                  "execute() can be reached without passing authorization.",
                findingKey: "auth-bypass",
                basis: [item],
              });
            }
          }
        }
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
      });

      assert.deepEqual(observed, [
        { fn: "guardedEarlyReturn", status: "covered", evidenceCount: 1 },
        { fn: "bypassPossible", status: "bypass", evidenceCount: 2 },
      ]);
      assert.equal(report.status, "findings");
      assert.equal(report.diagnostics.length, 1);
      assert.equal(report.diagnostics[0]!.at.line, 16);
      assert.ok(report.diagnostics[0]!.evidence.length >= 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("handles multi-branch joint coverage and switch/case/default fallthrough semantics", async () => {
    const root = createTempProject(JOINT_AND_SWITCH_SOURCE);
    const results: Record<string, string> = {};
    const witnessMessages: Record<string, readonly string[]> = {};

    const rule = defineRule({
      id: "joint-and-switch-check",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const branchGroups = await ctx.listBranches(fns.map((fn) => fn.ref));

        const fnByName = (name: string) => {
          const idx = fns.findIndex((fn) =>
            fn.text.includes(`function ${name}(`),
          );
          assert.ok(idx >= 0, `expected function ${name}`);
          const fn = fns[idx]!;
          const executeCall = calls.find(
            (call) =>
              call.text.startsWith("execute(") &&
              insideSpan(call.location, fn.location),
          )!;
          return {
            fn,
            branches: branchGroups[idx]!.branches,
            executeCall,
          };
        };

        // 1. multiAuthIfElse: single branch bypasses, combined pair covers
        {
          const { fn, branches, executeCall } = fnByName("multiAuthIfElse");
          const apiKeyTrue = branches.find(
            (b) =>
              b.conditionText === "hasApiKey(req)" && b.direction === "true",
          )!;
          const sessionTrue = branches.find(
            (b) =>
              b.conditionText === "hasSession(req)" && b.direction === "true",
          )!;

          const [onlyApi] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [apiKeyTrue.ref],
            targets: [executeCall.ref],
          });
          results["multiAuthIfElse:onlyApi"] = onlyApi!.status;
          witnessMessages["multiAuthIfElse:onlyApi"] = onlyApi!.evidence.map(
            (e) => e.message,
          );

          const [onlySession] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [sessionTrue.ref],
            targets: [executeCall.ref],
          });
          results["multiAuthIfElse:onlySession"] = onlySession!.status;

          const [both] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [apiKeyTrue.ref, sessionTrue.ref],
            targets: [executeCall.ref],
          });
          results["multiAuthIfElse:both"] = both!.status;
        }

        // 2. switchWithDefault
        {
          const { fn, branches, executeCall } = fnByName("switchWithDefault");
          const bearerCase = branches.find(
            (b) => b.kind === "switchCase" && b.conditionText === '"bearer"',
          )!;
          const hmacCase = branches.find(
            (b) => b.kind === "switchCase" && b.conditionText === '"hmac"',
          )!;
          const [onlyBearer] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [bearerCase.ref],
            targets: [executeCall.ref],
          });
          results["switchWithDefault:onlyBearer"] = onlyBearer!.status;

          const [bothCases] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [bearerCase.ref, hmacCase.ref],
            targets: [executeCall.ref],
          });
          results["switchWithDefault:bothCases"] = bothCases!.status;
        }

        // 3. switchFallthrough
        {
          const { fn, branches, executeCall } = fnByName("switchFallthrough");
          const legacyCase = branches.find(
            (b) => b.kind === "switchCase" && b.conditionText === '"legacy"',
          )!;
          const bearerCase = branches.find(
            (b) => b.kind === "switchCase" && b.conditionText === '"bearer"',
          )!;
          const [onlyBearer] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [bearerCase.ref],
            targets: [executeCall.ref],
          });
          results["switchFallthrough:onlyBearer"] = onlyBearer!.status;

          const [bothCases] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [legacyCase.ref, bearerCase.ref],
            targets: [executeCall.ref],
          });
          results["switchFallthrough:bothCases"] = bothCases!.status;
        }

        // 4. switchNoDefault
        {
          const { fn, branches, executeCall } = fnByName("switchNoDefault");
          const bearerCase = branches.find(
            (b) => b.kind === "switchCase" && b.conditionText === '"bearer"',
          )!;
          const [onlyBearer] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [bearerCase.ref],
            targets: [executeCall.ref],
          });
          results["switchNoDefault:onlyBearer"] = onlyBearer!.status;
          witnessMessages["switchNoDefault:onlyBearer"] =
            onlyBearer!.evidence.map((e) => e.message);
        }
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
      });
      assert.equal(report.status, "clean");
      assert.deepEqual(results, {
        "multiAuthIfElse:onlyApi": "bypass",
        "multiAuthIfElse:onlySession": "bypass",
        "multiAuthIfElse:both": "covered",
        "switchWithDefault:onlyBearer": "bypass",
        "switchWithDefault:bothCases": "covered",
        "switchFallthrough:onlyBearer": "bypass",
        "switchFallthrough:bothCases": "covered",
        "switchNoDefault:onlyBearer": "bypass",
      });
      assert.ok(
        witnessMessages["multiAuthIfElse:onlyApi"]!.some((msg) =>
          msg.includes("hasSession(req)"),
        ),
      );
      assert.ok(
        witnessMessages["switchNoDefault:onlyBearer"]!.some((msg) =>
          msg.includes("no default clause"),
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("supports methods, arrow functions, function expressions, ternary, and short-circuit operators", async () => {
    const root = createTempProject(EXPRESSION_BRANCH_SOURCE);
    const statuses: Record<string, string> = {};
    let conditionTypeText: string | undefined;

    const rule = defineRule({
      id: "expression-branches-check",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({
          kinds: ["MethodDeclaration", "ArrowFunction", "FunctionExpression"],
        });
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const branchGroups = await ctx.listBranches(fns.map((fn) => fn.ref));

        const condTypeResults = await ctx.typeAt([
          branchGroups[0]!.branches[0]!.condition,
        ]);
        conditionTypeText = condTypeResults[0]?.typeText;

        // Omitting `function` resolves enclosing function automatically for each target.
        const allBranches: BranchEdgeInfo[] = branchGroups.flatMap(
          (g) => g.branches,
        );
        const executeCalls = calls.filter((call) =>
          call.text.startsWith("execute("),
        );
        assert.equal(executeCalls.length, 5);

        const coveringBranches = allBranches
          .filter(
            (b) =>
              (b.kind === "conditional" && b.direction === "true") ||
              (b.kind === "logicalAnd" && b.direction === "continue") ||
              (b.kind === "logicalOr" && b.direction === "continue") ||
              (b.kind === "nullishCoalescing" && b.direction === "continue"),
          )
          .map((b) => b.ref);

        const coverage = await ctx.branchCoverage({
          branches: coveringBranches,
          targets: executeCalls.map((c) => c.ref),
        });
        for (const [idx, item] of coverage.entries()) {
          statuses[`call_${idx}`] = item.status;
        }

        // Wrong branch direction yields bypass
        const wrongBranches = allBranches
          .filter((b) => b.kind === "conditional" && b.direction === "false")
          .map((b) => b.ref);
        const [methodBypass] = await ctx.branchCoverage({
          branches: wrongBranches,
          targets: [executeCalls[0]!.ref],
        });
        statuses["method_wrong_branch"] = methodBypass!.status;
      },
    });

    try {
      await runCheck({
        cwd: root,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
      });

      assert.equal(conditionTypeText, "boolean");
      assert.deepEqual(statuses, {
        call_0: "covered",
        call_1: "covered",
        call_2: "covered",
        call_3: "covered",
        call_4: "covered",
        method_wrong_branch: "bypass",
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("returns unreachable for dead targets and unknown with Gaps for unmodeled control flow", async () => {
    const root = createTempProject(UNREACHABLE_AND_UNKNOWN_SOURCE);
    const statuses: Record<string, string> = {};
    const gapKinds: Record<string, readonly string[]> = {};
    let tryBranchCount = 0;

    const rule = defineRule({
      id: "unreachable-and-unknown-check",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({
          kinds: ["FunctionDeclaration", "ArrowFunction"],
        });
        const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
        const branchGroups = await ctx.listBranches(fns.map((fn) => fn.ref));

        const findFn = (prefix: string) => {
          const idx = fns.findIndex((fn) => fn.text.includes(prefix));
          assert.ok(idx >= 0, `expected fn ${prefix}`);
          const fn = fns[idx]!;
          const executeCall = calls.find(
            (call) =>
              call.text.startsWith("execute(") &&
              insideSpan(call.location, fn.location),
          )!;
          return {
            fn,
            group: branchGroups[idx]!,
            executeCall,
          };
        };

        for (const [label, fnName] of [
          ["deadAfterReturn", "deadAfterReturn"],
          ["deadIfFalse", "deadIfFalse"],
          ["deadAfterSwitch", "deadAfterSwitch"],
        ] as const) {
          const { fn, group, executeCall } = findFn(`function ${fnName}(`);
          const [res] = await ctx.branchCoverage({
            function: fn.ref,
            branches: group.branches.map((b) => b.ref),
            targets: [executeCall.ref],
          });
          statuses[label] = res!.status;
        }

        const tryCase = findFn("function tryCatchHandler(");
        tryBranchCount = tryCase.group.branches.length;
        const [tryRes] = await ctx.branchCoverage({
          function: tryCase.fn.ref,
          branches: tryCase.group.branches.map((b) => b.ref),
          targets: [tryCase.executeCall.ref],
        });
        statuses["tryCatch"] = tryRes!.status;
        gapKinds["tryCatch"] = tryRes!.gaps.map((g) => g.kind);

        const loopCase = findFn("function loopHandler(");
        const [loopRes] = await ctx.branchCoverage({
          function: loopCase.fn.ref,
          branches: loopCase.group.branches.map((b) => b.ref),
          targets: [loopCase.executeCall.ref],
        });
        statuses["loop"] = loopRes!.status;
        gapKinds["loop"] = loopRes!.gaps.map((g) => g.kind);

        const genCase = findFn("function* generatorHandler(");
        const [genRes] = await ctx.branchCoverage({
          function: genCase.fn.ref,
          branches: genCase.group.branches.map((b) => b.ref),
          targets: [genCase.executeCall.ref],
        });
        statuses["generator"] = genRes!.status;
        gapKinds["generator"] = genRes!.gaps.map((g) => g.kind);

        // Outer function querying target inside nested closure must not confuse scopes
        const outerCase = findFn("function outerWithClosure(");
        const [outerRes] = await ctx.branchCoverage({
          function: outerCase.fn.ref,
          branches: [],
          targets: [outerCase.executeCall.ref],
        });
        statuses["outerForInnerTarget"] = outerRes!.status;
        gapKinds["outerForInnerTarget"] = outerRes!.gaps.map((g) => g.kind);

        // Querying the inner arrow function directly works
        const innerArrow = fns.find(
          (fn) =>
            fn.kind === "ArrowFunction" && fn.text.includes("execute(req)"),
        )!;
        const [innerRes] = await ctx.branchCoverage({
          function: innerArrow.ref,
          branches: [],
          targets: [outerCase.executeCall.ref],
        });
        statuses["innerDirect"] = innerRes!.status;
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
      });

      assert.equal(report.status, "clean");
      assert.equal(tryBranchCount, 2);
      assert.deepEqual(statuses, {
        deadAfterReturn: "unreachable",
        deadIfFalse: "unreachable",
        deadAfterSwitch: "unreachable",
        tryCatch: "unknown",
        loop: "unknown",
        generator: "unknown",
        outerForInnerTarget: "unknown",
        innerDirect: "bypass",
      });
      assert.deepEqual(gapKinds, {
        tryCatch: ["unmodeled-try-catch"],
        loop: ["unmodeled-loop"],
        generator: ["unmodeled-generator"],
        outerForInnerTarget: ["target-outside-cfg"],
      });
      assert.ok(report.gaps.length >= 4);
      assert.ok(
        report.gaps.every(
          (gap) => gap.at !== undefined && gap.message.length > 0,
        ),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("rejects stale BranchRefs across sessions and foreign BranchRefs when function is explicit", async () => {
    const root = createTempProject(SLICE_1_SOURCE);
    let capturedBranchRef: BranchRef | undefined;

    try {
      const session1 = await openSession({ cwd: root });
      let foreignResultStatus: string | undefined;
      let foreignGapKind: string | undefined;
      try {
        const report = await session1.check([
          defineRule({
            id: "capture-branch-and-test-foreign",
            run: async (ctx) => {
              const fns = (
                await ctx.findSyntax({
                  kinds: ["FunctionDeclaration"],
                })
              ).filter((fn) => !fn.text.startsWith("declare "));
              const calls = await ctx.findSyntax({
                kinds: ["CallExpression"],
              });
              const groups = await ctx.listBranches(fns.map((fn) => fn.ref));
              capturedBranchRef = groups[0]!.branches[0]!.ref;

              const secondFn = fns[1]!;
              const secondExecute = calls.find(
                (c) =>
                  c.text.startsWith("execute(") &&
                  insideSpan(c.location, secondFn.location),
              )!;
              const [res] = await ctx.branchCoverage({
                function: secondFn.ref,
                branches: [capturedBranchRef],
                targets: [secondExecute.ref],
              });
              foreignResultStatus = res!.status;
              foreignGapKind = res!.gaps[0]?.kind;
            },
          }),
        ]);
        assert.equal(foreignResultStatus, "unknown");
        assert.equal(foreignGapKind, "foreign-branch-reference");
        assert.equal(report.gaps[0]?.kind, "foreign-branch-reference");
      } finally {
        await session1.close();
      }

      assert.ok(capturedBranchRef);
      await assert.rejects(
        () =>
          runCheck({
            cwd: root,
            config: defineConfig({
              tsconfig: "tsconfig.json",
              rules: [
                defineRule({
                  id: "stale-branch-ref",
                  run: async (ctx) => {
                    const calls = await ctx.findSyntax({
                      kinds: ["CallExpression"],
                    });
                    await ctx.branchCoverage({
                      branches: [capturedBranchRef!],
                      targets: [calls[0]!.ref],
                    });
                  },
                }),
              ],
            }),
          }),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "STALE_REFERENCE",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("evaluates local-scope branchCoverage inside loop and try/finally bodies without degrading on outer control flow", async () => {
    const root = createTempProject(
      [
        "const enum JobFlags { QUEUED = 1 << 0, ALLOW_RECURSE = 1 << 2 }",
        "interface Job { (): void; flags?: number }",
        "declare function shouldSkip(job: Job): boolean;",
        "declare function runWithHandling(job: Job): void;",
        "declare const queue: Job[];",
        "",
        "export function loopWithBypass(): void {",
        "  for (let i = 0; i < queue.length; i++) {",
        "    const job = queue[i];",
        "    if (job) {",
        "      if (shouldSkip(job)) {",
        "        continue;",
        "      }",
        "      if (job.flags! & JobFlags.ALLOW_RECURSE) {",
        "        job.flags! &= ~JobFlags.QUEUED;",
        "      }",
        "      job();",
        "      job.flags! &= ~JobFlags.QUEUED;",
        "    }",
        "  }",
        "}",
        "",
        "export function tryLoopWithGuard(): void {",
        "  try {",
        "    for (let i = 0; i < queue.length; i++) {",
        "      const job = queue[i];",
        "      if (job) {",
        "        if (shouldSkip(job)) {",
        "          continue;",
        "        }",
        "        if (job.flags! & JobFlags.ALLOW_RECURSE) {",
        "          job.flags! &= ~JobFlags.QUEUED;",
        "        }",
        "        runWithHandling(job);",
        "        if (!(job.flags! & JobFlags.ALLOW_RECURSE)) {",
        "          job.flags! &= ~JobFlags.QUEUED;",
        "        }",
        "      }",
        "    }",
        "  } finally {",
        "    queue.length = 0;",
        "  }",
        "}",
        "",
        "export function loopWithContinueGuard(): void {",
        "  for (let i = 0; i < queue.length; i++) {",
        "    const job = queue[i];",
        "    if (job) {",
        "      if (job.flags! & JobFlags.ALLOW_RECURSE) {",
        "        continue;",
        "      }",
        "      job.flags! &= ~JobFlags.QUEUED;",
        "    }",
        "  }",
        "}",
        "",
      ].join("\n"),
    );

    const localStatuses: Record<string, string> = {};
    const localGapCounts: Record<string, number> = {};
    const wholeFnStatuses: Record<string, string> = {};

    const rule = defineRule({
      id: "local-scope-branch-coverage",
      run: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        const blocks = await ctx.findSyntax({ kinds: ["Block"] });
        const writes = (
          await ctx.findSyntax({ kinds: ["BinaryExpression"] })
        ).filter((expr) => expr.text.includes("&="));

        for (const fnName of [
          "loopWithBypass",
          "tryLoopWithGuard",
          "loopWithContinueGuard",
        ] as const) {
          const fn = fns.find((f) => f.text.includes(`function ${fnName}(`))!;
          const fnWrites = writes.filter((w) =>
            insideSpan(w.location, fn.location),
          );
          const postClear = fnWrites.at(-1)!;

          // Whole-function query preserves unmodeled outer loop/try gaps
          const [wholeFnCov] = await ctx.branchCoverage({
            function: fn.ref,
            branches: [],
            targets: [postClear.ref],
          });
          wholeFnStatuses[fnName] = wholeFnCov!.status;

          // Pick the loop body block (outermost block inside the loop/try that has no loop/try keywords of its own)
          const candidateBlocks = blocks
            .filter(
              (b) =>
                insideSpan(b.location, fn.location) &&
                insideSpan(postClear.location, b.location) &&
                !b.text.includes("for (") &&
                !b.text.includes("try {") &&
                b.text.includes("ALLOW_RECURSE"),
            )
            .toSorted(
              (a, b) =>
                b.location.end -
                b.location.start -
                (a.location.end - a.location.start),
            );
          const localBlock = candidateBlocks[0]!;

          const [localBranches] = await ctx.listBranches([localBlock.ref]);
          const guardBranches = localBranches!.branches.filter(
            (b) =>
              b.conditionText.includes("ALLOW_RECURSE") &&
              ((b.conditionText.startsWith("!") && b.direction === "true") ||
                (!b.conditionText.startsWith("!") && b.direction === "false")),
          );

          const [localCov] = await ctx.branchCoverage({
            scope: localBlock.ref,
            branches: guardBranches.map((b) => b.ref),
            targets: [postClear.ref],
          });
          localStatuses[fnName] = localCov!.status;
          localGapCounts[fnName] =
            localBranches!.gaps.length + localCov!.gaps.length;
        }
      },
    });

    try {
      const report = await runCheck({
        cwd: root,
        config: defineConfig({ tsconfig: "tsconfig.json", rules: [rule] }),
      });

      assert.equal(report.status, "clean");
      assert.deepEqual(wholeFnStatuses, {
        loopWithBypass: "unknown",
        tryLoopWithGuard: "unknown",
        loopWithContinueGuard: "unknown",
      });
      assert.deepEqual(localStatuses, {
        loopWithBypass: "bypass",
        tryLoopWithGuard: "covered",
        loopWithContinueGuard: "covered",
      });
      assert.deepEqual(localGapCounts, {
        loopWithBypass: 0,
        tryLoopWithGuard: 0,
        loopWithContinueGuard: 0,
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
