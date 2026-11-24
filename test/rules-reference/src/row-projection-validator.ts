import {
  QueryRowProjectionFact,
  type QueryRowNestedRelationInfo,
  type QueryRowProjectionFactValue,
  type QueryRowSubjectKind,
} from "@verule/adapter-drizzle";
import {
  ValidatorInputFieldsFact,
  type ValidatorInputFieldsFactValue,
  type ValidatorSubjectKind,
} from "@verule/adapter-zod";
import {
  defineRule,
  resolveRetainedObjectFields,
  type DiagnosticBasis,
  type DiagnosticLocation,
  type FactResult,
  type ObjectFieldShape,
  type Rule,
  type SyntaxRef,
  type ValuePropagationPath,
} from "@verule/sdk";

export type RowProjectionValidatorRuleOptions = {
  readonly id?: string;
  readonly description?: string;
  readonly drizzleProviderId?: string;
};

type QueryFact = FactResult<QueryRowSubjectKind, QueryRowProjectionFactValue>;
type ValidatorFact = FactResult<
  ValidatorSubjectKind,
  ValidatorInputFieldsFactValue
>;

type ValidatorCallTarget = {
  readonly fact: ValidatorFact;
  readonly location: DiagnosticLocation;
  readonly argRef: SyntaxRef;
};

type MatchedRowSource = {
  readonly queryFact: QueryFact;
  readonly path: ValuePropagationPath;
  readonly relationName?: string;
  readonly relationInfo?: QueryRowNestedRelationInfo;
  readonly availableKeys: ReadonlySet<string>;
  readonly omittedKeys: ReadonlySet<string>;
  readonly hasDynamicColumns: boolean;
};

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function relationToShape(rel: QueryRowNestedRelationInfo): ObjectFieldShape {
  const nested: Record<string, ObjectFieldShape> = {};
  for (const [key, child] of Object.entries(rel.relations)) {
    nested[key] = relationToShape(child);
  }
  return {
    fields: rel.columns,
    nested,
    hasDynamicFields: rel.hasDynamicColumns,
  };
}

function projectionToShape(
  value: QueryRowProjectionFactValue,
): ObjectFieldShape {
  const nested: Record<string, ObjectFieldShape> = {};
  for (const [key, rel] of Object.entries(value.relations)) {
    nested[key] = relationToShape(rel);
  }
  return {
    fields: value.projectedColumns,
    nested,
    hasDynamicFields: value.hasDynamicColumns,
  };
}

function resolveNestedRelation(
  value: QueryRowProjectionFactValue,
  sourcePath: readonly string[],
): QueryRowNestedRelationInfo | undefined {
  let current: QueryRowNestedRelationInfo | undefined;
  let map = value.relations;
  for (const segment of sourcePath) {
    current = map[segment];
    if (!current) {
      return undefined;
    }
    map = current.relations;
  }
  return current;
}

/**
 * Creates a rule verifying that query rows passed into validator calls
 * provide all required validator input fields.
 */
export function createRowProjectionSatisfiesValidatorRule(
  options: RowProjectionValidatorRuleOptions = {},
): Rule {
  return defineRule({
    id: options.id ?? "row-projection-satisfies-validator",
    description:
      options.description ??
      "Verify that statically projected database query rows satisfy all required input fields of downstream validators.",
    run: async (ctx) => {
      const [queryFacts, validatorFacts] = await Promise.all([
        ctx.facts(
          QueryRowProjectionFact,
          options.drizzleProviderId !== undefined
            ? { providerId: options.drizzleProviderId }
            : undefined,
        ),
        ctx.facts(ValidatorInputFieldsFact, {
          condition: { scope: "calls" },
        }),
      ]);
      if (queryFacts.length === 0 || validatorFacts.length === 0) {
        return;
      }

      const queryRows = await ctx.syntaxOf(
        queryFacts.map((fact) => fact.subject),
        { select: { location: true } },
      );
      const queryLocationByHandle = new Map<string, DiagnosticLocation>();
      for (const [index, row] of queryRows.entries()) {
        const location = row?.location;
        if (location) {
          queryLocationByHandle.set(
            queryFacts[index]!.subject.handleId,
            location,
          );
        }
      }

      const callRows = await ctx.syntaxOf(
        validatorFacts.map((f) => f.subject),
        { select: { location: true, arguments: true } },
      );

      const validatorCalls: ValidatorCallTarget[] = [];
      for (const [index, fact] of validatorFacts.entries()) {
        const row = callRows[index];
        const argRef = row?.arguments?.[0];
        if (!row?.location || !argRef) continue;
        validatorCalls.push({
          fact,
          location: row.location,
          argRef,
        });
      }
      if (validatorCalls.length === 0) {
        return;
      }

      const queryByHandle = new Map(
        queryFacts.map((qf) => [
          qf.subject.handleId,
          { fact: qf, shape: projectionToShape(qf.value) },
        ]),
      );

      const prop = await ctx.valuePropagation({
        propagation: "value",
        includeMemberAccess: true,
        from: queryFacts.map((qf) => qf.subject),
        to: validatorCalls.map((c) => c.argRef),
      });

      const matchesByArg = new Map<string, MatchedRowSource[]>();
      for (const row of prop.results) {
        if (!row.reachable) continue;
        const queryEntry = queryByHandle.get(row.from.handleId);
        if (!queryEntry) continue;

        for (const path of row.paths) {
          const retained = resolveRetainedObjectFields(queryEntry.shape, path);
          if (!retained) continue;
          const relationName =
            path.sourcePath.length > 0 ? path.sourcePath.join(".") : undefined;
          const relationInfo =
            path.sourcePath.length > 0
              ? resolveNestedRelation(queryEntry.fact.value, path.sourcePath)
              : undefined;
          const list = matchesByArg.get(row.to.handleId) ?? [];
          list.push({
            queryFact: queryEntry.fact,
            path,
            ...(relationName !== undefined ? { relationName } : {}),
            ...(relationInfo !== undefined ? { relationInfo } : {}),
            availableKeys: new Set(retained.fields),
            omittedKeys: new Set(retained.omittedFields),
            hasDynamicColumns: retained.hasDynamicFields,
          });
          matchesByArg.set(row.to.handleId, list);
        }
      }

      for (const call of validatorCalls) {
        const sources = matchesByArg.get(call.argRef.handleId) ?? [];
        if (sources.length === 0) {
          ctx.checkpoint(
            "validator-input-not-from-query",
            call.location,
            "exclude",
            () => ({
              ...(call.fact.value.schemaName !== undefined
                ? { schemaName: call.fact.value.schemaName }
                : {}),
              ...(call.fact.value.validatorMethod !== undefined
                ? { validatorMethod: call.fact.value.validatorMethod }
                : {}),
            }),
          );
          continue;
        }

        const requiredFields = call.fact.value.requiredFields;
        const schemaLabel = call.fact.value.schemaName ?? "schema";
        const methodLabel = call.fact.value.validatorMethod ?? "parse";

        let reportedForCall = false;
        for (const source of sources) {
          const missingAll = requiredFields
            .filter((field) => !source.availableKeys.has(field))
            .toSorted(compareCodepoint);

          if (missingAll.length === 0) {
            ctx.checkpoint(
              "row-projection-satisfied",
              call.location,
              "pass",
              () => ({
                schemaName: schemaLabel,
                validatorMethod: methodLabel,
                ...(source.queryFact.value.tableName !== undefined
                  ? { tableName: source.queryFact.value.tableName }
                  : {}),
                ...(source.relationName !== undefined
                  ? { relationName: source.relationName }
                  : {}),
                requiredFields: [...requiredFields],
                availableColumns: [...source.availableKeys].toSorted(
                  compareCodepoint,
                ),
              }),
            );
            continue;
          }

          const definiteMissing = source.hasDynamicColumns
            ? missingAll.filter((field) => source.omittedKeys.has(field))
            : missingAll;

          if (definiteMissing.length === 0) {
            ctx.checkpoint(
              "dynamic-query-projection-gap",
              call.location,
              "exclude",
              () => ({
                schemaName: schemaLabel,
                validatorMethod: methodLabel,
                undeterminedFields: missingAll,
              }),
            );
            continue;
          }

          reportedForCall = true;
          const fieldEvidence = definiteMissing.flatMap(
            (field) => call.fact.value.fields[field]?.evidence ?? [],
          );
          const sourceBasis: readonly DiagnosticBasis[] = source.relationInfo
            ?.evidence
            ? source.relationInfo.evidence
            : [source.queryFact];
          const fieldClause =
            definiteMissing.length === 1
              ? `required validator field "${definiteMissing[0]!}"`
              : `required validator fields: ${definiteMissing.join(", ")}`;
          const sourceLabel = source.relationName
            ? `${source.queryFact.value.tableName ?? "query"}.${source.relationName}`
            : (source.queryFact.value.tableName ?? "query");
          const queryLocation = queryLocationByHandle.get(
            source.queryFact.subject.handleId,
          );
          // Fact handles change across sessions; the source span remains stable and distinguishes query origins.
          const queryPosition = queryLocation
            ? `${queryLocation.file}:${queryLocation.start}:${queryLocation.end}`
            : "unknown-query-position";

          ctx.report({
            at: call.location,
            findingKey: `${schemaLabel}.${methodLabel}:${queryPosition}:${source.queryFact.value.tableName ?? ""}:${source.relationName ?? ""}:${definiteMissing.join(",")}`,
            message: `Query row from "${sourceLabel}" passed to ${schemaLabel}.${methodLabel}() is missing ${fieldClause}.`,
            basis: [...sourceBasis, source.path, call.fact, ...fieldEvidence],
          });
        }

        if (!reportedForCall && requiredFields.length === 0) {
          ctx.checkpoint(
            "row-projection-satisfied",
            call.location,
            "pass",
            () => ({
              schemaName: schemaLabel,
              validatorMethod: methodLabel,
            }),
          );
        }
      }
    },
  });
}

/** Default rule checking query row projections against downstream validator input requirements. */
export const rowProjectionSatisfiesValidatorRule: Rule =
  createRowProjectionSatisfiesValidatorRule();
