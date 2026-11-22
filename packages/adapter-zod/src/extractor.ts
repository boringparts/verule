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
  buildInputFieldsValue,
  buildOutputFieldsValue,
  type ValidatorFieldsCondition,
  type ValidatorInputFieldInfo,
  type ValidatorInputFieldRequirement,
  type ValidatorInputFieldsFactValue,
  type ValidatorMethodName,
  type ValidatorOutputFieldInfo,
  type ValidatorOutputFieldPresence,
  type ValidatorOutputFieldsFactValue,
  type ValidatorSiteKind,
  type ValidatorSubjectKind,
} from "./facts.ts";

type FieldSchemaState = {
  readonly name: string;
  readonly inputRequirement: ValidatorInputFieldRequirement;
  readonly outputPresence: ValidatorOutputFieldPresence;
  readonly nullable: boolean;
  readonly fromDefault: boolean;
  readonly evidence: readonly Evidence[];
};

type ExtractedSchema = {
  readonly recognized: boolean;
  readonly fields: Readonly<Record<string, FieldSchemaState>>;
  readonly hasDynamicFields: boolean;
  readonly gaps: readonly Gap[];
  readonly evidence: readonly Evidence[];
};

type EvaluatedFieldModifierResult = {
  readonly inputRequirement: ValidatorInputFieldRequirement;
  readonly outputPresence: ValidatorOutputFieldPresence;
  readonly nullable: boolean;
  readonly fromDefault: boolean;
  readonly hasDynamicFields: boolean;
  readonly gaps: readonly Gap[];
  readonly evidence: readonly Evidence[];
};

type BooleanMaskResult = {
  readonly keys: ReadonlySet<string>;
  readonly hasDynamic: boolean;
  readonly gaps: readonly Gap[];
};

const VALIDATOR_METHODS = new Set<string>([
  "parse",
  "safeParse",
  "parseAsync",
  "safeParseAsync",
]);

const ZOD_OBJECT_BUILDERS = new Set<string>([
  "object",
  "strictObject",
  "looseObject",
]);

const ZOD_DYNAMIC_BUILDERS = new Set<string>([
  "record",
  "any",
  "unknown",
  "custom",
]);

const ZOD_COMPOSITION_METHODS = new Set<string>([
  "extend",
  "merge",
  "pick",
  "omit",
  "partial",
  "required",
  "and",
  "or",
]);

const ZOD_TRANSPARENT_WRAPPERS = new Set<string>([
  "transform",
  "refine",
  "superRefine",
  "check",
  "pipe",
  "openapi",
  "describe",
  "meta",
  "brand",
  "readonly",
]);

const FIELD_MODIFIER_METHODS = new Set<string>([
  "optional",
  "nullish",
  "nullable",
  "default",
  "prefault",
  "catch",
  "nonoptional",
  ...ZOD_TRANSPARENT_WRAPPERS,
]);

const STATIC_FIELD_WRAPPERS = new Set<string>([
  "optional",
  "nullable",
  "nullish",
  "default",
  "prefault",
  "catch",
  "nonoptional",
  "preprocess",
]);

const TRANSPARENT_EXPR_KINDS = new Set<string>([
  "ParenthesizedExpression",
  "AsExpression",
  "SatisfiesExpression",
  "TypeAssertionExpression",
  "NonNullExpression",
]);

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

function isSpanWithin(
  inner: DiagnosticLocation,
  outer: DiagnosticLocation,
): boolean {
  return (
    inner.file === outer.file &&
    inner.start >= outer.start &&
    inner.end <= outer.end
  );
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

function isZodTypeText(typeText: string): boolean {
  return /\b(?:Zod[A-Z]\w*|\$Zod[A-Z]?\w*|ZodEffects|ZodPipe|ZodObject|ZodType|ZodSchema)\b/u.test(
    typeText,
  );
}

class ZodAstEvaluator {
  readonly #ctx: AdapterContext;
  readonly #syntaxCache = new Map<string, SyntaxSnapshot | null>();
  readonly #declCache = new Map<
    string,
    {
      readonly name: string | null;
      readonly kind: string | null;
      readonly location: DiagnosticLocation | null;
      readonly syntax: SyntaxRef | null;
      readonly isExternal: boolean;
    }
  >();
  readonly #typeTextCache = new Map<string, string>();
  readonly #schemaCache = new Map<string, Promise<ExtractedSchema>>();

  constructor(ctx: AdapterContext) {
    this.#ctx = ctx;
  }

  async getSyntax(ref: SyntaxRef): Promise<SyntaxSnapshot | null> {
    const cached = this.#syntaxCache.get(ref.handleId);
    if (cached !== undefined) {
      return cached;
    }
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

  async resolveDecl(ref: SyntaxRef) {
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
    const info = {
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

  async isZodNamespace(ref: SyntaxRef): Promise<boolean> {
    const snap = await this.unwrapExpression(ref);
    if (!snap) return false;
    if (snap.kind === "Identifier") {
      if (snap.text === "z") {
        return true;
      }
      const decl = await this.resolveDecl(snap.ref);
      if (decl.name === "z") {
        return true;
      }
      const typeText = await this.getTypeText(snap.ref);
      if (/\bzod\b|\bZod/u.test(typeText)) {
        return true;
      }
      return false;
    }
    if (snap.kind === "PropertyAccessExpression" && snap.name) {
      const propName = await this.getSyntax(snap.name);
      if (propName?.text === "z") {
        return true;
      }
    }
    const typeText = await this.getTypeText(snap.ref);
    return /\bzod\b|\bZod/u.test(typeText);
  }

  async evaluateSchemaExpr(
    ref: SyntaxRef,
    visitedDecls: ReadonlySet<string> = new Set(),
  ): Promise<ExtractedSchema> {
    const snap = await this.unwrapExpression(ref);
    if (!snap) {
      return {
        recognized: false,
        fields: {},
        hasDynamicFields: false,
        gaps: [],
        evidence: [],
      };
    }

    const cacheKey = visitedDecls.size === 0 ? snap.ref.handleId : undefined;
    if (cacheKey !== undefined) {
      const cached = this.#schemaCache.get(cacheKey);
      if (cached) return cached;
    }

    const promise = this.#evaluateSchemaSnapshot(snap, visitedDecls);
    if (cacheKey !== undefined) {
      this.#schemaCache.set(cacheKey, promise);
    }
    return promise;
  }

  async #evaluateSchemaSnapshot(
    snap: SyntaxSnapshot,
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedSchema> {
    if (snap.kind === "Identifier") {
      return this.#evaluateIdentifierSchema(snap, visitedDecls);
    }

    if (
      snap.kind === "PropertyAccessExpression" &&
      snap.expression &&
      snap.name
    ) {
      const propName = await this.getSyntax(snap.name);
      if (propName?.text === "shape") {
        return this.evaluateSchemaExpr(snap.expression, visitedDecls);
      }
      const typeText = await this.getTypeText(snap.ref);
      if (isZodTypeText(typeText)) {
        return {
          recognized: true,
          fields: {},
          hasDynamicFields: true,
          gaps: [
            {
              kind: "unresolved-schema",
              message: `Schema expression "${snap.text}" (${typeText}) could not be statically resolved.`,
              at: snap.location,
            },
          ],
          evidence: [
            {
              kind: "source",
              message: `Schema reference "${snap.text}"`,
              at: snap.location,
            },
          ],
        };
      }
      return {
        recognized: false,
        fields: {},
        hasDynamicFields: false,
        gaps: [],
        evidence: [],
      };
    }

    if (snap.kind !== "CallExpression" || !snap.expression) {
      return {
        recognized: false,
        fields: {},
        hasDynamicFields: false,
        gaps: [],
        evidence: [],
      };
    }

    const callee = await this.unwrapExpression(snap.expression);
    if (!callee) {
      return {
        recognized: false,
        fields: {},
        hasDynamicFields: false,
        gaps: [],
        evidence: [],
      };
    }

    if (
      callee.kind === "PropertyAccessExpression" &&
      callee.expression &&
      callee.name
    ) {
      const methodSnap = await this.getSyntax(callee.name);
      const methodName = methodSnap?.text ?? "";
      const args = snap.arguments ?? [];

      if (ZOD_OBJECT_BUILDERS.has(methodName)) {
        const isZ = await this.isZodNamespace(callee.expression);
        if (!isZ) {
          return {
            recognized: false,
            fields: {},
            hasDynamicFields: false,
            gaps: [],
            evidence: [],
          };
        }
        const shapeArg = args[0];
        if (!shapeArg) {
          return {
            recognized: true,
            fields: {},
            hasDynamicFields: false,
            gaps: [],
            evidence: [
              {
                kind: "source",
                message: `Zod object schema defined via z.${methodName}()`,
                at: snap.location,
              },
            ],
          };
        }
        const shape = await this.#evaluateShapeExpr(shapeArg, visitedDecls);
        return {
          recognized: true,
          fields: shape.fields,
          hasDynamicFields: shape.hasDynamicFields,
          gaps: dedupeGaps(shape.gaps),
          evidence: dedupeEvidence([
            {
              kind: "source",
              message: `Zod object schema defined via z.${methodName}()`,
              at: snap.location,
            },
            ...shape.evidence,
          ]),
        };
      }

      if (ZOD_DYNAMIC_BUILDERS.has(methodName)) {
        const isZ = await this.isZodNamespace(callee.expression);
        if (!isZ) {
          return {
            recognized: false,
            fields: {},
            hasDynamicFields: false,
            gaps: [],
            evidence: [],
          };
        }
        return {
          recognized: true,
          fields: {},
          hasDynamicFields: true,
          gaps: [
            {
              kind: "dynamic-schema-shape",
              message: `Schema uses z.${methodName}() whose object keys cannot be statically enumerated.`,
              at: snap.location,
            },
          ],
          evidence: [
            {
              kind: "source",
              message: `Dynamic Zod schema z.${methodName}()`,
              at: snap.location,
            },
          ],
        };
      }

      if (methodName === "union" || methodName === "discriminatedUnion") {
        const isZ = await this.isZodNamespace(callee.expression);
        if (isZ) {
          const branchesArg = methodName === "union" ? args[0] : args[1];
          return this.#evaluateUnionSchema(snap, branchesArg, visitedDecls);
        }
      }

      if (methodName === "intersection") {
        const isZ = await this.isZodNamespace(callee.expression);
        if (isZ && args[0] && args[1]) {
          const left = await this.evaluateSchemaExpr(args[0], visitedDecls);
          const right = await this.evaluateSchemaExpr(args[1], visitedDecls);
          return this.#mergeIntersectionSchemas(
            snap.location,
            left,
            right,
            "z.intersection()",
          );
        }
      }

      if (ZOD_COMPOSITION_METHODS.has(methodName)) {
        return this.#evaluateCompositionCall(
          snap,
          methodName,
          callee.expression,
          args,
          visitedDecls,
        );
      }

      if (
        ZOD_TRANSPARENT_WRAPPERS.has(methodName) ||
        methodName === "optional" ||
        methodName === "nullish" ||
        methodName === "nullable" ||
        methodName === "default" ||
        methodName === "prefault" ||
        methodName === "catch"
      ) {
        const inner = await this.evaluateSchemaExpr(
          callee.expression,
          visitedDecls,
        );
        if (!inner.recognized) {
          return inner;
        }
        if (methodName === "pipe" && args[0]) {
          const pipedTarget = await this.evaluateSchemaExpr(
            args[0],
            visitedDecls,
          );
          if (pipedTarget.recognized && !pipedTarget.hasDynamicFields) {
            return {
              ...inner,
              evidence: dedupeEvidence([
                ...inner.evidence,
                {
                  kind: "source",
                  message: `Schema chained through .${methodName}()`,
                  at: snap.location,
                },
                ...pipedTarget.evidence,
              ]),
            };
          }
        }
        return {
          ...inner,
          evidence: dedupeEvidence([
            ...inner.evidence,
            {
              kind: "source",
              message: `Schema wrapped with .${methodName}()`,
              at: snap.location,
            },
          ]),
        };
      }
    }

    // Check if the call is to a local helper function returning a Zod schema, or an external Zod factory (e.g. createSelectSchema)
    const decl = await this.resolveDecl(callee.ref);
    if (!decl.isExternal && decl.syntax) {
      const declId = decl.syntax.handleId;
      if (!visitedDecls.has(declId)) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.body) {
          const bodySnap = await this.getSyntax(declSnap.body);
          if (bodySnap) {
            const retSchema = await this.#evaluateFunctionBodyReturn(
              bodySnap,
              new Set([...visitedDecls, declId]),
            );
            if (retSchema.recognized) {
              return {
                ...retSchema,
                evidence: dedupeEvidence([
                  {
                    kind: "source",
                    message: `Returned from helper "${decl.name ?? callee.text}"`,
                    at: declSnap.location,
                  },
                  ...retSchema.evidence,
                ]),
              };
            }
          }
        }
      }
    }

    const typeText = await this.getTypeText(snap.ref);
    if (isZodTypeText(typeText)) {
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "unresolved-schema",
            message: `Zod schema call "${snap.text}" could not be statically expanded to object fields.`,
            at: snap.location,
          },
        ],
        evidence: [
          {
            kind: "source",
            message: `Opaque Zod schema expression "${snap.text}"`,
            at: snap.location,
          },
        ],
      };
    }

    return {
      recognized: false,
      fields: {},
      hasDynamicFields: false,
      gaps: [],
      evidence: [],
    };
  }

  async #evaluateFunctionBodyReturn(
    bodySnap: SyntaxSnapshot,
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedSchema> {
    if (bodySnap.kind !== "Block") {
      // Arrow function with concise expression body
      return this.evaluateSchemaExpr(bodySnap.ref, visitedDecls);
    }
    const returns = await this.#ctx.findSyntax({
      kinds: ["ReturnStatement"],
      range: {
        file: bodySnap.location.file,
        start: bodySnap.location.start,
        end: bodySnap.location.end,
        match: "within",
      },
    });
    this.seedSyntaxNodes(returns);
    if (returns.length !== 1 || !returns[0]!.expression) {
      return {
        recognized: false,
        fields: {},
        hasDynamicFields: false,
        gaps: [],
        evidence: [],
      };
    }
    return this.evaluateSchemaExpr(returns[0]!.expression, visitedDecls);
  }

  async #evaluateIdentifierSchema(
    snap: SyntaxSnapshot,
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedSchema> {
    const decl = await this.resolveDecl(snap.ref);
    if (decl.syntax && !decl.isExternal) {
      const declId = decl.syntax.handleId;
      if (visitedDecls.has(declId)) {
        return {
          recognized: true,
          fields: {},
          hasDynamicFields: true,
          gaps: [
            {
              kind: "recursive-schema",
              message: `Recursive Zod schema reference "${snap.text}" stops static expansion.`,
              at: snap.location,
            },
          ],
          evidence: [
            {
              kind: "source",
              message: `Recursive schema reference "${snap.text}"`,
              at: snap.location,
            },
          ],
        };
      }
      const declSnap = await this.getSyntax(decl.syntax);
      if (declSnap?.initializer) {
        const nextVisited = new Set([...visitedDecls, declId]);
        const inner = await this.evaluateSchemaExpr(
          declSnap.initializer,
          nextVisited,
        );
        if (inner.recognized) {
          return {
            ...inner,
            evidence: dedupeEvidence([
              {
                kind: "source",
                message: `Schema "${decl.name ?? snap.text}" defined here`,
                at: declSnap.location,
              },
              ...inner.evidence,
            ]),
          };
        }
        return inner;
      }
    }

    const typeText = await this.getTypeText(snap.ref);
    if (isZodTypeText(typeText)) {
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "unresolved-schema",
            message: `Zod schema "${snap.text}" (${typeText}) has no statically resolvable local definition.`,
            at: decl.location ?? snap.location,
          },
        ],
        evidence: [
          {
            kind: "source",
            message: `Schema identifier "${snap.text}"`,
            at: decl.location ?? snap.location,
          },
        ],
      };
    }

    return {
      recognized: false,
      fields: {},
      hasDynamicFields: false,
      gaps: [],
      evidence: [],
    };
  }

  async #evaluateCompositionCall(
    callSnap: SyntaxSnapshot,
    methodName: string,
    receiverRef: SyntaxRef,
    args: readonly SyntaxRef[],
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedSchema> {
    const base = await this.evaluateSchemaExpr(receiverRef, visitedDecls);
    if (!base.recognized) {
      return base;
    }

    const callEvidence: Evidence = {
      kind: "source",
      message: `Schema composed with .${methodName}()`,
      at: callSnap.location,
    };

    if (methodName === "extend") {
      const extArg = args[0];
      if (!extArg) {
        return {
          ...base,
          evidence: dedupeEvidence([...base.evidence, callEvidence]),
        };
      }
      const extShape = await this.#evaluateShapeExpr(extArg, visitedDecls);
      const merged: Record<string, FieldSchemaState> = {
        ...base.fields,
        ...extShape.fields,
      };
      return {
        recognized: true,
        fields: merged,
        hasDynamicFields: base.hasDynamicFields || extShape.hasDynamicFields,
        gaps: dedupeGaps([...base.gaps, ...extShape.gaps]),
        evidence: dedupeEvidence([
          ...base.evidence,
          callEvidence,
          ...extShape.evidence,
        ]),
      };
    }

    if (methodName === "merge") {
      const otherArg = args[0];
      if (!otherArg) {
        return {
          ...base,
          evidence: dedupeEvidence([...base.evidence, callEvidence]),
        };
      }
      const other = await this.evaluateSchemaExpr(otherArg, visitedDecls);
      if (!other.recognized) {
        return {
          recognized: true,
          fields: base.fields,
          hasDynamicFields: true,
          gaps: dedupeGaps([
            ...base.gaps,
            {
              kind: "unresolved-schema",
              message: `Argument to .merge() could not be statically resolved as a Zod object schema.`,
              at: callSnap.location,
            },
          ]),
          evidence: dedupeEvidence([...base.evidence, callEvidence]),
        };
      }
      return {
        recognized: true,
        fields: { ...base.fields, ...other.fields },
        hasDynamicFields: base.hasDynamicFields || other.hasDynamicFields,
        gaps: dedupeGaps([...base.gaps, ...other.gaps]),
        evidence: dedupeEvidence([
          ...base.evidence,
          callEvidence,
          ...other.evidence,
        ]),
      };
    }

    if (methodName === "and") {
      const otherArg = args[0];
      if (!otherArg) {
        return base;
      }
      const other = await this.evaluateSchemaExpr(otherArg, visitedDecls);
      return this.#mergeIntersectionSchemas(
        callSnap.location,
        base,
        other,
        ".and()",
      );
    }

    if (methodName === "or") {
      const otherArg = args[0];
      if (!otherArg) {
        return base;
      }
      const other = await this.evaluateSchemaExpr(otherArg, visitedDecls);
      return this.#combineUnionBranches(
        callSnap.location,
        [base, other],
        ".or()",
      );
    }

    if (methodName === "pick") {
      const maskArg = args[0];
      if (!maskArg) {
        return {
          ...base,
          hasDynamicFields: true,
          gaps: dedupeGaps([
            ...base.gaps,
            {
              kind: "dynamic-schema-pick",
              message: ".pick() called without a static field mask.",
              at: callSnap.location,
            },
          ]),
          evidence: dedupeEvidence([...base.evidence, callEvidence]),
        };
      }
      const mask = await this.#evaluateBooleanMask(maskArg, visitedDecls);
      const picked: Record<string, FieldSchemaState> = {};
      const extraGaps: Gap[] = [...mask.gaps];
      let hasDynamic = mask.hasDynamic;

      for (const key of mask.keys) {
        const existing = base.fields[key];
        if (existing) {
          picked[key] = existing;
        } else if (base.hasDynamicFields) {
          hasDynamic = true;
          extraGaps.push({
            kind: "unresolved-schema-field",
            message: `Picked field "${key}" could not be statically resolved from base schema.`,
            at: callSnap.location,
          });
        }
      }
      return {
        recognized: true,
        fields: picked,
        hasDynamicFields: hasDynamic,
        gaps: dedupeGaps(
          mask.hasDynamic || base.hasDynamicFields
            ? [...base.gaps, ...extraGaps]
            : extraGaps,
        ),
        evidence: dedupeEvidence([...base.evidence, callEvidence]),
      };
    }

    if (methodName === "omit") {
      const maskArg = args[0];
      if (!maskArg) {
        return {
          ...base,
          hasDynamicFields: true,
          gaps: dedupeGaps([
            ...base.gaps,
            {
              kind: "dynamic-schema-omit",
              message: ".omit() called without a static field mask.",
              at: callSnap.location,
            },
          ]),
          evidence: dedupeEvidence([...base.evidence, callEvidence]),
        };
      }
      const mask = await this.#evaluateBooleanMask(maskArg, visitedDecls);
      const remaining: Record<string, FieldSchemaState> = {};
      for (const [key, info] of Object.entries(base.fields)) {
        if (!mask.keys.has(key)) {
          remaining[key] = info;
        }
      }
      return {
        recognized: true,
        fields: remaining,
        hasDynamicFields: base.hasDynamicFields || mask.hasDynamic,
        gaps: dedupeGaps([...base.gaps, ...mask.gaps]),
        evidence: dedupeEvidence([...base.evidence, callEvidence]),
      };
    }

    if (methodName === "partial" || methodName === "required") {
      const targetRequirement =
        methodName === "partial" ? "optional" : "required";
      const maskArg = args[0];
      let mask: BooleanMaskResult | undefined;
      if (maskArg) {
        const maskSnap = await this.unwrapExpression(maskArg);
        if (maskSnap && maskSnap.kind !== "UndefinedKeyword") {
          mask = await this.#evaluateBooleanMask(maskArg, visitedDecls);
        }
      }

      const updated: Record<string, FieldSchemaState> = {};
      for (const [key, info] of Object.entries(base.fields)) {
        const applies = mask === undefined || mask.keys.has(key);
        if (!applies) {
          updated[key] = info;
        } else {
          updated[key] = {
            ...info,
            inputRequirement: targetRequirement,
            outputPresence: targetRequirement,
            fromDefault: false,
          };
        }
      }
      return {
        recognized: true,
        fields: updated,
        hasDynamicFields: base.hasDynamicFields || (mask?.hasDynamic ?? false),
        gaps: dedupeGaps([...base.gaps, ...(mask?.gaps ?? [])]),
        evidence: dedupeEvidence([...base.evidence, callEvidence]),
      };
    }

    return base;
  }

  async #evaluateUnionSchema(
    callSnap: SyntaxSnapshot,
    branchesArg: SyntaxRef | undefined,
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedSchema> {
    if (!branchesArg) {
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "dynamic-schema-union",
            message: "Union schema has no static option array.",
            at: callSnap.location,
          },
        ],
        evidence: [
          {
            kind: "source",
            message: "Zod union schema",
            at: callSnap.location,
          },
        ],
      };
    }
    const arraySnap = await this.unwrapExpression(branchesArg);
    if (!arraySnap || arraySnap.kind !== "ArrayLiteralExpression") {
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "dynamic-schema-union",
            message: "Union schema options are not a static array literal.",
            at: callSnap.location,
          },
        ],
        evidence: [
          {
            kind: "source",
            message: "Zod union schema",
            at: callSnap.location,
          },
        ],
      };
    }
    const elements = await this.getDirectChildren(arraySnap.location);
    const branchSchemas: ExtractedSchema[] = [];
    for (const el of elements) {
      branchSchemas.push(await this.evaluateSchemaExpr(el.ref, visitedDecls));
    }
    return this.#combineUnionBranches(
      callSnap.location,
      branchSchemas,
      "union",
    );
  }

  #combineUnionBranches(
    loc: DiagnosticLocation,
    branches: readonly ExtractedSchema[],
    label: string,
  ): ExtractedSchema {
    if (branches.length === 0) {
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "dynamic-schema-union",
            message: `Empty ${label} schema has indeterminate fields.`,
            at: loc,
          },
        ],
        evidence: [{ kind: "source", message: `Zod ${label}`, at: loc }],
      };
    }

    let hasDynamic = branches.some(
      (branch) => !branch.recognized || branch.hasDynamicFields,
    );
    const gaps: Gap[] = branches.flatMap((b) => b.gaps);
    if (branches.some((b) => !b.recognized)) {
      gaps.push({
        kind: "dynamic-schema-union",
        message: `One or more branches of ${label} could not be statically resolved.`,
        at: loc,
      });
    }

    const allKeys = new Set<string>();
    for (const branch of branches) {
      for (const key of Object.keys(branch.fields)) {
        allKeys.add(key);
      }
    }

    const combinedFields: Record<string, FieldSchemaState> = {};
    for (const key of allKeys) {
      const presentInAll = branches.every((b) => b.fields[key] !== undefined);
      const reqInAll =
        presentInAll &&
        branches.every((b) => b.fields[key]!.inputRequirement === "required");
      const outReqInAll =
        presentInAll &&
        branches.every((b) => b.fields[key]!.outputPresence === "required");
      const nullableAny = branches.some(
        (b) => b.fields[key]?.nullable === true,
      );
      const allDefaulted =
        presentInAll &&
        branches.every((b) => b.fields[key]!.inputRequirement === "defaulted");
      const ev = dedupeEvidence(
        branches.flatMap((b) => b.fields[key]?.evidence ?? []),
      );

      combinedFields[key] = {
        name: key,
        inputRequirement: reqInAll
          ? "required"
          : allDefaulted
            ? "defaulted"
            : "optional",
        outputPresence: outReqInAll ? "required" : "optional",
        nullable: nullableAny,
        fromDefault:
          outReqInAll &&
          branches.some((b) => b.fields[key]?.fromDefault === true),
        evidence: ev,
      };
    }

    if (hasDynamic && allKeys.size === 0) {
      hasDynamic = true;
    }

    return {
      recognized: true,
      fields: combinedFields,
      hasDynamicFields: hasDynamic,
      gaps: dedupeGaps(gaps),
      evidence: dedupeEvidence([
        { kind: "source", message: `Zod ${label} schema`, at: loc },
        ...branches.flatMap((b) => b.evidence),
      ]),
    };
  }

  #mergeIntersectionSchemas(
    loc: DiagnosticLocation,
    left: ExtractedSchema,
    right: ExtractedSchema,
    label: string,
  ): ExtractedSchema {
    const hasDynamic =
      !left.recognized ||
      !right.recognized ||
      left.hasDynamicFields ||
      right.hasDynamicFields;
    const gaps: Gap[] = [...left.gaps, ...right.gaps];
    if (!left.recognized || !right.recognized) {
      gaps.push({
        kind: "unresolved-schema",
        message: `One side of ${label} could not be statically resolved.`,
        at: loc,
      });
    }
    const merged: Record<string, FieldSchemaState> = { ...left.fields };
    for (const [key, rightField] of Object.entries(right.fields)) {
      const leftField = merged[key];
      if (!leftField) {
        merged[key] = rightField;
        continue;
      }
      const inputReq: ValidatorInputFieldRequirement =
        leftField.inputRequirement === "required" ||
        rightField.inputRequirement === "required"
          ? "required"
          : leftField.inputRequirement === "defaulted" ||
              rightField.inputRequirement === "defaulted"
            ? "defaulted"
            : "optional";
      const outputPres: ValidatorOutputFieldPresence =
        leftField.outputPresence === "required" ||
        rightField.outputPresence === "required"
          ? "required"
          : "optional";
      merged[key] = {
        name: key,
        inputRequirement: inputReq,
        outputPresence: outputPres,
        nullable: leftField.nullable && rightField.nullable,
        fromDefault: leftField.fromDefault || rightField.fromDefault,
        evidence: dedupeEvidence([
          ...leftField.evidence,
          ...rightField.evidence,
        ]),
      };
    }
    return {
      recognized: left.recognized || right.recognized,
      fields: merged,
      hasDynamicFields: hasDynamic,
      gaps: dedupeGaps(gaps),
      evidence: dedupeEvidence([
        { kind: "source", message: `Zod ${label} schema`, at: loc },
        ...left.evidence,
        ...right.evidence,
      ]),
    };
  }

  async #evaluateShapeExpr(
    ref: SyntaxRef,
    visitedDecls: ReadonlySet<string>,
  ): Promise<ExtractedSchema> {
    const snap = await this.unwrapExpression(ref);
    if (!snap) {
      return {
        recognized: false,
        fields: {},
        hasDynamicFields: true,
        gaps: [],
        evidence: [],
      };
    }

    if (snap.kind === "Identifier") {
      const decl = await this.resolveDecl(snap.ref);
      if (
        decl.syntax &&
        !decl.isExternal &&
        !visitedDecls.has(decl.syntax.handleId)
      ) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.initializer) {
          return this.#evaluateShapeExpr(
            declSnap.initializer,
            new Set([...visitedDecls, decl.syntax.handleId]),
          );
        }
      }
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "dynamic-schema-shape",
            message: `Schema shape "${snap.text}" could not be statically resolved.`,
            at: snap.location,
          },
        ],
        evidence: [],
      };
    }

    if (
      snap.kind === "PropertyAccessExpression" &&
      snap.expression &&
      snap.name
    ) {
      const propName = await this.getSyntax(snap.name);
      if (propName?.text === "shape") {
        const schema = await this.evaluateSchemaExpr(
          snap.expression,
          visitedDecls,
        );
        if (schema.recognized) return schema;
      }
    }

    if (snap.kind !== "ObjectLiteralExpression") {
      return {
        recognized: true,
        fields: {},
        hasDynamicFields: true,
        gaps: [
          {
            kind: "dynamic-schema-shape",
            message: `Schema shape "${snap.text}" is not a static object literal.`,
            at: snap.location,
          },
        ],
        evidence: [],
      };
    }

    const directChildren = await this.getDirectChildren(snap.location);
    const fields: Record<string, FieldSchemaState> = {};
    const gaps: Gap[] = [];
    const evidence: Evidence[] = [];
    let hasDynamicFields = false;

    // Preload name/initializer/expression refs for direct object members in one batch
    const refsToPreload: SyntaxRef[] = [];
    for (const child of directChildren) {
      if (child.name) refsToPreload.push(child.name);
      if (child.initializer) refsToPreload.push(child.initializer);
      if (child.expression) refsToPreload.push(child.expression);
    }
    await this.preloadSyntax(refsToPreload);

    for (const child of directChildren) {
      if (
        child.kind === "PropertyAssignment" &&
        child.name &&
        child.initializer
      ) {
        const keyResult = await this.#resolvePropertyKey(
          child.name,
          child.location,
        );
        if (keyResult.key === null) {
          hasDynamicFields = true;
          if (keyResult.gap) gaps.push(keyResult.gap);
          continue;
        }
        const fieldEval = await this.#evaluateFieldModifiers(
          child.initializer,
          visitedDecls,
        );
        if (fieldEval.hasDynamicFields) hasDynamicFields = true;
        gaps.push(...fieldEval.gaps);
        fields[keyResult.key] = {
          name: keyResult.key,
          inputRequirement: fieldEval.inputRequirement,
          outputPresence: fieldEval.outputPresence,
          nullable: fieldEval.nullable,
          fromDefault: fieldEval.fromDefault,
          evidence: dedupeEvidence([
            {
              kind: "source",
              message: `Field "${keyResult.key}" defined in schema`,
              at: child.location,
            },
            ...fieldEval.evidence,
          ]),
        };
      } else if (child.kind === "ShorthandPropertyAssignment") {
        const keyName = child.name
          ? ((await this.getSyntax(child.name))?.text ?? child.text)
          : child.text;
        const decl = await this.resolveDecl(child.ref);
        if (decl.syntax && !decl.isExternal) {
          const declSnap = await this.getSyntax(decl.syntax);
          if (declSnap?.initializer) {
            const fieldEval = await this.#evaluateFieldModifiers(
              declSnap.initializer,
              visitedDecls,
            );
            if (fieldEval.hasDynamicFields) hasDynamicFields = true;
            gaps.push(...fieldEval.gaps);
            fields[keyName] = {
              name: keyName,
              inputRequirement: fieldEval.inputRequirement,
              outputPresence: fieldEval.outputPresence,
              nullable: fieldEval.nullable,
              fromDefault: fieldEval.fromDefault,
              evidence: dedupeEvidence([
                {
                  kind: "source",
                  message: `Field "${keyName}" defined in schema`,
                  at: child.location,
                },
                ...fieldEval.evidence,
              ]),
            };
            continue;
          }
        }
        hasDynamicFields = true;
        gaps.push({
          kind: "unresolved-schema-field",
          message: `Shorthand field "${keyName}" initializer could not be statically resolved.`,
          at: child.location,
        });
        fields[keyName] = {
          name: keyName,
          inputRequirement: "required",
          outputPresence: "required",
          nullable: false,
          fromDefault: false,
          evidence: [
            {
              kind: "source",
              message: `Field "${keyName}" defined in schema`,
              at: child.location,
            },
          ],
        };
      } else if (child.kind === "SpreadAssignment" && child.expression) {
        const spreadShape = await this.#evaluateShapeExpr(
          child.expression,
          visitedDecls,
        );
        if (
          spreadShape.hasDynamicFields &&
          Object.keys(spreadShape.fields).length === 0
        ) {
          hasDynamicFields = true;
          gaps.push({
            kind: "dynamic-schema-spread",
            message: `Spread "${child.text}" in Zod schema shape cannot be statically resolved.`,
            at: child.location,
          });
        } else {
          if (spreadShape.hasDynamicFields) hasDynamicFields = true;
          gaps.push(...spreadShape.gaps);
          Object.assign(fields, spreadShape.fields);
          evidence.push(...spreadShape.evidence);
        }
      } else {
        hasDynamicFields = true;
        gaps.push({
          kind: "dynamic-schema-field",
          message: `Unsupported dynamic member "${child.text}" (${child.kind}) in Zod schema shape.`,
          at: child.location,
        });
      }
    }

    return {
      recognized: true,
      fields,
      hasDynamicFields,
      gaps: dedupeGaps(gaps),
      evidence: dedupeEvidence(evidence),
    };
  }

  async #resolvePropertyKey(
    nameRef: SyntaxRef,
    memberLocation: DiagnosticLocation,
  ): Promise<{ readonly key: string | null; readonly gap?: Gap }> {
    const nameSnap = await this.getSyntax(nameRef);
    if (!nameSnap) {
      return {
        key: null,
        gap: {
          kind: "dynamic-schema-field",
          message: "Property key in Zod schema could not be inspected.",
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
          kind: "dynamic-schema-field",
          message: `Computed property name "${nameSnap.text}" in Zod schema cannot be statically resolved.`,
          at: nameSnap.location,
        },
      };
    }
    return {
      key: null,
      gap: {
        kind: "dynamic-schema-field",
        message: `Dynamic property key "${nameSnap.text}" (${nameSnap.kind}) cannot be statically resolved.`,
        at: nameSnap.location,
      },
    };
  }

  async #evaluateBooleanMask(
    ref: SyntaxRef,
    visitedDecls: ReadonlySet<string>,
  ): Promise<BooleanMaskResult> {
    const snap = await this.unwrapExpression(ref);
    if (!snap) {
      return {
        keys: new Set(),
        hasDynamic: true,
        gaps: [
          {
            kind: "dynamic-schema-mask",
            message: "Schema pick/omit mask could not be inspected.",
          },
        ],
      };
    }

    if (snap.kind === "Identifier") {
      const decl = await this.resolveDecl(snap.ref);
      if (
        decl.syntax &&
        !decl.isExternal &&
        !visitedDecls.has(decl.syntax.handleId)
      ) {
        const declSnap = await this.getSyntax(decl.syntax);
        if (declSnap?.initializer) {
          return this.#evaluateBooleanMask(
            declSnap.initializer,
            new Set([...visitedDecls, decl.syntax.handleId]),
          );
        }
      }
      return {
        keys: new Set(),
        hasDynamic: true,
        gaps: [
          {
            kind: "dynamic-schema-mask",
            message: `Schema mask "${snap.text}" could not be statically resolved.`,
            at: snap.location,
          },
        ],
      };
    }

    if (snap.kind !== "ObjectLiteralExpression") {
      return {
        keys: new Set(),
        hasDynamic: true,
        gaps: [
          {
            kind: "dynamic-schema-mask",
            message: `Schema mask "${snap.text}" is not a static object literal.`,
            at: snap.location,
          },
        ],
      };
    }

    const directChildren = await this.getDirectChildren(snap.location);
    const keys = new Set<string>();
    const gaps: Gap[] = [];
    let hasDynamic = false;

    for (const child of directChildren) {
      if (
        child.kind === "PropertyAssignment" &&
        child.name &&
        child.initializer
      ) {
        const resolvedKey = await this.#resolvePropertyKey(
          child.name,
          child.location,
        );
        if (resolvedKey.key === null) {
          hasDynamic = true;
          if (resolvedKey.gap) gaps.push(resolvedKey.gap);
          continue;
        }
        const initSnap = await this.unwrapExpression(child.initializer);
        const valText = initSnap?.text.trim() ?? "";
        if (valText === "true") {
          keys.add(resolvedKey.key);
        } else if (valText !== "false") {
          hasDynamic = true;
          gaps.push({
            kind: "dynamic-schema-mask",
            message: `Mask value for "${resolvedKey.key}" (${valText}) is not a static boolean literal.`,
            at: child.location,
          });
        }
      } else {
        hasDynamic = true;
        gaps.push({
          kind: "dynamic-schema-mask",
          message: `Dynamic mask entry "${child.text}" cannot be statically resolved.`,
          at: child.location,
        });
      }
    }

    return { keys, hasDynamic, gaps };
  }

  async #evaluateFieldModifiers(
    exprRef: SyntaxRef,
    visitedDecls: ReadonlySet<string>,
  ): Promise<EvaluatedFieldModifierResult> {
    const modifiers: string[] = [];
    let current = await this.unwrapExpression(exprRef);
    const seen = new Set<string>();
    let hasDynamicFields = false;
    const gaps: Gap[] = [];
    const evidence: Evidence[] = [];

    while (current && !seen.has(current.ref.handleId)) {
      seen.add(current.ref.handleId);

      if (current.kind === "Identifier") {
        const decl = await this.resolveDecl(current.ref);
        if (
          decl.syntax &&
          !decl.isExternal &&
          !visitedDecls.has(decl.syntax.handleId)
        ) {
          const declSnap = await this.getSyntax(decl.syntax);
          if (declSnap?.initializer) {
            current = await this.unwrapExpression(declSnap.initializer);
            continue;
          }
        }
        break;
      }

      if (current.kind !== "CallExpression" || !current.expression) {
        break;
      }

      const callee = await this.unwrapExpression(current.expression);
      if (
        !callee ||
        callee.kind !== "PropertyAccessExpression" ||
        !callee.expression ||
        !callee.name
      ) {
        break;
      }

      const methodSnap = await this.getSyntax(callee.name);
      const methodName = methodSnap?.text ?? "";

      // Static wrappers like z.optional(inner), z.default(inner, val), z.preprocess(fn, inner)
      if (
        STATIC_FIELD_WRAPPERS.has(methodName) &&
        (await this.isZodNamespace(callee.expression))
      ) {
        const args = current.arguments ?? [];
        const innerArg = methodName === "preprocess" ? args[1] : args[0];
        if (methodName !== "preprocess") {
          modifiers.push(methodName);
        }
        if (innerArg) {
          current = await this.unwrapExpression(innerArg);
          continue;
        }
        break;
      }

      if (FIELD_MODIFIER_METHODS.has(methodName)) {
        modifiers.push(methodName);
        current = await this.unwrapExpression(callee.expression);
        continue;
      }

      if (ZOD_DYNAMIC_BUILDERS.has(methodName)) {
        const isZ = await this.isZodNamespace(callee.expression);
        if (isZ) {
          hasDynamicFields = true;
          gaps.push({
            kind: "dynamic-schema-field",
            message: `Field uses dynamic Zod type z.${methodName}() whose constraints cannot be statically determined.`,
            at: current.location,
          });
        }
      }
      break;
    }

    let inputRequirement: ValidatorInputFieldRequirement = "required";
    let outputPresence: ValidatorOutputFieldPresence = "required";
    let nullable = false;
    let fromDefault = false;

    for (let i = modifiers.length - 1; i >= 0; i -= 1) {
      const mod = modifiers[i]!;
      switch (mod) {
        case "nullable": {
          nullable = true;
          break;
        }
        case "optional": {
          inputRequirement = "optional";
          outputPresence = "optional";
          fromDefault = false;
          break;
        }
        case "nullish": {
          inputRequirement = "optional";
          outputPresence = "optional";
          nullable = true;
          fromDefault = false;
          break;
        }
        case "default":
        case "prefault":
        case "catch": {
          inputRequirement = "defaulted";
          outputPresence = "required";
          fromDefault = true;
          break;
        }
        case "nonoptional": {
          inputRequirement = "required";
          outputPresence = "required";
          fromDefault = false;
          break;
        }
        default: {
          // .transform / .refine / .superRefine / .check / .pipe / .openapi / .describe / .meta / .brand / .readonly
          break;
        }
      }
    }

    return {
      inputRequirement,
      outputPresence,
      nullable,
      fromDefault,
      hasDynamicFields,
      gaps,
      evidence,
    };
  }
}

type ExtractedSite = {
  readonly subject: SyntaxRef;
  readonly siteKind: ValidatorSiteKind;
  readonly validatorMethod?: ValidatorMethodName;
  readonly schemaName?: string;
  readonly schema: ExtractedSchema;
};

async function collectSites(
  ctx: AdapterContext,
  evaluator: ZodAstEvaluator,
  request: FactExtractionRequest<
    ValidatorSubjectKind,
    ValidatorFieldsCondition | undefined
  >,
): Promise<readonly ExtractedSite[]> {
  const scope = request.condition?.scope ?? "all";
  const sites: ExtractedSite[] = [];

  if (request.targets !== undefined) {
    const rows = await ctx.syntaxOf(request.targets, {
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
    const toPreload: SyntaxRef[] = [];
    for (const row of rows) {
      if (row.syntax && row.kind && row.location) {
        evaluator.seedSyntaxNodes([
          {
            ref: row.syntax,
            kind: row.kind,
            text: row.text ?? "",
            location: row.location,
            ...(row.expression ? { expression: row.expression } : {}),
            ...(row.arguments ? { arguments: row.arguments } : {}),
            ...(row.name ? { name: row.name } : {}),
            ...(row.initializer ? { initializer: row.initializer } : {}),
            ...(row.body ? { body: row.body } : {}),
          },
        ]);
      }
      if (row.expression) toPreload.push(row.expression);
      if (row.name) toPreload.push(row.name);
      if (row.initializer) toPreload.push(row.initializer);
    }
    await evaluator.preloadSyntax(toPreload);

    for (const [index, row] of rows.entries()) {
      const targetRef = request.targets[index]!;
      if (!row.syntax || !row.kind || !row.location) continue;

      if (row.kind === "CallExpression" && row.expression) {
        const callee = await evaluator.unwrapExpression(row.expression);
        if (
          callee?.kind === "PropertyAccessExpression" &&
          callee.expression &&
          callee.name
        ) {
          const methodSnap = await evaluator.getSyntax(callee.name);
          const methodName = methodSnap?.text ?? "";
          if (VALIDATOR_METHODS.has(methodName)) {
            if (scope === "schemas") continue;
            const receiverSnap = await evaluator.unwrapExpression(
              callee.expression,
            );
            const schema = await evaluator.evaluateSchemaExpr(
              callee.expression,
            );
            if (!schema.recognized) continue;
            const schemaName =
              receiverSnap?.kind === "Identifier"
                ? receiverSnap.text
                : undefined;
            sites.push({
              subject: targetRef as SyntaxRef,
              siteKind: "call",
              validatorMethod: methodName,
              ...(schemaName !== undefined ? { schemaName } : {}),
              schema,
            });
            continue;
          }
        }
        if (scope === "calls") continue;
        const schema = await evaluator.evaluateSchemaExpr(row.syntax);
        if (schema.recognized) {
          sites.push({
            subject: targetRef as SyntaxRef,
            siteKind: "schema",
            schema,
          });
        }
        continue;
      }

      if (scope === "calls") continue;
      if (row.kind === "VariableDeclaration" && row.initializer) {
        const schema = await evaluator.evaluateSchemaExpr(row.initializer);
        if (schema.recognized) {
          const nameSnap = row.name
            ? await evaluator.getSyntax(row.name)
            : null;
          sites.push({
            subject: targetRef as SyntaxRef,
            siteKind: "schema",
            ...(nameSnap?.text ? { schemaName: nameSnap.text } : {}),
            schema,
          });
        }
        continue;
      }

      const schema = await evaluator.evaluateSchemaExpr(row.syntax);
      if (schema.recognized) {
        const schemaName =
          row.kind === "Identifier" && row.text !== null ? row.text : undefined;
        sites.push({
          subject: targetRef as SyntaxRef,
          siteKind: "schema",
          ...(schemaName !== undefined ? { schemaName } : {}),
          schema,
        });
      }
    }
    return sites;
  }

  // Project-wide extraction
  const syntaxNodes = await ctx.findSyntax({
    kinds: ["CallExpression", "VariableDeclaration"],
  });
  evaluator.seedSyntaxNodes(syntaxNodes);

  const calls = syntaxNodes.filter((n) => n.kind === "CallExpression");
  const varDecls = syntaxNodes.filter((n) => n.kind === "VariableDeclaration");

  const varInitSpans: DiagnosticLocation[] = [];
  const candidateVarDecls: SyntaxNodeResult[] = [];
  const preloadRefs: SyntaxRef[] = [];

  for (const decl of varDecls) {
    if (!decl.initializer) continue;
    candidateVarDecls.push(decl);
    preloadRefs.push(decl.initializer);
    if (decl.name) preloadRefs.push(decl.name);
  }

  const parseCalls: SyntaxNodeResult[] = [];
  const standaloneSchemaCalls: SyntaxNodeResult[] = [];
  for (const call of calls) {
    if (
      /\.(?:parse|safeParse|parseAsync|safeParseAsync)\s*\(/u.test(call.text)
    ) {
      parseCalls.push(call);
      if (call.expression) preloadRefs.push(call.expression);
    } else if (
      scope !== "calls" &&
      /(?:^|\.)(?:object|strictObject|looseObject|record|union|discriminatedUnion|intersection|extend|merge|pick|omit|partial|required|transform|refine|superRefine|pipe|openapi)\s*\(/u.test(
        call.text,
      )
    ) {
      standaloneSchemaCalls.push(call);
      if (call.expression) preloadRefs.push(call.expression);
    }
  }

  await evaluator.preloadSyntax(preloadRefs);

  if (scope !== "schemas") {
    const calleeExprRefs: SyntaxRef[] = [];
    for (const call of parseCalls) {
      if (call.expression) {
        const callee = await evaluator.getSyntax(call.expression);
        if (callee?.expression) calleeExprRefs.push(callee.expression);
        if (callee?.name) calleeExprRefs.push(callee.name);
      }
    }
    await evaluator.preloadSyntax(calleeExprRefs);

    for (const call of parseCalls) {
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
      const methodSnap = await evaluator.getSyntax(callee.name);
      const methodName = methodSnap?.text ?? "";
      if (!VALIDATOR_METHODS.has(methodName)) continue;

      const receiverSnap = await evaluator.unwrapExpression(callee.expression);
      const schema = await evaluator.evaluateSchemaExpr(callee.expression);
      if (!schema.recognized) continue;

      const schemaName =
        receiverSnap?.kind === "Identifier" ? receiverSnap.text : undefined;
      sites.push({
        subject: call.ref,
        siteKind: "call",
        validatorMethod: methodName,
        ...(schemaName !== undefined ? { schemaName } : {}),
        schema: {
          ...schema,
          evidence: dedupeEvidence([
            ...schema.evidence,
            {
              kind: "source",
              message: `Validator call .${methodName}()`,
              at: call.location,
            },
          ]),
        },
      });
    }
  }

  if (scope !== "calls") {
    for (const decl of candidateVarDecls) {
      if (!decl.initializer) continue;
      const initSnap = await evaluator.getSyntax(decl.initializer);
      if (!initSnap) continue;
      // Avoid duplicate extraction of pure variable aliases unless they wrap/compose a schema
      const schema = await evaluator.evaluateSchemaExpr(decl.initializer);
      if (!schema.recognized) continue;

      varInitSpans.push(initSnap.location);
      const nameSnap = decl.name ? await evaluator.getSyntax(decl.name) : null;
      sites.push({
        subject: decl.ref,
        siteKind: "schema",
        ...(nameSnap?.text ? { schemaName: nameSnap.text } : {}),
        schema,
      });
    }

    // Standalone schema expressions not assigned to any VariableDeclaration and not nested in an outer schema call
    const sortedSchemaCalls = standaloneSchemaCalls.toSorted((a, b) => {
      if (a.location.file !== b.location.file) {
        return a.location.file < b.location.file ? -1 : 1;
      }
      if (a.location.start !== b.location.start) {
        return a.location.start - b.location.start;
      }
      return b.location.end - a.location.end;
    });
    const emittedStandaloneSpans: DiagnosticLocation[] = [];

    for (const call of sortedSchemaCalls) {
      if (varInitSpans.some((span) => isSpanWithin(call.location, span))) {
        continue;
      }
      if (
        emittedStandaloneSpans.some((span) => isSpanWithin(call.location, span))
      ) {
        continue;
      }
      const schema = await evaluator.evaluateSchemaExpr(call.ref);
      if (!schema.recognized) continue;

      emittedStandaloneSpans.push(call.location);
      sites.push({
        subject: call.ref,
        siteKind: "schema",
        schema,
      });
    }
  }

  return sites;
}

export async function extractZodInputFieldFacts(
  ctx: AdapterContext,
  request: FactExtractionRequest<
    ValidatorSubjectKind,
    ValidatorFieldsCondition | undefined
  >,
): Promise<
  readonly FactContribution<
    ValidatorSubjectKind,
    ValidatorInputFieldsFactValue
  >[]
> {
  const evaluator = new ZodAstEvaluator(ctx);
  const sites = await collectSites(ctx, evaluator, request);
  return sites.map((site) => {
    const inputFields: Record<string, ValidatorInputFieldInfo> = {};
    for (const [name, field] of Object.entries(site.schema.fields)) {
      inputFields[name] = {
        name,
        requirement: field.inputRequirement,
        nullable: field.nullable,
        ...(field.evidence.length > 0 ? { evidence: field.evidence } : {}),
      };
    }
    return {
      subject: site.subject,
      value: buildInputFieldsValue({
        siteKind: site.siteKind,
        ...(site.validatorMethod !== undefined
          ? { validatorMethod: site.validatorMethod }
          : {}),
        ...(site.schemaName !== undefined
          ? { schemaName: site.schemaName }
          : {}),
        fields: inputFields,
        hasDynamicFields: site.schema.hasDynamicFields,
      }),
      evidence: site.schema.evidence,
      gaps: site.schema.gaps,
    };
  });
}

export async function extractZodOutputFieldFacts(
  ctx: AdapterContext,
  request: FactExtractionRequest<
    ValidatorSubjectKind,
    ValidatorFieldsCondition | undefined
  >,
): Promise<
  readonly FactContribution<
    ValidatorSubjectKind,
    ValidatorOutputFieldsFactValue
  >[]
> {
  const evaluator = new ZodAstEvaluator(ctx);
  const sites = await collectSites(ctx, evaluator, request);
  return sites.map((site) => {
    const outputFields: Record<string, ValidatorOutputFieldInfo> = {};
    for (const [name, field] of Object.entries(site.schema.fields)) {
      outputFields[name] = {
        name,
        presence: field.outputPresence,
        nullable: field.nullable,
        fromDefault: field.fromDefault,
        ...(field.evidence.length > 0 ? { evidence: field.evidence } : {}),
      };
    }
    return {
      subject: site.subject,
      value: buildOutputFieldsValue({
        siteKind: site.siteKind,
        ...(site.validatorMethod !== undefined
          ? { validatorMethod: site.validatorMethod }
          : {}),
        ...(site.schemaName !== undefined
          ? { schemaName: site.schemaName }
          : {}),
        fields: outputFields,
        hasDynamicFields: site.schema.hasDynamicFields,
      }),
      evidence: site.schema.evidence,
      gaps: site.schema.gaps,
    };
  });
}
