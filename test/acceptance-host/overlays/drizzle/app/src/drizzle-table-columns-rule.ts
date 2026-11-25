import { defineRule, type FactResult } from "@boringparts/verule";
import {
  DrizzleTableColumnsFact,
  type DrizzleTableColumnsFactValue,
  type DrizzleTableSubjectKind,
} from "@tssae/adapters/drizzle";

export type DrizzleTableResult = FactResult<
  DrizzleTableSubjectKind,
  DrizzleTableColumnsFactValue
>;

export let queriedDrizzleTableFacts: readonly DrizzleTableResult[] = [];
export let queriedTargetedTableFacts: readonly DrizzleTableResult[] = [];
export let queriedTargetedTableHandleId = "";

export const drizzleTableColumnsRule = defineRule({
  id: "drizzle-table-columns",
  run: async (ctx) => {
    queriedDrizzleTableFacts = await ctx.facts(DrizzleTableColumnsFact);

    const consumerCalls = await ctx.findSyntax({
      files: ["packages/app/src/drizzle-table-consumer.ts"],
      kinds: ["CallExpression"],
    });
    const registerCall = consumerCalls.find((node) =>
      node.text.startsWith("registerTable("),
    );
    const tableArg = registerCall?.arguments?.[0];
    queriedTargetedTableHandleId = tableArg?.handleId ?? "";
    queriedTargetedTableFacts = tableArg
      ? await ctx.facts(DrizzleTableColumnsFact, { targets: [tableArg] })
      : [];

    for (const fact of queriedDrizzleTableFacts) {
      const tableEvidence = fact.evidence.find(
        (item) =>
          item.at?.file.endsWith("drizzle-schema.ts") === true ||
          item.at?.file.endsWith("drizzle-tables.ts") === true,
      );
      if (tableEvidence?.at === undefined) {
        throw new Error("Drizzle table columns fact has no source evidence.");
      }

      const notNullCols = fact.value.columnNames.filter(
        (name) => !fact.value.columns[name]?.nullable,
      );
      const defaultedCols = fact.value.columnNames.filter(
        (name) => fact.value.columns[name]?.hasDefault,
      );
      const primaryKeyCols = fact.value.columnNames.filter(
        (name) => fact.value.columns[name]?.primaryKey,
      );

      ctx.report({
        at: tableEvidence.at,
        message: [
          `table=${fact.value.tableName}`,
          `columns=${fact.value.columnNames.join(",")}`,
          `notNull=${notNullCols.join(",") || "none"}`,
          `defaults=${defaultedCols.join(",") || "none"}`,
          `primaryKey=${primaryKeyCols.join(",") || "none"}`,
          `dynamic=${fact.value.hasDynamicColumns}`,
          `gaps=${fact.gaps.map((gap) => gap.kind).join(",") || "none"}`,
        ].join(" "),
        basis: [fact],
      });
    }
  },
});
