import { defineRule, type FactResult } from "@boringparts/verule";
import {
  QueryRowProjectionFact,
  type QueryRowProjectionFactValue,
} from "@verule/adapter-drizzle";

export type DrizzleProjectionResult = FactResult<
  "syntax" | "call" | "declaration",
  QueryRowProjectionFactValue
>;

export let queriedDrizzleFacts: readonly DrizzleProjectionResult[] = [];

export const drizzleProjectionRule = defineRule({
  id: "drizzle-projection",
  run: async (ctx) => {
    queriedDrizzleFacts = await ctx.facts(QueryRowProjectionFact, {
      condition: { library: "drizzle" },
    });

    for (const fact of queriedDrizzleFacts) {
      const queryEvidence = fact.evidence.find(
        (item) => item.at?.file.endsWith("drizzle-projections.ts") === true,
      );
      if (queryEvidence?.at === undefined) {
        throw new Error("Drizzle projection has no query source evidence.");
      }

      ctx.report({
        at: queryEvidence.at,
        message: [
          `kind=${fact.value.queryKind}`,
          `table=${fact.value.tableName ?? "unknown"}`,
          `columns=${fact.value.projectedColumns.join(",")}`,
          `dynamic=${fact.value.hasDynamicColumns}`,
          `gaps=${fact.gaps.map((gap) => gap.kind).join(",") || "none"}`,
        ].join(" "),
        basis: [fact],
      });
    }
  },
});
