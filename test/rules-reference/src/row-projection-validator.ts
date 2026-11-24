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
  type DiagnosticLocation,
  type Evidence,
  type FactResult,
  type Rule,
  type RuleContext,
  type SyntaxRef,
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
  readonly relationName?: string;
  readonly availableKeys: ReadonlySet<string>;
  readonly omittedKeys: ReadonlySet<string>;
  readonly hasDynamicColumns: boolean;
  readonly sourceEvidence: readonly Evidence[];
  readonly propagationEvidence: readonly Evidence[];
};

function compareCodepoint(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

function dedupeEvidence(items: readonly Evidence[]): readonly Evidence[] {
  const seen = new Set<string>();
  const out: Evidence[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function stripQuotes(raw: string): string {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

async function resolveRestOmittedKeysForSteps(
  ctx: RuleContext,
  steps: readonly {
    readonly kind: string;
    readonly description: string;
    readonly fromLocation: DiagnosticLocation;
    readonly toLocation: DiagnosticLocation;
  }[],
  varDeclsByFile: Map<
    string,
    readonly {
      readonly location: DiagnosticLocation;
      readonly initializer?: SyntaxRef;
      readonly text: string;
    }[]
  >,
  omittedKeysCache: Map<string, ReadonlySet<string>>,
): Promise<ReadonlySet<string>> {
  const omitted = new Set<string>();
  for (const step of steps) {
    if (step.kind !== "restDestructure") continue;

    // 1. Direct `(omitting a, b)` description if emitted on the BindingElement step
    const descMatch = /\(omitting\s+([^)]+)\)\s*$/u.exec(step.description);
    if (descMatch?.[1]) {
      for (const part of descMatch[1].split(",")) {
        const key = part.trim();
        if (key.length > 0) omitted.add(key);
      }
      continue;
    }

    // 2. Inspect enclosing VariableDeclaration's ObjectBindingPattern at step.fromLocation
    const cacheKey = `${step.fromLocation.file}:${step.fromLocation.start}:${step.fromLocation.end}`;
    const cached = omittedKeysCache.get(cacheKey);
    if (cached) {
      for (const k of cached) omitted.add(k);
      continue;
    }

    const foundKeys = new Set<string>();
    let fileVarDecls = varDeclsByFile.get(step.fromLocation.file);
    if (!fileVarDecls) {
      fileVarDecls = await ctx.findSyntax({
        files: [step.fromLocation.file],
        kinds: ["VariableDeclaration"],
      });
      varDeclsByFile.set(step.fromLocation.file, fileVarDecls);
    }

    // Pick the innermost VariableDeclaration whose span contains step.fromLocation
    const enclosingDecl = fileVarDecls
      .filter(
        (d) =>
          d.location.start <= step.fromLocation.start &&
          d.location.end >= step.fromLocation.end,
      )
      .toSorted(
        (a, b) =>
          a.location.end -
          a.location.start -
          (b.location.end - b.location.start),
      )[0];

    if (enclosingDecl) {
      const innerNodes = await ctx.findSyntax({
        range: {
          file: enclosingDecl.location.file,
          start: enclosingDecl.location.start,
          end: step.fromLocation.start,
          match: "within",
        },
      });
      const bindingPattern = innerNodes.find(
        (n) => n.kind === "ObjectBindingPattern",
      );
      if (bindingPattern) {
        const elements = innerNodes
          .filter(
            (n) =>
              n.kind === "BindingElement" &&
              n.location.start >= bindingPattern.location.start &&
              n.location.end <= bindingPattern.location.end,
          )
          .toSorted((a, b) => a.location.start - b.location.start);

        // Keep only direct BindingElements (not nested inside another ObjectBindingPattern)
        let cursorEnd = -1;
        for (const elem of elements) {
          if (elem.location.start < cursorEnd) continue;
          cursorEnd = elem.location.end;
          if (elem.text.trimStart().startsWith("...")) continue;

          // First child Identifier/StringLiteral inside BindingElement is the property key
          const keyNode = innerNodes
            .filter(
              (n) =>
                n.location.start >= elem.location.start &&
                n.location.end <= elem.location.end &&
                (n.kind === "Identifier" ||
                  n.kind === "StringLiteral" ||
                  n.kind === "NumericLiteral" ||
                  n.kind === "NoSubstitutionTemplateLiteral"),
            )
            .toSorted((a, b) => a.location.start - b.location.start)[0];
          if (keyNode) {
            foundKeys.add(stripQuotes(keyNode.text));
          }
        }
      }
    }

    omittedKeysCache.set(cacheKey, foundKeys);
    for (const k of foundKeys) omitted.add(k);
  }
  return omitted;
}

async function collectRelationMatches(
  ctx: RuleContext,
  queryFactsWithRelations: readonly QueryFact[],
  validatorCalls: readonly ValidatorCallTarget[],
  varDeclsByFile: Map<
    string,
    readonly {
      readonly location: DiagnosticLocation;
      readonly initializer?: SyntaxRef;
      readonly text: string;
    }[]
  >,
  omittedKeysCache: Map<string, ReadonlySet<string>>,
): Promise<Map<string, MatchedRowSource[]>> {
  const matchesByArg = new Map<string, MatchedRowSource[]>();
  if (queryFactsWithRelations.length === 0 || validatorCalls.length === 0) {
    return matchesByArg;
  }

  const allRelationNames = new Set<string>();
  for (const qf of queryFactsWithRelations) {
    for (const relName of Object.keys(qf.value.relations)) {
      allRelationNames.add(relName);
    }
  }
  if (allRelationNames.size === 0) {
    return matchesByArg;
  }

  const queryByHandle = new Map(
    queryFactsWithRelations.map((qf) => [qf.subject.handleId, qf]),
  );
  const querySubjects = queryFactsWithRelations.map((qf) => qf.subject);
  const validatorArgRefs = validatorCalls.map((c) => c.argRef);

  // 1. Property access path: e.g. `safeParse(_page.workspace)` or `const ws = _page.workspace; safeParse(ws)`
  const propAccessNodes = await ctx.findSyntax({
    kinds: ["PropertyAccessExpression"],
  });
  const candidatePropAccesses = propAccessNodes.filter((node) => {
    for (const relName of allRelationNames) {
      if (node.text.endsWith(`.${relName}`)) {
        return true;
      }
    }
    return false;
  });

  if (candidatePropAccesses.length > 0) {
    const nameRefs = candidatePropAccesses
      .map((n) => n.name)
      .filter((r): r is SyntaxRef => r !== undefined);
    const nameRows =
      nameRefs.length > 0
        ? await ctx.syntaxOf(nameRefs, { select: { text: true } })
        : [];
    const nameByHandle = new Map<string, string>();
    for (const [idx, row] of nameRows.entries()) {
      if (row.text !== null) {
        nameByHandle.set(nameRefs[idx]!.handleId, row.text);
      }
    }

    const filteredProps: {
      readonly propRef: SyntaxRef;
      readonly baseRef: SyntaxRef;
      readonly relName: string;
      readonly propLocation: DiagnosticLocation;
    }[] = [];

    for (const node of candidatePropAccesses) {
      if (!node.expression || !node.name) continue;
      const propName = nameByHandle.get(node.name.handleId);
      if (!propName || !allRelationNames.has(propName)) continue;
      filteredProps.push({
        propRef: node.ref,
        baseRef: node.expression,
        relName: propName,
        propLocation: node.location,
      });
    }

    if (filteredProps.length > 0) {
      const baseProp = await ctx.valuePropagation({
        propagation: "value",
        from: querySubjects,
        to: filteredProps.map((p) => p.baseRef),
      });
      const propToArg = await ctx.valuePropagation({
        propagation: "value",
        from: filteredProps.map((p) => p.propRef),
        to: validatorArgRefs,
      });

      const baseReachableByTo = new Map<
        string,
        {
          readonly queryFact: QueryFact;
          readonly baseEvidence: readonly Evidence[];
        }[]
      >();
      for (const row of baseProp.results) {
        if (!row.reachable) continue;
        const qf = queryByHandle.get(row.from.handleId);
        if (!qf) continue;
        const list = baseReachableByTo.get(row.to.handleId) ?? [];
        list.push({ queryFact: qf, baseEvidence: row.evidence });
        baseReachableByTo.set(row.to.handleId, list);
      }

      const propByHandle = new Map(
        filteredProps.map((p) => [p.propRef.handleId, p]),
      );

      for (const row of propToArg.results) {
        if (!row.reachable) continue;
        const propInfo = propByHandle.get(row.from.handleId);
        if (!propInfo) continue;
        const baseMatches = baseReachableByTo.get(propInfo.baseRef.handleId);
        if (!baseMatches || baseMatches.length === 0) continue;

        for (const baseMatch of baseMatches) {
          const relInfo: QueryRowNestedRelationInfo | undefined =
            baseMatch.queryFact.value.relations[propInfo.relName];
          if (!relInfo) continue;

          for (const path of row.paths.length > 0
            ? row.paths
            : [{ steps: [], evidence: row.evidence }]) {
            const omittedKeys = await resolveRestOmittedKeysForSteps(
              ctx,
              path.steps,
              varDeclsByFile,
              omittedKeysCache,
            );
            const availableKeys = new Set(
              relInfo.columns.filter((col) => !omittedKeys.has(col)),
            );
            const list = matchesByArg.get(row.to.handleId) ?? [];
            list.push({
              queryFact: baseMatch.queryFact,
              relationName: propInfo.relName,
              availableKeys,
              omittedKeys,
              hasDynamicColumns: relInfo.hasDynamicColumns,
              sourceEvidence: relInfo.evidence ?? baseMatch.queryFact.evidence,
              propagationEvidence: dedupeEvidence([
                ...baseMatch.baseEvidence,
                {
                  kind: "source",
                  message: `Accessed nested relation ".${propInfo.relName}"`,
                  at: propInfo.propLocation,
                },
                ...path.evidence,
              ]),
            });
            matchesByArg.set(row.to.handleId, list);
          }
        }
      }
    }
  }

  // 2. Object destructuring of a relation: e.g. `const { workspace: ws } = _page; safeParse(ws)`
  const varDecls = await ctx.findSyntax({ kinds: ["VariableDeclaration"] });
  const candidateDestructures = varDecls.filter((decl) => {
    if (!decl.initializer || !decl.text.includes("{")) return false;
    for (const relName of allRelationNames) {
      if (decl.text.includes(relName)) return true;
    }
    return false;
  });

  if (candidateDestructures.length > 0) {
    const initProp = await ctx.valuePropagation({
      propagation: "value",
      from: querySubjects,
      to: candidateDestructures.map((d) => d.initializer!),
    });

    const reachableDeclTargets: {
      readonly queryFact: QueryFact;
      readonly relName: string;
      readonly targetRef: SyntaxRef;
      readonly targetLoc: DiagnosticLocation;
      readonly baseEvidence: readonly Evidence[];
    }[] = [];

    for (const decl of candidateDestructures) {
      const initRows = initProp.results.filter(
        (r) => r.reachable && r.to.handleId === decl.initializer!.handleId,
      );
      if (initRows.length === 0) continue;

      const innerNodes = await ctx.findSyntax({
        range: {
          file: decl.location.file,
          start: decl.location.start,
          end: decl.location.end,
          match: "within",
        },
      });
      const bindingPattern = innerNodes.find(
        (n) => n.kind === "ObjectBindingPattern",
      );
      if (!bindingPattern) continue;
      const bindingElements = innerNodes.filter(
        (n) =>
          n.kind === "BindingElement" &&
          n.location.start >= bindingPattern.location.start &&
          n.location.end <= bindingPattern.location.end &&
          !n.text.trimStart().startsWith("..."),
      );
      for (const initRow of initRows) {
        const qf = queryByHandle.get(initRow.from.handleId);
        if (!qf) continue;
        for (const relName of Object.keys(qf.value.relations)) {
          const matchedElem = bindingElements.find((elem) => {
            const elemIds = innerNodes
              .filter(
                (n) =>
                  n.kind === "Identifier" &&
                  n.location.start >= elem.location.start &&
                  n.location.end <= elem.location.end,
              )
              .toSorted((a, b) => a.location.start - b.location.start);
            return elemIds[0]?.text === relName;
          });
          if (!matchedElem) continue;
          const elemIds = innerNodes
            .filter(
              (n) =>
                n.kind === "Identifier" &&
                n.location.start >= matchedElem.location.start &&
                n.location.end <= matchedElem.location.end,
            )
            .toSorted((a, b) => a.location.start - b.location.start);
          // Bound variable identifier is the last identifier before any default initializer (`name` in `{ prop: name }`, or `prop` in `{ prop }`)
          const boundTarget = elemIds[elemIds.length - 1] ?? matchedElem;
          reachableDeclTargets.push({
            queryFact: qf,
            relName,
            targetRef: boundTarget.ref,
            targetLoc: boundTarget.location,
            baseEvidence: initRow.evidence,
          });
        }
      }
    }

    if (reachableDeclTargets.length > 0) {
      const destructToArg = await ctx.valuePropagation({
        propagation: "value",
        from: reachableDeclTargets.map((t) => t.targetRef),
        to: validatorArgRefs,
      });

      for (const row of destructToArg.results) {
        if (!row.reachable) continue;
        const target = reachableDeclTargets.find(
          (t) => t.targetRef.handleId === row.from.handleId,
        );
        if (!target) continue;
        const relInfo = target.queryFact.value.relations[target.relName];
        if (!relInfo) continue;

        for (const path of row.paths.length > 0
          ? row.paths
          : [{ steps: [], evidence: row.evidence }]) {
          const omittedKeys = await resolveRestOmittedKeysForSteps(
            ctx,
            path.steps,
            varDeclsByFile,
            omittedKeysCache,
          );
          const availableKeys = new Set(
            relInfo.columns.filter((col) => !omittedKeys.has(col)),
          );
          const list = matchesByArg.get(row.to.handleId) ?? [];
          list.push({
            queryFact: target.queryFact,
            relationName: target.relName,
            availableKeys,
            omittedKeys,
            hasDynamicColumns: relInfo.hasDynamicColumns,
            sourceEvidence: relInfo.evidence ?? target.queryFact.evidence,
            propagationEvidence: dedupeEvidence([
              ...target.baseEvidence,
              {
                kind: "source",
                message: `Destructured nested relation "${target.relName}"`,
                at: target.targetLoc,
              },
              ...path.evidence,
            ]),
          });
          matchesByArg.set(row.to.handleId, list);
        }
      }
    }
  }

  return matchesByArg;
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
        queryFacts.map((qf) => [qf.subject.handleId, qf]),
      );

      const directProp = await ctx.valuePropagation({
        propagation: "value",
        from: queryFacts.map((qf) => qf.subject),
        to: validatorCalls.map((c) => c.argRef),
      });

      const varDeclsByFile = new Map<
        string,
        readonly {
          readonly location: DiagnosticLocation;
          readonly initializer?: SyntaxRef;
          readonly text: string;
        }[]
      >();
      const omittedKeysCache = new Map<string, ReadonlySet<string>>();

      const matchesByArg = new Map<string, MatchedRowSource[]>();
      for (const row of directProp.results) {
        if (!row.reachable) continue;
        const queryFact = queryByHandle.get(row.from.handleId);
        if (!queryFact) continue;

        const paths =
          row.paths.length > 0
            ? row.paths
            : [{ steps: [], evidence: row.evidence }];

        for (const path of paths) {
          const omittedKeys = await resolveRestOmittedKeysForSteps(
            ctx,
            path.steps,
            varDeclsByFile,
            omittedKeysCache,
          );
          const availableKeys = new Set(
            queryFact.value.projectedColumns.filter(
              (col) => !omittedKeys.has(col),
            ),
          );
          const list = matchesByArg.get(row.to.handleId) ?? [];
          list.push({
            queryFact,
            availableKeys,
            omittedKeys,
            hasDynamicColumns: queryFact.value.hasDynamicColumns,
            sourceEvidence: queryFact.evidence,
            propagationEvidence: path.evidence,
          });
          matchesByArg.set(row.to.handleId, list);
        }
      }

      const queryFactsWithRelations = queryFacts.filter(
        (qf) => Object.keys(qf.value.relations).length > 0,
      );
      if (queryFactsWithRelations.length > 0) {
        const relationMatches = await collectRelationMatches(
          ctx,
          queryFactsWithRelations,
          validatorCalls,
          varDeclsByFile,
          omittedKeysCache,
        );
        for (const [argHandle, relList] of relationMatches.entries()) {
          const existing = matchesByArg.get(argHandle) ?? [];
          matchesByArg.set(argHandle, [...existing, ...relList]);
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
          const evidence = dedupeEvidence([
            ...source.sourceEvidence,
            ...source.propagationEvidence,
            ...call.fact.evidence,
            ...fieldEvidence,
          ]);
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
            evidence,
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
