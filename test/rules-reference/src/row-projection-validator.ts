import type {
  DiagnosticBasis,
  DiagnosticLocation,
  ObjectFieldShape,
  Rule,
  SyntaxRef,
  ValuePropagationPath,
} from "@boringparts/verule";
import { defineRule, resolveRetainedObjectFields } from "@boringparts/verule";
import {
  drizzleQueryProjection,
  drizzleZodValidator,
  type QueryRowProjectionExtractor,
  type QueryRowProjectionResult,
  type QueryRowRelationInfo,
} from "@tssae/drizzle";
import type {
  ValidatorFieldExtractor,
  ValidatorInputFieldsResult,
} from "@tssae/zod";

export type RowProjectionValidatorRuleOptions = {
  readonly id?: string;
  readonly description?: string;
  readonly queryProjection?: QueryRowProjectionExtractor;
  readonly validator?: ValidatorFieldExtractor;
};

type ValidatorCallTarget = {
  readonly validation: ValidatorInputFieldsResult;
  readonly location: DiagnosticLocation;
  readonly argRef: SyntaxRef;
};

type MatchedRowSource = {
  readonly queryProjection: QueryRowProjectionResult;
  readonly path: ValuePropagationPath;
  readonly relationName?: string;
  readonly relationInfo?: QueryRowRelationInfo;
  readonly availableKeys: ReadonlySet<string>;
  readonly omittedKeys: ReadonlySet<string>;
  readonly hasDynamicColumns: boolean;
};

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function relationToShape(rel: QueryRowRelationInfo): ObjectFieldShape {
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

function projectionToShape(value: QueryRowProjectionResult): ObjectFieldShape {
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
  value: QueryRowProjectionResult,
  sourcePath: readonly string[],
): QueryRowRelationInfo | undefined {
  let current: QueryRowRelationInfo | undefined;
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
  const queryExtractor = options.queryProjection ?? drizzleQueryProjection;
  const validatorExtractor = options.validator ?? drizzleZodValidator;

  return defineRule({
    id: options.id ?? "row-projection-satisfies-validator",
    description:
      options.description ??
      "Verify that statically projected database query rows satisfy all required input fields of downstream validators.",
    run: async (ctx) => {
      const [queryProjections, validatorInputs] = await Promise.all([
        queryExtractor.extractRowProjections(ctx),
        validatorExtractor.extractInputFields(ctx, { scope: "calls" }),
      ]);
      if (queryProjections.length === 0 || validatorInputs.length === 0) {
        return;
      }

      const queryRows = await ctx.syntaxOf(
        queryProjections.map((item) => item.target),
        { select: { location: true } },
      );
      const queryLocationByHandle = new Map<string, DiagnosticLocation>();
      for (const [index, row] of queryRows.entries()) {
        const location = row?.location;
        if (location) {
          queryLocationByHandle.set(
            queryProjections[index]!.target.handleId,
            location,
          );
        }
      }

      const callRows = await ctx.syntaxOf(
        validatorInputs.map((item) => item.target),
        { select: { location: true, arguments: true } },
      );

      const validatorCalls: ValidatorCallTarget[] = [];
      for (const [index, validation] of validatorInputs.entries()) {
        const row = callRows[index];
        const argRef = row?.arguments?.[0];
        if (!row?.location || !argRef) continue;
        validatorCalls.push({
          validation,
          location: row.location,
          argRef,
        });
      }
      if (validatorCalls.length === 0) {
        return;
      }

      const queryByHandle = new Map(
        queryProjections.map((qp) => [
          qp.target.handleId,
          { queryProjection: qp, shape: projectionToShape(qp) },
        ]),
      );

      const prop = await ctx.valuePropagation({
        propagation: "value",
        includeMemberAccess: true,
        from: queryProjections.map((qp) => qp.target),
        to: validatorCalls.map((c) => c.argRef),
      });

      const matchesByArg = new Map<string, MatchedRowSource[]>();
      for (const row of prop.results) {
        if (row.status !== "proved") continue;
        const queryEntry = queryByHandle.get(row.from.handleId);
        if (!queryEntry) continue;

        for (const path of row.paths) {
          const retained = resolveRetainedObjectFields(queryEntry.shape, path);
          if (!retained) continue;
          const relationName =
            path.sourcePath.length > 0 ? path.sourcePath.join(".") : undefined;
          const relationInfo =
            path.sourcePath.length > 0
              ? resolveNestedRelation(
                  queryEntry.queryProjection,
                  path.sourcePath,
                )
              : undefined;
          const list = matchesByArg.get(row.to.handleId) ?? [];
          list.push({
            queryProjection: queryEntry.queryProjection,
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
              ...(call.validation.schemaName !== undefined
                ? { schemaName: call.validation.schemaName }
                : {}),
              ...(call.validation.validatorMethod !== undefined
                ? { validatorMethod: call.validation.validatorMethod }
                : {}),
            }),
          );
          continue;
        }

        const requiredFields = call.validation.requiredFields;
        const schemaLabel = call.validation.schemaName ?? "schema";
        const methodLabel = call.validation.validatorMethod ?? "parse";

        let reportedForCall = false;
        for (const source of sources) {
          const missingAll = requiredFields
            .filter((field) => !source.availableKeys.has(field))
            .toSorted(compareCodepoint);

          if (missingAll.length === 0) {
            if (call.validation.gaps.length > 0) {
              ctx.recordGaps(call.validation.gaps, {
                relatedLocation: call.location,
              });
            } else {
              ctx.checkpoint(
                "row-projection-satisfied",
                call.location,
                "pass",
                () => ({
                  schemaName: schemaLabel,
                  validatorMethod: methodLabel,
                  ...(source.queryProjection.tableName !== undefined
                    ? { tableName: source.queryProjection.tableName }
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
            }
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
            (field) => call.validation.fields[field]?.evidence ?? [],
          );
          const sourceBasis: readonly DiagnosticBasis[] = source.relationInfo
            ?.evidence
            ? source.relationInfo.evidence
            : [source.queryProjection];
          const fieldClause =
            definiteMissing.length === 1
              ? `required validator field "${definiteMissing[0]!}"`
              : `required validator fields: ${definiteMissing.join(", ")}`;
          const sourceLabel = source.relationName
            ? `${source.queryProjection.tableName ?? "query"}.${source.relationName}`
            : (source.queryProjection.tableName ?? "query");
          const queryLocation = queryLocationByHandle.get(
            source.queryProjection.target.handleId,
          );
          // Handles change across sessions; the source span remains stable and distinguishes query origins.
          const queryPosition = queryLocation
            ? `${queryLocation.file}:${queryLocation.start}:${queryLocation.end}`
            : "unknown-query-position";

          ctx.report({
            at: call.location,
            findingKey: `${schemaLabel}.${methodLabel}:${queryPosition}:${source.queryProjection.tableName ?? ""}:${source.relationName ?? ""}:${definiteMissing.join(",")}`,
            message: `Query row from "${sourceLabel}" passed to ${schemaLabel}.${methodLabel}() is missing ${fieldClause}.`,
            basis: [
              ...sourceBasis,
              source.path,
              call.validation,
              ...fieldEvidence,
            ],
          });
        }

        if (
          !reportedForCall &&
          requiredFields.length === 0 &&
          call.validation.gaps.length === 0
        ) {
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
