import { defineConfig, defineRule, isSameInstance } from "@boringparts/verule";

const cleanupRule = defineRule({
  id: "resource-cleanup",
  run: async (ctx) => {
    const fns = await ctx.findSyntax({
      files: ["src/resources.ts"],
      kinds: ["FunctionDeclaration"],
    });
    const vars = await ctx.findSyntax({
      files: ["src/resources.ts"],
      kinds: ["VariableDeclaration"],
    });
    const calls = await ctx.findSyntax({
      files: ["src/resources.ts"],
      kinds: ["CallExpression"],
    });

    for (const fn of fns) {
      const resAVar = vars.find(
        (v) =>
          v.location.start >= fn.location.start &&
          v.location.end <= fn.location.end &&
          v.text.startsWith("resA ="),
      );
      const closeCall = calls.find(
        (c) =>
          c.location.start >= fn.location.start &&
          c.location.end <= fn.location.end &&
          c.text.startsWith("onDidClose("),
      );
      if (!resAVar?.initializer || !closeCall) continue;

      const [instRes] = await ctx.resolveInstances([resAVar.initializer]);
      if (instRes?.status !== "proved" || instRes.instance === null) continue;

      const [cleanup] = await ctx.instanceCleanup({
        scopes: [closeCall.ref],
        targets: [instRes.instance],
      });
      const tr = cleanup?.targetResults[0];
      if (tr && tr.status === "disproved") {
        const wrong = cleanup.disposedInstances.find(
          (d) => !isSameInstance(d.instance, instRes.instance),
        );
        ctx.report({
          at: resAVar.location,
          message: wrong
            ? `Closed A (${tr.instanceKey}) but disposed B (${wrong.instanceKey}) instead.`
            : `Resource A (${tr.instanceKey}) was not disposed.`,
          basis: wrong ? [tr, wrong] : [tr],
        });
      }
    }
  },
});

const validationRule = defineRule({
  id: "validated-arg",
  run: async (ctx) => {
    const fns = await ctx.findSyntax({
      files: ["src/validation.ts"],
      kinds: ["FunctionDeclaration"],
    });
    const calls = await ctx.findSyntax({
      files: ["src/validation.ts"],
      kinds: ["CallExpression"],
    });
    const branchesList = await ctx.listBranches(fns.map((f) => f.ref));
    const effects = await ctx.callEffects({ targets: fns.map((f) => f.ref) });

    for (const [idx, fn] of fns.entries()) {
      if (!fn.text.includes("Route(")) continue;
      const rawParam = fn.parameters?.[0];
      const sinkCall = calls.find(
        (c) =>
          c.location.start >= fn.location.start &&
          c.location.end <= fn.location.end &&
          c.text.startsWith("sink("),
      );
      if (!rawParam || !sinkCall) continue;
      const [resolvedSink] = await ctx.resolveCalls([sinkCall.ref], {
        select: { arguments: true },
      });
      const sinkArg = resolvedSink?.arguments?.[0];
      if (!sinkArg) continue;

      const okFalse = branchesList[idx]?.branches.find(
        (b) => b.conditionText.includes("parsed.ok") && b.direction === "false",
      );
      const [cov] = await ctx.branchCoverage({
        function: fn.ref,
        branches: okFalse ? [okFalse.ref] : [],
        targets: [sinkCall.ref],
      });
      const rawProp = await ctx.valuePropagation({
        from: rawParam,
        to: sinkArg,
      });
      const dataReads = (effects[idx]?.fieldReads ?? [])
        .filter((r) => r.propertyName === "data")
        .map((r) => r.syntax);
      const dataProp =
        dataReads.length > 0
          ? await ctx.valuePropagation({ from: dataReads, to: sinkArg })
          : null;

      if (
        cov?.status !== "proved" ||
        rawProp.results.some((r) => r.status === "proved") ||
        !(dataProp?.results.some((r) => r.status === "proved") ?? false)
      ) {
        ctx.report({
          at: sinkCall.location,
          message:
            "sink() received raw unvalidated value despite passing parsed.ok branch.",
        });
      }
    }
  },
});

const schedulerRule = defineRule({
  id: "scheduler-flag-guard",
  run: async (ctx) => {
    const fns = await ctx.findSyntax({
      files: ["src/scheduler.ts"],
      kinds: ["FunctionDeclaration"],
    });
    const effects = await ctx.callEffects({ targets: fns.map((f) => f.ref) });
    const branchesList = await ctx.listBranches(fns.map((f) => f.ref));

    for (const [idx, fn] of fns.entries()) {
      if (!fn.text.includes("flushJob")) continue;
      const eff = effects[idx];
      if (!eff) continue;
      const requeue = eff.fieldWrites.find(
        (w) => w.propertyName === "flags" && w.operator === "|=",
      );
      const clearWrite = eff.fieldWrites.find(
        (w) =>
          w.propertyName === "flags" &&
          w.operator === "&=" &&
          w.viaCall === null,
      );
      if (!requeue || !clearWrite) continue;

      const guardBranches = (branchesList[idx]?.branches ?? []).filter(
        (b) =>
          b.conditionText.includes("ALLOW_RECURSE") && b.direction === "true",
      );
      const [cov] = await ctx.branchCoverage({
        function: fn.ref,
        branches: guardBranches.map((b) => b.ref),
        targets: [clearWrite.syntax],
      });
      if (cov?.status !== "proved") {
        ctx.report({
          at: clearWrite.location,
          message: "Post-callback flag clear is missing ALLOW_RECURSE guard.",
          basis: cov ? [requeue, clearWrite, cov] : [requeue, clearWrite],
        });
      }
    }
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  rules: [cleanupRule, validationRule, schedulerRule],
});
