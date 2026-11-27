import { defineConfig, defineRule } from "@boringparts/verule";

const guardRule = defineRule({
  id: "host-auth-branch-coverage",
  run: async (ctx) => {
    const fns = (
      await ctx.findSyntax({ kinds: ["FunctionDeclaration"] })
    ).filter((fn) => !fn.text.startsWith("declare "));
    const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
    const branchGroups = await ctx.listBranches(fns.map((fn) => fn.ref));

    for (const [index, fn] of fns.entries()) {
      const actionCalls = calls.filter(
        (call) =>
          call.text.startsWith("runAction(") &&
          call.location.start >= fn.location.start &&
          call.location.end <= fn.location.end,
      );
      if (actionCalls.length === 0) continue;

      const guardBranches = branchGroups[index]!.branches.filter(
        (b) =>
          b.kind === "if" &&
          b.direction === "true" &&
          (b.conditionText === "hasApiKey(req)" ||
            b.conditionText === "hasSession(req)"),
      ).map((b) => b.ref);

      const coverage = await ctx.branchCoverage({
        function: fn.ref,
        branches: guardBranches,
        targets: actionCalls.map((call) => call.ref),
      });

      for (const [targetIdx, item] of coverage.entries()) {
        const targetCall = actionCalls[targetIdx]!;
        if (!item.targetReachable) {
          ctx.report({
            at: targetCall.location,
            message:
              "runAction() is unreachable from function entry and cannot be verified as covered.",
            findingKey: "branch-unreachable",
            basis: [item],
          });
        } else if (item.status === "disproved") {
          ctx.report({
            at: targetCall.location,
            message: "runAction() can bypass required authorization branch.",
            findingKey: "branch-bypass",
            basis: [item],
          });
        }
      }
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [guardRule],
});
