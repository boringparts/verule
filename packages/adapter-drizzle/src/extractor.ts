import type {
  AdapterContext,
  DiagnosticLocation,
  Evidence,
  FactContribution,
  FactExtractionRequest,
  Gap,
  SyntaxNodeResult,
  SyntaxRef,
} from "@verule/sdk";

import {
  buildQueryRowProjectionValue,
  type QueryRowCardinality,
  type QueryRowColumnInfo,
  type QueryRowNestedRelationInfo,
  type QueryRowProjectionCondition,
  type QueryRowProjectionFactValue,
  type QueryRowSubjectKind,
} from "./facts.ts";

type SyntaxSnapshot = {
  readonly ref: SyntaxRef;
  readonly kind: string;
  readonly text: string;
  readonly location: DiagnosticLocation;
  readonly expression?: SyntaxRef | null;
  readonly arguments?: readonly SyntaxRef[];
  readonly name?: SyntaxRef | null;
  readonly initializer?: SyntaxRef | null;
  readonly body?: SyntaxRef | null;
};

type DeclInfo = {
  readonly name: string | null;
  readonly kind: string | null;
  readonly location: DiagnosticLocation | null;
  readonly syntax: SyntaxRef | null;
  readonly isExternal: boolean;
};

type TableColumnDef = {
  readonly tsName: string;
  readonly sqlName: string;
  readonly nullable: boolean;
  readonly location: DiagnosticLocation;
};

type ExtractedTable = {
  readonly declHandleId?: string;
  readonly tsVarName?: string;
  readonly sqlTableName?: string;
  readonly displayName: string;
  readonly location: DiagnosticLocation;
  readonly columns: Readonly<Record<string, TableColumnDef>>;
  readonly hasDynamicColumns: boolean;
  readonly gaps: readonly Gap[];
};

type RelationTargetInfo = {
  readonly relationName: string;
  readonly cardinality: QueryRowCardinality;
  readonly targetTable: ExtractedTable | null;
  readonly location: DiagnosticLocation;
};

const DRIZZLE_TABLE_BUILDERS = new Set<string>([
  "sqliteTable",
  "pgTable",
  "mysqlTable",
  "singlestoreTable",
]);

const SELECT_ENTRY_METHODS = new Set<string>([
  "select",
  "selectDistinct",
  "selectDistinctOn",
]);

const SELECT_CHAIN_METHODS = new Set<string>([
  "from",
  "where",
  "orderBy",
  "groupBy",
  "having",
  "limit",
  "offset",
  "leftJoin",
  "rightJoin",
  "innerJoin",
  "fullJoin",
  "crossJoin",
  "get",
  "all",
  "values",
  "execute",
  "prepare",
]);

const TRANSPARENT_EXPR_KINDS = new Set<string>([
  "ParenthesizedExpression",
  "AsExpression",
  "SatisfiesExpression",
  "TypeAssertionExpression",
  "NonNullExpression",
]);

function stripStringQuotes(raw: string): string {
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

function isDeclarationFile(file: string | null | undefined): boolean {
  if (!file) return false;
  return (
    file.endsWith(".d.ts") || file.endsWith(".d.mts") || file.endsWith(".d.cts")
  );
}

function isNodeModulesFile(file: string | null | undefined): boolean {
  if (!file) return false;
  return /(?:^|\/)node_modules\//u.test(file);
}

function canFollowDeclaration(decl: DeclInfo): decl is DeclInfo & {
  readonly syntax: SyntaxRef;
} {
  if (!decl.syntax) return false;
  if (isDeclarationFile(decl.location?.file)) return false;
  if (decl.isExternal && isNodeModulesFile(decl.location?.file)) {
    return false;
  }
  return true;
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

function dedupeGaps(items: readonly Gap[]): readonly Gap[] {
  const seen = new Set<string>();
  const out: Gap[] = [];
  for (const item of items) {
    const key = JSON.stringify(item);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(item);
    }
  }
  return out;
}

function selectDirectChildren(
  container: DiagnosticLocation,
  descendants: readonly SyntaxNodeResult[],
): readonly SyntaxSnapshot[] {
  const strictlyInside = descendants
    .filter(
      (node) =>
        node.location.file === container.file &&
        node.location.start >= container.start &&
        node.location.end <= container.end &&
        (node.location.start > container.start ||
          node.location.end < container.end),
    )
    .toSorted((a, b) => {
      if (a.location.start !== b.location.start) {
        return a.location.start - b.location.start;
      }
      return b.location.end - a.location.end;
    });

  const direct: SyntaxSnapshot[] = [];
  let cursorEnd = -1;
  for (const node of strictlyInside) {
    if (node.location.start >= cursorEnd) {
      direct.push(node);
      cursorEnd = node.location.end;
    }
  }
  return direct;
}

function locationKey(loc: DiagnosticLocation): string {
  return `${loc.file}:${loc.start}:${loc.end}`;
}

class DrizzleAstEvaluator {
  readonly #ctx: AdapterContext;
  readonly #syntaxCache = new Map<string, SyntaxSnapshot | null>();
  readonly #declCache = new Map<string, DeclInfo>();
  readonly #typeTextCache = new Map<string, string>();
  readonly #tableCache = new Map<string, Promise<ExtractedTable | null>>();
  #relationsIndexPromise: Promise<{
    readonly byTableHandle: Map<string, Map<string, RelationTargetInfo>>;
    readonly byTableName: Map<string, Map<string, RelationTargetInfo>>;
    readonly schemaTables: Map<string, ExtractedTable>;
    readonly allTables: ExtractedTable[];
  }> | null = null;

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
  }

  async getSyntax(ref: SyntaxRef): Promise<SyntaxSnapshot | null> {
    const cached = this.#syntaxCache.get(ref.handleId);
    if (cached !== undefined) return cached;
    const [row] = await this.#ctx.syntaxOf([ref], {
      select: {
        kind: true,
        text: true,
        location: true,
        expression: true,
        arguments: true,
        name: true,
        initializer: true,
        body: true,
      },
    });
    if (!row || !row.syntax || !row.kind || !row.location) {
      this.#syntaxCache.set(ref.handleId, null);
      return null;
    }
    const snap: SyntaxSnapshot = {
      ref: row.syntax,
      kind: row.kind,
      text: row.text ?? "",
      location: row.location,
      expression: row.expression,
      arguments: row.arguments,
      name: row.name,
      initializer: row.initializer,
      body: row.body,
    };
    this.#syntaxCache.set(ref.handleId, snap);
    this.#syntaxCache.set(row.syntax.handleId, snap);
    return snap;
  }

  async preloadSyntax(refs: readonly SyntaxRef[]): Promise<void> {
    const missing: SyntaxRef[] = [];
    const seen = new Set<string>();
    for (const ref of refs) {
      if (!this.#syntaxCache.has(ref.handleId) && !seen.has(ref.handleId)) {
        seen.add(ref.handleId);
        missing.push(ref);
      }
    }
    if (missing.length === 0) return;
    const rows = await this.#ctx.syntaxOf(missing, {
      select: {
        kind: true,
        text: true,
        location: true,
        expression: true,
        arguments: true,
        name: true,
        initializer: true,
        body: true,
      },
    });
    for (const [index, row] of rows.entries()) {
      const reqRef = missing[index]!;
      if (!row.syntax || !row.kind || !row.location) {
        this.#syntaxCache.set(reqRef.handleId, null);
        continue;
      }
      const snap: SyntaxSnapshot = {
        ref: row.syntax,
        kind: row.kind,
        text: row.text ?? "",
        location: row.location,
        expression: row.expression,
        arguments: row.arguments,
        name: row.name,
        initializer: row.initializer,
        body: row.body,
      };
      this.#syntaxCache.set(reqRef.handleId, snap);
      this.#syntaxCache.set(row.syntax.handleId, snap);
    }
  }

  seedSyntaxNodes(nodes: readonly SyntaxNodeResult[]): void {
    for (const node of nodes) {
      this.#syntaxCache.set(node.ref.handleId, node);
    }
  }

  async getDirectChildren(
    location: DiagnosticLocation,
  ): Promise<readonly SyntaxSnapshot[]> {
    const nodes = await this.#ctx.findSyntax({
      range: {
        file: location.file,
        start: location.start,
        end: location.end,
        match: "within",
      },
    });
    this.seedSyntaxNodes(nodes);
    return selectDirectChildren(location, nodes);
  }

  async resolveDecl(ref: SyntaxRef): Promise<DeclInfo> {
    const cached = this.#declCache.get(ref.handleId);
    if (cached !== undefined) return cached;
    const [row] = await this.#ctx.resolveDeclarations([ref], {
      select: {
        name: true,
        kind: true,
        location: true,
        syntax: true,
        isExternal: true,
      },
    });
    const info: DeclInfo = {
      name: row?.name ?? null,
      kind: row?.kind ?? null,
      location: row?.location ?? null,
      syntax: row?.syntax ?? null,
      isExternal: row?.isExternal ?? false,
    };
    this.#declCache.set(ref.handleId, info);
    return info;
  }

  async getTypeText(ref: SyntaxRef): Promise<string> {
    const cached = this.#typeTextCache.get(ref.handleId);
    if (cached !== undefined) return cached;
    const [res] = await this.#ctx.typeAt([ref]);
    const text = res?.typeText ?? "";
    this.#typeTextCache.set(ref.handleId, text);
    return text;
  }

  async unwrapExpression(ref: SyntaxRef): Promise<SyntaxSnapshot | null> {
    let current = await this.getSyntax(ref);
    const seen = new Set<string>();
    while (
      current &&
      TRANSPARENT_EXPR_KINDS.has(current.kind) &&
      current.expression &&
      !seen.has(current.ref.handleId)
    ) {
      seen.add(current.ref.handleId);
      current = await this.getSyntax(current.expression);
    }
    return current;
  }

  async resolvePropertyKey(
    nameRef: SyntaxRef,
    memberLocation: DiagnosticLocation,
  ): Promise<{ readonly key: string | null; readonly gap?: Gap }> {
    const nameSnap = await this.getSyntax(nameRef);
    if (!nameSnap) {
      return {
        key: null,
        gap: {
          kind: "dynamic-query-projection",
          message: "Property key in Drizzle projection could not be inspected.",
          at: memberLocation,
        },
      };
    }
    if (nameSnap.kind === "Identifier") {
      return { key: nameSnap.text };
    }
    if (
      nameSnap.kind === "StringLiteral" ||
      nameSnap.kind === "NumericLiteral" ||
      nameSnap.kind === "NoSubstitutionTemplateLiteral"
    ) {
      return { key: stripStringQuotes(nameSnap.text) };
    }
    if (nameSnap.kind === "ComputedPropertyName" && nameSnap.expression) {
      const inner = await this.unwrapExpression(nameSnap.expression);
      if (
        inner &&
        (inner.kind === "StringLiteral" ||
          inner.kind === "NumericLiteral" ||
          inner.kind === "NoSubstitutionTemplateLiteral")
      ) {
        return { key: stripStringQuotes(inner.text) };
      }
      return {
        key: null,
        gap: {
          kind: "dynamic-query-projection",
          message: `Computed property name "${nameSnap.text}" cannot be statically resolved.`,
          at: nameSnap.location,
        },
      };
    }
    return {
      key: null,
      gap: {
        kind: "dynamic-query-projection",
        message: `Dynamic property key "${nameSnap.text}" (${nameSnap.kind}) cannot be statically resolved.`,
        at: nameSnap.location,
      },
    };
  }

  async evaluateTableExpr(
    ref: SyntaxRef,
    visitedDecls: ReadonlySet<string> = new Set(),
  ): Promise<ExtractedTable | null> {
    const snap = await this.unwrapExpression(ref);
    if (!snap) return null;

    if (visitedDecls.size === 0) {
      const cached = this.#tableCache.get(snap.ref.handleId);
      if (cached) return cached;
    }

    const promise = this.#evaluateTableSnapshot(snap, visitedDecls);
    if (visitedDecls.size === 0) {
      this.#tableCache.set(snap.ref.handleId, promise);
    }
    return promise;
  }

  async #evaluateTableSnapshot(
    snap: SyntaxSnapshot,
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedTable | null> {
    if (snap.kind === "VariableDeclaration" && snap.initializer) {
      const table = await this.evaluateTableExpr(
        snap.initializer,
        new Set([...visitedDecls, snap.ref.handleId]),
      );
      if (table) {
        const nameSnap = snap.name ? await this.getSyntax(snap.name) : null;
        const varName = nameSnap?.text ?? table.displayName;
        return {
          ...table,
          declHandleId: snap.ref.handleId,
          tsVarName: varName,
          displayName: varName,
        };
      }
      return null;
    }

    if (snap.kind === "Identifier") {
      const decl = await this.resolveDecl(snap.ref);
      if (
        canFollowDeclaration(decl) &&
        !visitedDecls.has(decl.syntax.handleId)
      ) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.initializer) {
          const table = await this.evaluateTableExpr(
            declSnap.initializer,
            new Set([...visitedDecls, decl.syntax.handleId]),
          );
          if (table) {
            const varName = decl.name ?? snap.text;
            return {
              ...table,
              declHandleId: decl.syntax.handleId,
              tsVarName: varName,
              displayName: varName,
            };
          }
        }
      }
      return null;
    }

    if (snap.kind !== "CallExpression" || !snap.expression) {
      return null;
    }

    const callee = await this.unwrapExpression(snap.expression);
    if (!callee) return null;

    let isTableCall = false;
    if (callee.kind === "Identifier") {
      isTableCall = DRIZZLE_TABLE_BUILDERS.has(callee.text);
    } else if (callee.kind === "PropertyAccessExpression" && callee.name) {
      const propName = (await this.getSyntax(callee.name))?.text ?? "";
      isTableCall =
        DRIZZLE_TABLE_BUILDERS.has(propName) || propName === "table";
    } else if (callee.kind === "CallExpression" && callee.expression) {
      const innerCallee = await this.unwrapExpression(callee.expression);
      if (
        innerCallee?.kind === "Identifier" &&
        innerCallee.text.endsWith("TableCreator")
      ) {
        isTableCall = true;
      }
    }

    if (!isTableCall) {
      return null;
    }

    const args = snap.arguments ?? [];
    if (args.length < 2) return null;

    const nameArgSnap = await this.unwrapExpression(args[0]!);
    const sqlTableName =
      nameArgSnap &&
      (nameArgSnap.kind === "StringLiteral" ||
        nameArgSnap.kind === "NoSubstitutionTemplateLiteral")
        ? stripStringQuotes(nameArgSnap.text)
        : undefined;

    const colsArg = await this.unwrapExpression(args[1]!);
    if (!colsArg) return null;

    let colsObjSnap: SyntaxSnapshot | null = null;
    if (colsArg.kind === "ObjectLiteralExpression") {
      colsObjSnap = colsArg;
    } else if (
      (colsArg.kind === "ArrowFunction" ||
        colsArg.kind === "FunctionExpression") &&
      colsArg.body
    ) {
      const bodySnap = await this.unwrapExpression(colsArg.body);
      if (bodySnap?.kind === "ObjectLiteralExpression") {
        colsObjSnap = bodySnap;
      } else if (bodySnap?.kind === "Block") {
        const returns = await this.#ctx.findSyntax({
          kinds: ["ReturnStatement"],
          range: {
            file: bodySnap.location.file,
            start: bodySnap.location.start,
            end: bodySnap.location.end,
            match: "within",
          },
        });
        if (returns.length === 1 && returns[0]!.expression) {
          const retSnap = await this.unwrapExpression(returns[0]!.expression);
          if (retSnap?.kind === "ObjectLiteralExpression") {
            colsObjSnap = retSnap;
          }
        }
      }
    }

    if (!colsObjSnap) return null;

    const parsedCols = await this.#extractTableColumnsObject(
      colsObjSnap,
      visitedDecls,
    );
    return {
      ...(sqlTableName !== undefined ? { sqlTableName } : {}),
      displayName: sqlTableName ?? "table",
      location: snap.location,
      columns: parsedCols.columns,
      hasDynamicColumns: parsedCols.hasDynamicColumns,
      gaps: parsedCols.gaps,
    };
  }

  async #extractTableColumnsObject(
    objSnap: SyntaxSnapshot,
    visitedDecls: ReadonlySet<string>,
  ): Promise<{
    readonly columns: Readonly<Record<string, TableColumnDef>>;
    readonly hasDynamicColumns: boolean;
    readonly gaps: readonly Gap[];
  }> {
    const children = await this.getDirectChildren(objSnap.location);
    const preload: SyntaxRef[] = [];
    for (const child of children) {
      if (child.name) preload.push(child.name);
      if (child.initializer) preload.push(child.initializer);
      if (child.expression) preload.push(child.expression);
    }
    await this.preloadSyntax(preload);

    const columns: Record<string, TableColumnDef> = {};
    const gaps: Gap[] = [];
    let hasDynamicColumns = false;

    for (const child of children) {
      if (
        child.kind === "PropertyAssignment" &&
        child.name &&
        child.initializer
      ) {
        const keyRes = await this.resolvePropertyKey(
          child.name,
          child.location,
        );
        if (keyRes.key === null) {
          hasDynamicColumns = true;
          if (keyRes.gap) gaps.push(keyRes.gap);
          continue;
        }
        const meta = await this.#extractColumnChainMetadata(
          keyRes.key,
          child.initializer,
        );
        columns[keyRes.key] = {
          tsName: keyRes.key,
          sqlName: meta.sqlName,
          nullable: meta.nullable,
          location: child.location,
        };
      } else if (child.kind === "ShorthandPropertyAssignment") {
        const keyName = child.name
          ? ((await this.getSyntax(child.name))?.text ?? child.text)
          : child.text;
        const decl = await this.resolveDecl(child.ref);
        if (canFollowDeclaration(decl)) {
          const declSnap = await this.getSyntax(decl.syntax);
          if (declSnap?.initializer) {
            const meta = await this.#extractColumnChainMetadata(
              keyName,
              declSnap.initializer,
            );
            columns[keyName] = {
              tsName: keyName,
              sqlName: meta.sqlName,
              nullable: meta.nullable,
              location: child.location,
            };
            continue;
          }
        }
        columns[keyName] = {
          tsName: keyName,
          sqlName: keyName,
          nullable: true,
          location: child.location,
        };
      } else if (child.kind === "SpreadAssignment" && child.expression) {
        const spreadSnap = await this.unwrapExpression(child.expression);
        if (spreadSnap?.kind === "ObjectLiteralExpression") {
          const nested = await this.#extractTableColumnsObject(
            spreadSnap,
            visitedDecls,
          );
          Object.assign(columns, nested.columns);
          if (nested.hasDynamicColumns) hasDynamicColumns = true;
          gaps.push(...nested.gaps);
        } else if (spreadSnap?.kind === "Identifier") {
          const decl = await this.resolveDecl(spreadSnap.ref);
          if (
            canFollowDeclaration(decl) &&
            !visitedDecls.has(decl.syntax.handleId)
          ) {
            const declSnap = await this.getSyntax(decl.syntax);
            if (declSnap?.initializer) {
              const initSnap = await this.unwrapExpression(
                declSnap.initializer,
              );
              if (initSnap?.kind === "ObjectLiteralExpression") {
                const nested = await this.#extractTableColumnsObject(
                  initSnap,
                  new Set([...visitedDecls, decl.syntax.handleId]),
                );
                Object.assign(columns, nested.columns);
                if (nested.hasDynamicColumns) hasDynamicColumns = true;
                gaps.push(...nested.gaps);
                continue;
              }
            }
          }
          hasDynamicColumns = true;
          gaps.push({
            kind: "dynamic-table-columns",
            message: `Spread "${child.text}" in Drizzle table definition cannot be statically resolved.`,
            at: child.location,
          });
        } else {
          hasDynamicColumns = true;
          gaps.push({
            kind: "dynamic-table-columns",
            message: `Spread "${child.text}" in Drizzle table definition cannot be statically resolved.`,
            at: child.location,
          });
        }
      } else {
        hasDynamicColumns = true;
        gaps.push({
          kind: "dynamic-table-columns",
          message: `Unsupported dynamic member "${child.text}" (${child.kind}) in Drizzle table definition.`,
          at: child.location,
        });
      }
    }

    return { columns, hasDynamicColumns, gaps };
  }

  async #extractColumnChainMetadata(
    tsName: string,
    exprRef: SyntaxRef,
  ): Promise<{ readonly sqlName: string; readonly nullable: boolean }> {
    let current = await this.unwrapExpression(exprRef);
    const seen = new Set<string>();
    let nullable = true;
    let sqlName = tsName;

    while (current && !seen.has(current.ref.handleId)) {
      seen.add(current.ref.handleId);
      if (current.kind !== "CallExpression" || !current.expression) {
        break;
      }
      const callee = await this.unwrapExpression(current.expression);
      if (!callee) break;

      if (
        callee.kind === "PropertyAccessExpression" &&
        callee.expression &&
        callee.name
      ) {
        const methodName = (await this.getSyntax(callee.name))?.text ?? "";
        if (methodName === "notNull" || methodName === "primaryKey") {
          nullable = false;
          current = await this.unwrapExpression(callee.expression);
          continue;
        }
        const receiverSnap = await this.unwrapExpression(callee.expression);
        if (receiverSnap?.kind === "CallExpression") {
          current = receiverSnap;
          continue;
        }
        const args = current.arguments ?? [];
        if (args[0]) {
          const firstArg = await this.unwrapExpression(args[0]);
          if (
            firstArg &&
            (firstArg.kind === "StringLiteral" ||
              firstArg.kind === "NoSubstitutionTemplateLiteral")
          ) {
            sqlName = stripStringQuotes(firstArg.text);
          }
        }
        break;
      }

      if (callee.kind === "Identifier") {
        const args = current.arguments ?? [];
        if (args[0]) {
          const firstArg = await this.unwrapExpression(args[0]);
          if (
            firstArg &&
            (firstArg.kind === "StringLiteral" ||
              firstArg.kind === "NoSubstitutionTemplateLiteral")
          ) {
            sqlName = stripStringQuotes(firstArg.text);
          }
        }
        break;
      }

      break;
    }

    return { sqlName, nullable };
  }

  async ensureRelationsIndex(
    allCalls?: readonly SyntaxNodeResult[],
    allVarDecls?: readonly SyntaxNodeResult[],
  ) {
    if (this.#relationsIndexPromise) {
      return this.#relationsIndexPromise;
    }
    this.#relationsIndexPromise = this.#buildRelationsIndex(
      allCalls,
      allVarDecls,
    );
    return this.#relationsIndexPromise;
  }

  async #buildRelationsIndex(
    existingCalls?: readonly SyntaxNodeResult[],
    existingVarDecls?: readonly SyntaxNodeResult[],
  ) {
    const nodes =
      existingCalls && existingVarDecls
        ? [...existingCalls, ...existingVarDecls]
        : await this.#ctx.findSyntax({
            kinds: ["CallExpression", "VariableDeclaration"],
          });
    if (!existingCalls || !existingVarDecls) {
      this.seedSyntaxNodes(nodes);
    }

    const calls =
      existingCalls ?? nodes.filter((n) => n.kind === "CallExpression");
    const varDecls =
      existingVarDecls ?? nodes.filter((n) => n.kind === "VariableDeclaration");

    const byTableHandle = new Map<string, Map<string, RelationTargetInfo>>();
    const byTableName = new Map<string, Map<string, RelationTargetInfo>>();
    const schemaTables = new Map<string, ExtractedTable>();
    const allTables: ExtractedTable[] = [];

    for (const decl of varDecls) {
      if (!decl.initializer) continue;
      const initSnap = await this.unwrapExpression(decl.initializer);
      if (initSnap?.kind === "CallExpression") {
        const table = await this.evaluateTableExpr(decl.ref);
        if (table) {
          allTables.push(table);
        }
      }
    }

    for (const call of calls) {
      if (!call.expression) continue;
      const callee = await this.unwrapExpression(call.expression);
      if (!callee) continue;

      let calleeName = "";
      if (callee.kind === "Identifier") {
        calleeName = callee.text;
      } else if (callee.kind === "PropertyAccessExpression" && callee.name) {
        calleeName = (await this.getSyntax(callee.name))?.text ?? "";
      }

      if (calleeName === "relations") {
        const args = call.arguments ?? [];
        if (args.length < 2) continue;
        const sourceTable = await this.evaluateTableExpr(args[0]!);
        if (!sourceTable) continue;

        const cbSnap = await this.unwrapExpression(args[1]!);
        if (
          !cbSnap ||
          (cbSnap.kind !== "ArrowFunction" &&
            cbSnap.kind !== "FunctionExpression") ||
          !cbSnap.body
        ) {
          continue;
        }
        const bodySnap = await this.unwrapExpression(cbSnap.body);
        let objSnap: SyntaxSnapshot | null = null;
        if (bodySnap?.kind === "ObjectLiteralExpression") {
          objSnap = bodySnap;
        } else if (bodySnap?.kind === "Block") {
          const returns = await this.#ctx.findSyntax({
            kinds: ["ReturnStatement"],
            range: {
              file: bodySnap.location.file,
              start: bodySnap.location.start,
              end: bodySnap.location.end,
              match: "within",
            },
          });
          if (returns.length === 1 && returns[0]!.expression) {
            const ret = await this.unwrapExpression(returns[0]!.expression);
            if (ret?.kind === "ObjectLiteralExpression") {
              objSnap = ret;
            }
          }
        }
        if (!objSnap) continue;

        const children = await this.getDirectChildren(objSnap.location);
        for (const child of children) {
          if (
            child.kind !== "PropertyAssignment" ||
            !child.name ||
            !child.initializer
          ) {
            continue;
          }
          const keyRes = await this.resolvePropertyKey(
            child.name,
            child.location,
          );
          if (keyRes.key === null) continue;
          const initSnap = await this.unwrapExpression(child.initializer);
          if (
            !initSnap ||
            initSnap.kind !== "CallExpression" ||
            !initSnap.expression
          ) {
            continue;
          }
          const relCallee = await this.unwrapExpression(initSnap.expression);
          let relKind: string | null = null;
          if (relCallee?.kind === "Identifier") {
            relKind = relCallee.text;
          } else if (
            relCallee?.kind === "PropertyAccessExpression" &&
            relCallee.name
          ) {
            relKind = (await this.getSyntax(relCallee.name))?.text ?? null;
          }
          if (relKind !== "one" && relKind !== "many") continue;
          const relArgs = initSnap.arguments ?? [];
          const targetTable = relArgs[0]
            ? await this.evaluateTableExpr(relArgs[0])
            : null;
          const info: RelationTargetInfo = {
            relationName: keyRes.key,
            cardinality: relKind === "one" ? "single" : "many",
            targetTable,
            location: child.location,
          };
          if (sourceTable.declHandleId) {
            let map = byTableHandle.get(sourceTable.declHandleId);
            if (!map) {
              map = new Map();
              byTableHandle.set(sourceTable.declHandleId, map);
            }
            map.set(keyRes.key, info);
          }
          for (const key of [sourceTable.tsVarName, sourceTable.sqlTableName]) {
            if (!key) continue;
            let map = byTableName.get(key);
            if (!map) {
              map = new Map();
              byTableName.set(key, map);
            }
            map.set(keyRes.key, info);
          }
        }
      } else if (calleeName === "drizzle") {
        const args = call.arguments ?? [];
        const optsArg = args[1];
        if (!optsArg) continue;
        const optsSnap = await this.unwrapExpression(optsArg);
        if (!optsSnap || optsSnap.kind !== "ObjectLiteralExpression") continue;
        const props = await this.getDirectChildren(optsSnap.location);
        for (const prop of props) {
          if (
            prop.kind !== "PropertyAssignment" ||
            !prop.name ||
            !prop.initializer
          ) {
            continue;
          }
          const keyRes = await this.resolvePropertyKey(
            prop.name,
            prop.location,
          );
          if (keyRes.key !== "schema") continue;
          const schemaObj = await this.#resolveObjectLiteral(prop.initializer);
          if (!schemaObj) continue;
          const schemaEntries = await this.getDirectChildren(
            schemaObj.location,
          );
          for (const entry of schemaEntries) {
            if (
              entry.kind === "PropertyAssignment" &&
              entry.name &&
              entry.initializer
            ) {
              const entryKey = await this.resolvePropertyKey(
                entry.name,
                entry.location,
              );
              if (entryKey.key === null) continue;
              const table = await this.evaluateTableExpr(entry.initializer);
              if (table) schemaTables.set(entryKey.key, table);
            } else if (entry.kind === "ShorthandPropertyAssignment") {
              const entryKey = entry.name
                ? ((await this.getSyntax(entry.name))?.text ?? entry.text)
                : entry.text;
              const table = await this.evaluateTableExpr(entry.ref);
              if (table) schemaTables.set(entryKey, table);
            }
          }
        }
      }
    }

    return { byTableHandle, byTableName, schemaTables, allTables };
  }

  async #resolveObjectLiteral(
    ref: SyntaxRef,
    visitedDecls: ReadonlySet<string> = new Set(),
  ): Promise<SyntaxSnapshot | null> {
    const snap = await this.unwrapExpression(ref);
    if (!snap) return null;
    if (snap.kind === "ObjectLiteralExpression") return snap;
    if (snap.kind === "Identifier") {
      const decl = await this.resolveDecl(snap.ref);
      if (
        canFollowDeclaration(decl) &&
        !visitedDecls.has(decl.syntax.handleId)
      ) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.initializer) {
          return this.#resolveObjectLiteral(
            declSnap.initializer,
            new Set([...visitedDecls, decl.syntax.handleId]),
          );
        }
      }
    }
    return null;
  }

  async lookupTableForQueryKey(
    tableKey: string,
    index: Awaited<ReturnType<DrizzleAstEvaluator["ensureRelationsIndex"]>>,
  ): Promise<ExtractedTable | null> {
    const fromSchema = index.schemaTables.get(tableKey);
    if (fromSchema) return fromSchema;

    const byTsName = index.allTables.find((t) => t.tsVarName === tableKey);
    if (byTsName) return byTsName;

    const bySqlName = index.allTables.find((t) => t.sqlTableName === tableKey);
    if (bySqlName) return bySqlName;

    return null;
  }

  lookupRelationForTable(
    table: ExtractedTable | null,
    relationName: string,
    index: Awaited<ReturnType<DrizzleAstEvaluator["ensureRelationsIndex"]>>,
  ): RelationTargetInfo | null {
    if (!table) return null;
    if (table.declHandleId) {
      const hit = index.byTableHandle
        .get(table.declHandleId)
        ?.get(relationName);
      if (hit) return hit;
    }
    for (const name of [table.tsVarName, table.sqlTableName]) {
      if (!name) continue;
      const hit = index.byTableName.get(name)?.get(relationName);
      if (hit) return hit;
    }
    return null;
  }

  async evaluateColumnRef(
    exprRef: SyntaxRef,
    fallbackTable: ExtractedTable | null,
  ): Promise<{
    readonly tableName?: string;
    readonly sqlName?: string;
    readonly nullable?: boolean;
    readonly isTableColumn: boolean;
    readonly evidence: readonly Evidence[];
  }> {
    const snap = await this.unwrapExpression(exprRef);
    if (!snap) {
      return { isTableColumn: false, evidence: [] };
    }

    if (
      snap.kind === "PropertyAccessExpression" &&
      snap.expression &&
      snap.name
    ) {
      const colPropName = (await this.getSyntax(snap.name))?.text ?? "";
      const table =
        (await this.evaluateTableExpr(snap.expression)) ?? fallbackTable;
      const colDef = table?.columns[colPropName];
      if (colDef && table) {
        return {
          tableName: table.displayName,
          sqlName: colDef.sqlName,
          nullable: colDef.nullable,
          isTableColumn: true,
          evidence: [
            {
              kind: "source",
              message: `Table column "${table.displayName}.${colPropName}" (SQL "${colDef.sqlName}")`,
              at: colDef.location,
            },
          ],
        };
      }
    }

    if (snap.kind === "Identifier") {
      const decl = await this.resolveDecl(snap.ref);
      if (canFollowDeclaration(decl)) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.initializer) {
          return this.evaluateColumnRef(declSnap.initializer, fallbackTable);
        }
      }
      if (fallbackTable?.columns[snap.text]) {
        const colDef = fallbackTable.columns[snap.text]!;
        return {
          tableName: fallbackTable.displayName,
          sqlName: colDef.sqlName,
          nullable: colDef.nullable,
          isTableColumn: true,
          evidence: [
            {
              kind: "source",
              message: `Table column "${fallbackTable.displayName}.${snap.text}" (SQL "${colDef.sqlName}")`,
              at: colDef.location,
            },
          ],
        };
      }
    }

    return { isTableColumn: false, evidence: [] };
  }

  async evaluateSelectFieldsObject(
    fieldsArg: SyntaxRef,
    fallbackTable: ExtractedTable | null,
    visitedDecls: ReadonlySet<string> = new Set(),
  ): Promise<{
    readonly columns: Record<string, QueryRowColumnInfo>;
    readonly hasDynamicColumns: boolean;
    readonly gaps: Gap[];
    readonly evidence: Evidence[];
  }> {
    const snap = await this.unwrapExpression(fieldsArg);
    if (!snap) {
      return {
        columns: {},
        hasDynamicColumns: true,
        gaps: [
          {
            kind: "dynamic-query-projection",
            message:
              "Drizzle select projection argument could not be inspected.",
          },
        ],
        evidence: [],
      };
    }

    if (snap.kind === "Identifier") {
      const decl = await this.resolveDecl(snap.ref);
      if (
        canFollowDeclaration(decl) &&
        !visitedDecls.has(decl.syntax.handleId)
      ) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.initializer) {
          return this.evaluateSelectFieldsObject(
            declSnap.initializer,
            fallbackTable,
            new Set([...visitedDecls, decl.syntax.handleId]),
          );
        }
      }
      return {
        columns: {},
        hasDynamicColumns: true,
        gaps: [
          {
            kind: "dynamic-query-projection",
            message: `Drizzle select projection "${snap.text}" could not be statically resolved.`,
            at: snap.location,
          },
        ],
        evidence: [
          {
            kind: "source",
            message: `Dynamic select projection "${snap.text}"`,
            at: snap.location,
          },
        ],
      };
    }

    if (snap.kind === "CallExpression" && snap.expression) {
      const callee = await this.unwrapExpression(snap.expression);
      const calleeName =
        callee?.kind === "Identifier"
          ? callee.text
          : callee?.kind === "PropertyAccessExpression" && callee.name
            ? ((await this.getSyntax(callee.name))?.text ?? "")
            : "";
      if (calleeName === "getTableColumns" && snap.arguments?.[0]) {
        const table = await this.evaluateTableExpr(snap.arguments[0]);
        if (table) {
          const cols: Record<string, QueryRowColumnInfo> = {};
          for (const colDef of Object.values(table.columns)) {
            cols[colDef.tsName] = {
              name: colDef.tsName,
              sqlName: colDef.sqlName,
              tableName: table.displayName,
              kind: "tableColumn",
              nullable: colDef.nullable,
              evidence: [
                {
                  kind: "source",
                  message: `Table column "${table.displayName}.${colDef.tsName}"`,
                  at: colDef.location,
                },
              ],
            };
          }
          return {
            columns: cols,
            hasDynamicColumns: table.hasDynamicColumns,
            gaps: [...table.gaps],
            evidence: [
              {
                kind: "source",
                message: `Expanded getTableColumns(${table.displayName})`,
                at: snap.location,
              },
            ],
          };
        }
      }
    }

    if (snap.kind !== "ObjectLiteralExpression") {
      return {
        columns: {},
        hasDynamicColumns: true,
        gaps: [
          {
            kind: "dynamic-query-projection",
            message: `Drizzle select projection "${snap.text}" is not a static object literal.`,
            at: snap.location,
          },
        ],
        evidence: [
          {
            kind: "source",
            message: "Non-literal select projection",
            at: snap.location,
          },
        ],
      };
    }

    const children = await this.getDirectChildren(snap.location);
    const preload: SyntaxRef[] = [];
    for (const child of children) {
      if (child.name) preload.push(child.name);
      if (child.initializer) preload.push(child.initializer);
      if (child.expression) preload.push(child.expression);
    }
    await this.preloadSyntax(preload);

    const columns: Record<string, QueryRowColumnInfo> = {};
    const gaps: Gap[] = [];
    const evidence: Evidence[] = [
      {
        kind: "source",
        message: "Drizzle select column projection",
        at: snap.location,
      },
    ];
    let hasDynamicColumns = false;

    for (const child of children) {
      if (
        child.kind === "PropertyAssignment" &&
        child.name &&
        child.initializer
      ) {
        const keyRes = await this.resolvePropertyKey(
          child.name,
          child.location,
        );
        if (keyRes.key === null) {
          hasDynamicColumns = true;
          if (keyRes.gap) gaps.push(keyRes.gap);
          continue;
        }
        const colInfo = await this.evaluateColumnRef(
          child.initializer,
          fallbackTable,
        );
        const colEvidence = dedupeEvidence([
          {
            kind: "source",
            message: `Projected column "${keyRes.key}"`,
            at: child.location,
          },
          ...colInfo.evidence,
        ]);
        columns[keyRes.key] = {
          name: keyRes.key,
          ...(colInfo.sqlName !== undefined
            ? { sqlName: colInfo.sqlName }
            : {}),
          ...(colInfo.tableName !== undefined
            ? { tableName: colInfo.tableName }
            : {}),
          kind: colInfo.isTableColumn ? "tableColumn" : "computed",
          ...(colInfo.nullable !== undefined
            ? { nullable: colInfo.nullable }
            : {}),
          evidence: colEvidence,
        };
        evidence.push(...colInfo.evidence);
      } else if (child.kind === "ShorthandPropertyAssignment") {
        const keyName = child.name
          ? ((await this.getSyntax(child.name))?.text ?? child.text)
          : child.text;
        const colInfo = await this.evaluateColumnRef(child.ref, fallbackTable);
        const colEvidence = dedupeEvidence([
          {
            kind: "source",
            message: `Projected column "${keyName}"`,
            at: child.location,
          },
          ...colInfo.evidence,
        ]);
        columns[keyName] = {
          name: keyName,
          ...(colInfo.sqlName !== undefined
            ? { sqlName: colInfo.sqlName }
            : {}),
          ...(colInfo.tableName !== undefined
            ? { tableName: colInfo.tableName }
            : {}),
          kind: colInfo.isTableColumn ? "tableColumn" : "computed",
          ...(colInfo.nullable !== undefined
            ? { nullable: colInfo.nullable }
            : {}),
          evidence: colEvidence,
        };
        evidence.push(...colInfo.evidence);
      } else if (child.kind === "SpreadAssignment" && child.expression) {
        const spreadRes = await this.evaluateSelectFieldsObject(
          child.expression,
          fallbackTable,
          visitedDecls,
        );
        if (
          spreadRes.hasDynamicColumns &&
          Object.keys(spreadRes.columns).length === 0
        ) {
          hasDynamicColumns = true;
          gaps.push({
            kind: "dynamic-query-projection",
            message: `Spread "${child.text}" in Drizzle select projection cannot be statically resolved.`,
            at: child.location,
          });
        } else {
          if (spreadRes.hasDynamicColumns) hasDynamicColumns = true;
          gaps.push(...spreadRes.gaps);
          Object.assign(columns, spreadRes.columns);
          evidence.push(...spreadRes.evidence);
        }
      } else {
        hasDynamicColumns = true;
        gaps.push({
          kind: "dynamic-query-projection",
          message: `Unsupported dynamic member "${child.text}" (${child.kind}) in Drizzle select projection.`,
          at: child.location,
        });
      }
    }

    return {
      columns,
      hasDynamicColumns,
      gaps: dedupeGaps(gaps) as Gap[],
      evidence: dedupeEvidence(evidence) as Evidence[],
    };
  }

  async evaluateRelationalOptions(
    table: ExtractedTable | null,
    tableKey: string,
    optsRef: SyntaxRef | undefined,
    index: Awaited<ReturnType<DrizzleAstEvaluator["ensureRelationsIndex"]>>,
    visitedDecls: ReadonlySet<string> = new Set(),
  ): Promise<{
    readonly columns: Record<string, QueryRowColumnInfo>;
    readonly relations: Record<string, QueryRowNestedRelationInfo>;
    readonly hasDynamicColumns: boolean;
    readonly gaps: Gap[];
    readonly evidence: Evidence[];
  }> {
    const fullTableColumns = (): Record<string, QueryRowColumnInfo> => {
      const out: Record<string, QueryRowColumnInfo> = {};
      if (!table) return out;
      for (const col of Object.values(table.columns)) {
        out[col.tsName] = {
          name: col.tsName,
          sqlName: col.sqlName,
          tableName: table.displayName,
          kind: "tableColumn",
          nullable: col.nullable,
          evidence: [
            {
              kind: "source",
              message: `Table column "${table.displayName}.${col.tsName}"`,
              at: col.location,
            },
          ],
        };
      }
      return out;
    };

    const gaps: Gap[] = [...(table?.gaps ?? [])];
    const evidence: Evidence[] = table
      ? [
          {
            kind: "source",
            message: `Drizzle table "${table.displayName}" definition`,
            at: table.location,
          },
        ]
      : [];
    let hasDynamicColumns = table?.hasDynamicColumns ?? false;

    if (!table) {
      hasDynamicColumns = true;
      gaps.push({
        kind: "unresolved-drizzle-table",
        message: `Drizzle table "${tableKey}" could not be resolved to a table definition.`,
      });
    }

    if (!optsRef) {
      return {
        columns: fullTableColumns(),
        relations: {},
        hasDynamicColumns,
        gaps,
        evidence,
      };
    }

    const optsSnap = await this.#resolveObjectLiteral(optsRef, visitedDecls);
    if (!optsSnap) {
      const rawSnap = await this.unwrapExpression(optsRef);
      if (rawSnap?.kind === "UndefinedKeyword") {
        return {
          columns: fullTableColumns(),
          relations: {},
          hasDynamicColumns,
          gaps,
          evidence,
        };
      }
      return {
        columns: {},
        relations: {},
        hasDynamicColumns: true,
        gaps: [
          ...gaps,
          {
            kind: "dynamic-query-projection",
            message: `Relational query options for "${tableKey}" are not statically resolvable.`,
            ...(rawSnap ? { at: rawSnap.location } : {}),
          },
        ],
        evidence,
      };
    }

    const optChildren = await this.getDirectChildren(optsSnap.location);
    let columnsArg: SyntaxRef | undefined;
    let withArg: SyntaxRef | undefined;

    for (const child of optChildren) {
      if (
        child.kind === "PropertyAssignment" &&
        child.name &&
        child.initializer
      ) {
        const keyRes = await this.resolvePropertyKey(
          child.name,
          child.location,
        );
        if (keyRes.key === "columns") columnsArg = child.initializer;
        else if (keyRes.key === "with") withArg = child.initializer;
      } else if (child.kind === "SpreadAssignment") {
        hasDynamicColumns = true;
        gaps.push({
          kind: "dynamic-query-projection",
          message: `Spread "${child.text}" in Drizzle relational query options prevents static enumeration.`,
          at: child.location,
        });
      }
    }

    let columns: Record<string, QueryRowColumnInfo> = {};
    if (!columnsArg) {
      columns = fullTableColumns();
    } else {
      const colsEval = await this.#evaluateRelationalColumnsMask(
        table,
        columnsArg,
        visitedDecls,
      );
      columns = colsEval.columns;
      if (colsEval.hasDynamicColumns) hasDynamicColumns = true;
      gaps.push(...colsEval.gaps);
      evidence.push(...colsEval.evidence);
    }

    const relations: Record<string, QueryRowNestedRelationInfo> = {};
    if (withArg) {
      const withEval = await this.#evaluateRelationalWith(
        table,
        withArg,
        index,
        visitedDecls,
      );
      Object.assign(relations, withEval.relations);
      if (withEval.hasDynamicColumns) hasDynamicColumns = true;
      gaps.push(...withEval.gaps);
      evidence.push(...withEval.evidence);
    }

    return {
      columns,
      relations,
      hasDynamicColumns,
      gaps: dedupeGaps(gaps) as Gap[],
      evidence: dedupeEvidence(evidence) as Evidence[],
    };
  }

  async #evaluateRelationalColumnsMask(
    table: ExtractedTable | null,
    columnsRef: SyntaxRef,
    visitedDecls: ReadonlySet<string>,
  ): Promise<{
    readonly columns: Record<string, QueryRowColumnInfo>;
    readonly hasDynamicColumns: boolean;
    readonly gaps: Gap[];
    readonly evidence: Evidence[];
  }> {
    const maskObj = await this.#resolveObjectLiteral(columnsRef, visitedDecls);
    if (!maskObj) {
      const rawSnap = await this.unwrapExpression(columnsRef);
      if (rawSnap?.kind === "UndefinedKeyword") {
        const out: Record<string, QueryRowColumnInfo> = {};
        if (table) {
          for (const col of Object.values(table.columns)) {
            out[col.tsName] = {
              name: col.tsName,
              sqlName: col.sqlName,
              tableName: table.displayName,
              kind: "tableColumn",
              nullable: col.nullable,
              evidence: [
                {
                  kind: "source",
                  message: `Table column "${table.displayName}.${col.tsName}"`,
                  at: col.location,
                },
              ],
            };
          }
        }
        return {
          columns: out,
          hasDynamicColumns: false,
          gaps: [],
          evidence: [],
        };
      }
      return {
        columns: {},
        hasDynamicColumns: true,
        gaps: [
          {
            kind: "dynamic-query-projection",
            message:
              "Relational query `columns` option is not a static object literal.",
            ...(rawSnap ? { at: rawSnap.location } : {}),
          },
        ],
        evidence: [],
      };
    }

    const children = await this.getDirectChildren(maskObj.location);
    const included = new Map<string, DiagnosticLocation>();
    const excluded = new Set<string>();
    const gaps: Gap[] = [];
    let hasDynamicColumns = false;

    for (const child of children) {
      if (
        child.kind === "PropertyAssignment" &&
        child.name &&
        child.initializer
      ) {
        const keyRes = await this.resolvePropertyKey(
          child.name,
          child.location,
        );
        if (keyRes.key === null) {
          hasDynamicColumns = true;
          if (keyRes.gap) gaps.push(keyRes.gap);
          continue;
        }
        const valSnap = await this.unwrapExpression(child.initializer);
        const valText = valSnap?.text.trim() ?? "";
        if (valText === "true") {
          included.set(keyRes.key, child.location);
        } else if (valText === "false") {
          excluded.add(keyRes.key);
        } else {
          hasDynamicColumns = true;
          gaps.push({
            kind: "dynamic-query-projection",
            message: `Relational query column "${keyRes.key}" uses non-literal flag "${valText}".`,
            at: child.location,
          });
        }
      } else {
        hasDynamicColumns = true;
        gaps.push({
          kind: "dynamic-query-projection",
          message: `Dynamic member "${child.text}" in relational query \`columns\`.`,
          at: child.location,
        });
      }
    }

    const columns: Record<string, QueryRowColumnInfo> = {};
    const evidence: Evidence[] = [
      {
        kind: "source",
        message: "Drizzle relational query `columns` projection",
        at: maskObj.location,
      },
    ];

    if (included.size > 0) {
      for (const [colName, propLoc] of included.entries()) {
        const colDef = table?.columns[colName];
        columns[colName] = {
          name: colName,
          ...(colDef ? { sqlName: colDef.sqlName } : {}),
          ...(table ? { tableName: table.displayName } : {}),
          kind: "tableColumn",
          ...(colDef ? { nullable: colDef.nullable } : {}),
          evidence: dedupeEvidence([
            {
              kind: "source",
              message: `Projected column "${colName}"`,
              at: propLoc,
            },
            ...(colDef
              ? [
                  {
                    kind: "source" as const,
                    message: `Table column "${table?.displayName ?? "table"}.${colName}"`,
                    at: colDef.location,
                  },
                ]
              : []),
          ]),
        };
      }
    } else if (excluded.size > 0 && table) {
      for (const colDef of Object.values(table.columns)) {
        if (excluded.has(colDef.tsName)) continue;
        columns[colDef.tsName] = {
          name: colDef.tsName,
          sqlName: colDef.sqlName,
          tableName: table.displayName,
          kind: "tableColumn",
          nullable: colDef.nullable,
          evidence: [
            {
              kind: "source",
              message: `Table column "${table.displayName}.${colDef.tsName}"`,
              at: colDef.location,
            },
          ],
        };
      }
    }

    return { columns, hasDynamicColumns, gaps, evidence };
  }

  async #evaluateRelationalWith(
    parentTable: ExtractedTable | null,
    withRef: SyntaxRef,
    index: Awaited<ReturnType<DrizzleAstEvaluator["ensureRelationsIndex"]>>,
    visitedDecls: ReadonlySet<string>,
  ): Promise<{
    readonly relations: Record<string, QueryRowNestedRelationInfo>;
    readonly hasDynamicColumns: boolean;
    readonly gaps: Gap[];
    readonly evidence: Evidence[];
  }> {
    const withObj = await this.#resolveObjectLiteral(withRef, visitedDecls);
    if (!withObj) {
      const rawSnap = await this.unwrapExpression(withRef);
      if (rawSnap?.kind === "UndefinedKeyword") {
        return {
          relations: {},
          hasDynamicColumns: false,
          gaps: [],
          evidence: [],
        };
      }
      return {
        relations: {},
        hasDynamicColumns: true,
        gaps: [
          {
            kind: "dynamic-query-projection",
            message:
              "Relational query `with` option is not a static object literal.",
            ...(rawSnap ? { at: rawSnap.location } : {}),
          },
        ],
        evidence: [],
      };
    }

    const children = await this.getDirectChildren(withObj.location);
    const relations: Record<string, QueryRowNestedRelationInfo> = {};
    const gaps: Gap[] = [];
    const evidence: Evidence[] = [
      {
        kind: "source",
        message: "Drizzle relational query `with` clause",
        at: withObj.location,
      },
    ];
    let hasDynamicColumns = false;

    for (const child of children) {
      if (
        child.kind !== "PropertyAssignment" ||
        !child.name ||
        !child.initializer
      ) {
        hasDynamicColumns = true;
        gaps.push({
          kind: "dynamic-query-projection",
          message: `Dynamic entry "${child.text}" in relational query \`with\`.`,
          at: child.location,
        });
        continue;
      }
      const keyRes = await this.resolvePropertyKey(child.name, child.location);
      if (keyRes.key === null) {
        hasDynamicColumns = true;
        if (keyRes.gap) gaps.push(keyRes.gap);
        continue;
      }

      const relName = keyRes.key;
      const specSnap = await this.unwrapExpression(child.initializer);
      if (specSnap?.text.trim() === "false") {
        continue;
      }

      const relTarget = this.lookupRelationForTable(
        parentTable,
        relName,
        index,
      );
      if (!relTarget || !relTarget.targetTable) {
        hasDynamicColumns = true;
        gaps.push({
          kind: "unresolved-drizzle-relation",
          message: `Drizzle relation "${relName}" on table "${parentTable?.displayName ?? "unknown"}" could not be resolved.`,
          at: child.location,
        });
        continue;
      }

      const targetTable = relTarget.targetTable;
      let nestedEval: {
        readonly columns: Record<string, QueryRowColumnInfo>;
        readonly relations: Record<string, QueryRowNestedRelationInfo>;
        readonly hasDynamicColumns: boolean;
        readonly gaps: Gap[];
        readonly evidence: Evidence[];
      };

      if (specSnap?.text.trim() === "true") {
        nestedEval = await this.evaluateRelationalOptions(
          targetTable,
          targetTable.displayName,
          undefined,
          index,
          visitedDecls,
        );
      } else {
        nestedEval = await this.evaluateRelationalOptions(
          targetTable,
          targetTable.displayName,
          child.initializer,
          index,
          visitedDecls,
        );
      }

      if (nestedEval.hasDynamicColumns) hasDynamicColumns = true;
      gaps.push(...nestedEval.gaps);
      const relEvidence = dedupeEvidence([
        {
          kind: "source",
          message: `Nested relation "${relName}" (${relTarget.cardinality}) from "${targetTable.displayName}"`,
          at: child.location,
        },
        {
          kind: "source",
          message: `Relation "${relName}" defined here`,
          at: relTarget.location,
        },
        ...nestedEval.evidence,
      ]);
      evidence.push(...relEvidence);

      const nestedCols = [
        ...new Set([
          ...Object.keys(nestedEval.columns),
          ...Object.keys(nestedEval.relations),
        ]),
      ].toSorted((a, b) => (a < b ? -1 : a > b ? 1 : 0));

      relations[relName] = {
        name: relName,
        cardinality: relTarget.cardinality,
        tableName: targetTable.displayName,
        columns: nestedCols,
        columnDetails: nestedEval.columns,
        relations: nestedEval.relations,
        hasDynamicColumns: nestedEval.hasDynamicColumns,
        evidence: relEvidence,
      };
    }

    return { relations, hasDynamicColumns, gaps, evidence };
  }
}

type FluentChainStep = {
  readonly call: SyntaxSnapshot;
  readonly methodName: string;
};

async function collectFluentChain(
  evaluator: DrizzleAstEvaluator,
  outerCall: SyntaxSnapshot,
): Promise<readonly FluentChainStep[] | null> {
  const steps: FluentChainStep[] = [];
  let current: SyntaxSnapshot | null = outerCall;
  const seen = new Set<string>();

  while (current && !seen.has(current.ref.handleId)) {
    seen.add(current.ref.handleId);
    if (current.kind !== "CallExpression" || !current.expression) {
      break;
    }
    const callee = await evaluator.unwrapExpression(current.expression);
    if (
      !callee ||
      callee.kind !== "PropertyAccessExpression" ||
      !callee.expression ||
      !callee.name
    ) {
      break;
    }
    const methodName = (await evaluator.getSyntax(callee.name))?.text ?? "";
    steps.push({ call: current, methodName });
    if (SELECT_ENTRY_METHODS.has(methodName)) {
      steps.reverse();
      return steps;
    }
    if (!SELECT_CHAIN_METHODS.has(methodName)) {
      return null;
    }
    current = await evaluator.unwrapExpression(callee.expression);
  }

  return null;
}

async function discoverWorkspaceFiles(
  ctx: AdapterContext,
  evaluator: DrizzleAstEvaluator,
  initialCalls: readonly SyntaxNodeResult[],
): Promise<readonly string[]> {
  const projectFileSet = new Set(ctx.project.sourceFiles);
  const visitedFiles = new Set<string>(ctx.project.sourceFiles);
  const discovered: string[] = [];

  const collectRefsFromFiles = async (
    calls: readonly SyntaxNodeResult[],
    files?: readonly string[],
  ): Promise<readonly SyntaxRef[]> => {
    const refs: SyntaxRef[] = [];
    const importSpecs = await ctx.findSyntax({
      kinds: ["ImportSpecifier"],
      ...(files ? { files } : {}),
    });
    for (const spec of importSpecs) {
      refs.push(spec.ref);
    }
    for (const call of calls) {
      if (call.expression) {
        refs.push(call.expression);
        const exprSnap = await evaluator.getSyntax(call.expression);
        if (exprSnap?.expression) {
          refs.push(exprSnap.expression);
        }
      }
      for (const arg of call.arguments ?? []) {
        refs.push(arg);
      }
    }
    return refs;
  };

  let frontierCalls: readonly SyntaxNodeResult[] = initialCalls;
  let frontierFiles: readonly string[] | undefined;

  // Bounded 2-hop discovery through workspace package entrypoints (never node_modules or .d.ts)
  for (let hop = 0; hop < 2; hop += 1) {
    const refsToResolve = await collectRefsFromFiles(
      frontierCalls,
      frontierFiles,
    );
    if (refsToResolve.length === 0) break;

    const declRows = await ctx.resolveDeclarations(refsToResolve, {
      select: { location: true, isExternal: true },
    });
    const nextFiles: string[] = [];
    for (const row of declRows) {
      const file = row.location?.file;
      if (!file || visitedFiles.has(file)) continue;
      if (isDeclarationFile(file) || isNodeModulesFile(file)) continue;
      visitedFiles.add(file);
      if (!projectFileSet.has(file)) {
        discovered.push(file);
        nextFiles.push(file);
      }
    }
    if (nextFiles.length === 0) break;
    frontierFiles = nextFiles;
    const nextCalls = await ctx.findSyntax({
      files: nextFiles,
      kinds: ["CallExpression"],
    });
    evaluator.seedSyntaxNodes(nextCalls);
    frontierCalls = nextCalls;
  }

  return discovered;
}

export async function extractDrizzleRowProjectionFacts(
  ctx: AdapterContext,
  request: FactExtractionRequest<
    QueryRowSubjectKind,
    QueryRowProjectionCondition | undefined
  >,
): Promise<
  readonly FactContribution<QueryRowSubjectKind, QueryRowProjectionFactValue>[]
> {
  if (
    request.condition?.library !== undefined &&
    request.condition.library !== "drizzle"
  ) {
    return [];
  }

  const evaluator = new DrizzleAstEvaluator(ctx);
  const projectNodes = await ctx.findSyntax({
    kinds: ["CallExpression", "VariableDeclaration"],
  });
  evaluator.seedSyntaxNodes(projectNodes);

  const projectCalls = projectNodes.filter((n) => n.kind === "CallExpression");
  const preloadInit: SyntaxRef[] = [];
  for (const call of projectCalls) {
    if (call.expression) preloadInit.push(call.expression);
  }
  await evaluator.preloadSyntax(preloadInit);

  const extraWorkspaceFiles = await discoverWorkspaceFiles(
    ctx,
    evaluator,
    projectCalls,
  );
  const extraNodes =
    extraWorkspaceFiles.length > 0
      ? await ctx.findSyntax({
          files: extraWorkspaceFiles,
          kinds: ["CallExpression", "VariableDeclaration"],
        })
      : [];
  evaluator.seedSyntaxNodes(extraNodes);

  const allNodes = [...projectNodes, ...extraNodes];
  const allCalls = allNodes.filter((n) => n.kind === "CallExpression");
  const allVarDecls = allNodes.filter((n) => n.kind === "VariableDeclaration");

  const preload: SyntaxRef[] = [];
  for (const call of allCalls) {
    if (call.expression) preload.push(call.expression);
  }
  await evaluator.preloadSyntax(preload);

  const calleeParts: SyntaxRef[] = [];
  for (const call of allCalls) {
    if (!call.expression) continue;
    const exprSnap = await evaluator.getSyntax(call.expression);
    if (exprSnap?.expression) calleeParts.push(exprSnap.expression);
    if (exprSnap?.name) calleeParts.push(exprSnap.name);
  }
  await evaluator.preloadSyntax(calleeParts);

  const innerReceiverLocs = new Set<string>();
  for (const call of allCalls) {
    if (!call.expression) continue;
    const callee = await evaluator.unwrapExpression(call.expression);
    if (callee?.kind === "PropertyAccessExpression" && callee.expression) {
      const receiver = await evaluator.unwrapExpression(callee.expression);
      if (receiver?.kind === "CallExpression") {
        innerReceiverLocs.add(locationKey(receiver.location));
      }
    }
  }

  const targetHandles = request.targets
    ? new Set(request.targets.map((t) => t.handleId))
    : null;

  const relationsIndex = await evaluator.ensureRelationsIndex(
    allCalls,
    allVarDecls,
  );
  const contributions: FactContribution<
    QueryRowSubjectKind,
    QueryRowProjectionFactValue
  >[] = [];

  for (const call of allCalls) {
    if (targetHandles !== null && !targetHandles.has(call.ref.handleId)) {
      continue;
    }
    if (!call.expression) continue;

    const callee = await evaluator.unwrapExpression(call.expression);
    if (
      !callee ||
      callee.kind !== "PropertyAccessExpression" ||
      !callee.expression ||
      !callee.name
    ) {
      continue;
    }
    const methodName = (await evaluator.getSyntax(callee.name))?.text ?? "";

    if (methodName === "findFirst" || methodName === "findMany") {
      const queryTarget = await evaluator.unwrapExpression(callee.expression);
      if (
        queryTarget?.kind === "PropertyAccessExpression" &&
        queryTarget.expression &&
        queryTarget.name
      ) {
        const tableKey =
          (await evaluator.getSyntax(queryTarget.name))?.text ?? "";
        const queryRoot = await evaluator.unwrapExpression(
          queryTarget.expression,
        );
        const queryPropName =
          queryRoot?.kind === "PropertyAccessExpression" && queryRoot.name
            ? ((await evaluator.getSyntax(queryRoot.name))?.text ?? "")
            : queryRoot?.kind === "Identifier"
              ? queryRoot.text
              : "";
        if (queryPropName === "query" && tableKey !== "") {
          const table = await evaluator.lookupTableForQueryKey(
            tableKey,
            relationsIndex,
          );
          const typeText = table
            ? ""
            : await evaluator.getTypeText(queryTarget.ref);
          const looksLikeDrizzle =
            table !== null ||
            /RelationalQueryBuilder|SQLiteRelationalQuery|PgRelationalQuery|MySqlRelationalQuery/u.test(
              typeText,
            );
          if (!looksLikeDrizzle) {
            continue;
          }

          const relEval = await evaluator.evaluateRelationalOptions(
            table,
            tableKey,
            call.arguments?.[0],
            relationsIndex,
          );
          const evidence = dedupeEvidence([
            {
              kind: "source",
              message: `Drizzle relational query db.query.${tableKey}.${methodName}()`,
              at: call.location,
            },
            ...relEval.evidence,
          ]);
          contributions.push({
            subject: call.ref,
            value: buildQueryRowProjectionValue({
              library: "drizzle",
              queryKind: "relational",
              cardinality: methodName === "findFirst" ? "single" : "many",
              tableName: table?.displayName ?? tableKey,
              columns: relEval.columns,
              relations: relEval.relations,
              hasDynamicColumns: relEval.hasDynamicColumns,
            }),
            evidence,
            gaps: relEval.gaps,
          });
          continue;
        }
      }
    }

    if (
      innerReceiverLocs.has(locationKey(call.location)) &&
      targetHandles === null
    ) {
      continue;
    }

    const chain = await collectFluentChain(evaluator, call);
    if (!chain) continue;

    const selectStep = chain[0]!;
    const fromStep = chain.find((step) => step.methodName === "from");
    if (!fromStep) continue;

    const tableArg = fromStep.call.arguments?.[0];
    const fromTable = tableArg
      ? await evaluator.evaluateTableExpr(tableArg)
      : null;

    if (!fromTable) {
      const selectCallee = await evaluator.unwrapExpression(
        selectStep.call.expression!,
      );
      const dbTypeText =
        selectCallee?.kind === "PropertyAccessExpression" &&
        selectCallee.expression
          ? await evaluator.getTypeText(selectCallee.expression)
          : "";
      if (
        !/Drizzle|SQLiteDatabase|PgDatabase|MySqlDatabase|BaseSQLiteDatabase|DbClient/u.test(
          dbTypeText,
        )
      ) {
        continue;
      }
    }

    const lastMethod = chain[chain.length - 1]!.methodName;
    const cardinality: QueryRowCardinality =
      lastMethod === "get" ? "single" : "many";
    const selectArg = selectStep.call.arguments?.[0];

    let columns: Record<string, QueryRowColumnInfo> = {};
    let hasDynamicColumns = fromTable?.hasDynamicColumns ?? false;
    const gaps: Gap[] = [...(fromTable?.gaps ?? [])];
    const evidence: Evidence[] = [
      {
        kind: "source",
        message: `Drizzle .${selectStep.methodName}() query`,
        at: call.location,
      },
    ];
    if (fromTable) {
      evidence.push({
        kind: "source",
        message: `Drizzle table "${fromTable.displayName}" definition`,
        at: fromTable.location,
      });
    }

    if (!selectArg) {
      if (fromTable) {
        for (const colDef of Object.values(fromTable.columns)) {
          columns[colDef.tsName] = {
            name: colDef.tsName,
            sqlName: colDef.sqlName,
            tableName: fromTable.displayName,
            kind: "tableColumn",
            nullable: colDef.nullable,
            evidence: [
              {
                kind: "source",
                message: `Table column "${fromTable.displayName}.${colDef.tsName}"`,
                at: colDef.location,
              },
            ],
          };
        }
      } else {
        hasDynamicColumns = true;
        gaps.push({
          kind: "unresolved-drizzle-table",
          message: "Table passed to .from() could not be statically resolved.",
          at: fromStep.call.location,
        });
      }
    } else {
      const selectArgSnap = await evaluator.unwrapExpression(selectArg);
      if (selectArgSnap?.kind === "UndefinedKeyword") {
        if (fromTable) {
          for (const colDef of Object.values(fromTable.columns)) {
            columns[colDef.tsName] = {
              name: colDef.tsName,
              sqlName: colDef.sqlName,
              tableName: fromTable.displayName,
              kind: "tableColumn",
              nullable: colDef.nullable,
              evidence: [
                {
                  kind: "source",
                  message: `Table column "${fromTable.displayName}.${colDef.tsName}"`,
                  at: colDef.location,
                },
              ],
            };
          }
        }
      } else {
        const evalRes = await evaluator.evaluateSelectFieldsObject(
          selectArg,
          fromTable,
        );
        columns = evalRes.columns;
        if (evalRes.hasDynamicColumns) hasDynamicColumns = true;
        gaps.push(...evalRes.gaps);
        evidence.push(...evalRes.evidence);
      }
    }

    contributions.push({
      subject: call.ref,
      value: buildQueryRowProjectionValue({
        library: "drizzle",
        queryKind: "select",
        cardinality,
        ...(fromTable ? { tableName: fromTable.displayName } : {}),
        columns,
        hasDynamicColumns,
      }),
      evidence: dedupeEvidence(evidence),
      gaps: dedupeGaps(gaps),
    });
  }

  return contributions;
}
