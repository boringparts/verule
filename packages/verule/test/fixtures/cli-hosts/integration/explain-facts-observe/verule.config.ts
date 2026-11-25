import {
  defineAdapter,
  defineConfig,
  defineFactType,
  defineRule,
} from "@boringparts/verule";

const SampleFact = defineFactType<"syntax", unknown, { readonly ok: boolean }>({
  id: "cli.sample-fact",
  subjectKind: "syntax",
});

const sampleAdapter = defineAdapter({
  id: "sample-provider",
  provides: [
    {
      factType: SampleFact,
      extract: async (ctx) => {
        const fns = await ctx.findSyntax({ kinds: ["FunctionDeclaration"] });
        return fns.map((fn) => ({
          subject: fn.ref,
          value: { ok: true },
        }));
      },
    },
  ],
});

const ruleFirst = defineRule({
  id: "rule-first",
  run: async (ctx) => {
    await ctx.facts(SampleFact);
  },
});

const ruleSecond = defineRule({
  id: "rule-second",
  run: async (ctx) => {
    await ctx.facts(SampleFact);
  },
});

export default defineConfig({
  tsconfig: "tsconfig.json",
  adapters: [sampleAdapter],
  rules: [ruleFirst, ruleSecond],
});
