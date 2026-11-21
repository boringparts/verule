import * as ast from "tsrs/ast";

import { propertyName, ReachingWrites, shortCircuit } from "./flow-writes.ts";
import type { Project, SymbolRef } from "./project.ts";

type Location = ReturnType<Project["location"]>;

interface ModelTarget {
  target: SymbolRef;
  /** Apply the behavior to the function returned by this factory, e.g. builder()(options). */
  resultCall?: boolean;
}

export type Model = ModelTarget &
  ({ behavior: "fresh" } | { behavior: "returns-argument"; argument: number });

export interface FlowEvidence {
  kind: "source" | "model" | "approximation";
  location: Location;
  message: string;
}

export interface FlowGap {
  location: Location;
  message: string;
  evidence: FlowEvidence[];
}

export interface FlowOrigin {
  node: ast.Node;
  /** The named fields still projected from this source. */
  path: readonly string[];
  /** Equal for the same source, projection, and invocation context within this snapshot. */
  key: string;
  /** Present only when each execution is known to produce a new object. */
  identity?: string;
  evidence: FlowEvidence[];
}

export interface FlowResult {
  origins: FlowOrigin[];
  gaps: FlowGap[];
}

export interface TraceOptions {
  path?: readonly string[];
  /** Treat the selected values as sources, preserving any field projection. */
  stopAt?: readonly ast.Node[];
  /** Follow known callers of unbound parameters. The default is a symbolic parameter source. */
  followCallers?: boolean;
  /** Resume inside the invocation that produced an earlier query's source. */
  from?: FlowOrigin;
}

interface Frame {
  call: ast.CallExpression;
  fn: ast.FunctionLikeDeclaration;
}

function implementation(
  target: ast.Node | undefined,
): ast.FunctionLikeDeclaration | undefined {
  if (!target) return undefined;
  if (ast.isVariableDeclaration(target)) target = target.initializer;
  return target && ast.isFunctionLikeDeclaration(target) ? target : undefined;
}

function positionalArgument(
  call: ast.CallExpression,
  index: number,
): ast.Node | undefined {
  // Spreads before this position also make its static index ambiguous.
  if (call.arguments.slice(0, index + 1).some(ast.isSpreadElement))
    return undefined;
  return call.arguments[index];
}

function returnValues(fn: ast.FunctionLikeDeclaration): ast.Node[] {
  if (!fn.body) return [];
  if (!ast.isBlock(fn.body)) return [fn.body];
  const values: ast.Node[] = [];
  const visit = (node: ast.Node) => {
    if (ast.isFunctionLikeDeclaration(node)) return;
    if (ast.isReturnStatement(node)) {
      if (node.expression) values.push(node.expression);
      return;
    }
    node.forEachChild(visit);
  };
  visit(fn.body);
  return values;
}

function lexicalFrames(
  node: ast.Node,
  frames: readonly Frame[],
): readonly Frame[] {
  // A global declaration read inside a helper still denotes the original allocation.
  // Captured locals retain the frame of the enclosing function that created them.
  let parent: ast.Node = node;
  while (!ast.isSourceFile(parent)) {
    if (ast.isFunctionLikeDeclaration(parent)) {
      const index = frames.findLastIndex((frame) => frame.fn === parent);
      if (index !== -1) return frames.slice(0, index + 1);
    }
    parent = parent.parent;
  }
  return [];
}

/** Snapshot-scoped backward queries for exact-value flow. Each path is ordered source to use. */
export class Flow {
  private readonly project: Project;
  private readonly writes: ReachingWrites;
  private readonly directModels = new Map<ast.Node, Model>();
  private readonly resultModels = new Map<ast.Node, Model>();
  private readonly contexts = new WeakMap<FlowOrigin, readonly Frame[]>();
  private readonly returnCache = new WeakMap<
    ast.FunctionLikeDeclaration,
    ast.Node[]
  >();
  private readonly locationCache = new WeakMap<ast.Node, Location>();

  constructor(project: Project, models: readonly Model[] = []) {
    this.project = project;
    this.writes = new ReachingWrites(project);
    for (const model of models) {
      if (
        model.behavior === "returns-argument" &&
        (!Number.isSafeInteger(model.argument) || model.argument < 0)
      ) {
        throw new Error(
          "A returns-argument model requires a nonnegative argument index.",
        );
      }
      const target = project.resolveSymbol(model.target);
      if (!target) continue;
      const map = model.resultCall ? this.resultModels : this.directModels;
      if (map.has(target))
        throw new Error(`Conflicting models for ${model.target.name}.`);
      map.set(target, model);
    }
  }

  private location(node: ast.Node): Location {
    let location = this.locationCache.get(node);
    if (!location) {
      location = this.project.location(node);
      this.locationCache.set(node, location);
    }
    return location;
  }

  private step(
    node: ast.Node,
    message: string,
    kind: FlowEvidence["kind"] = "source",
  ): FlowEvidence {
    return { kind, message, location: this.location(node) };
  }

  trace(expr: ast.Node, options: TraceOptions = {}): FlowResult {
    const origins = new Map<string, FlowOrigin>();
    const gaps = new Map<string, FlowGap>();
    const stops = new Set(options.stopAt);
    const active = new Set<string>();
    const startFrames = options.from && this.contexts.get(options.from);
    if (options.from && !startFrames)
      throw new Error("The flow source belongs to a different snapshot.");
    const stamp = (node: ast.Node) => {
      const loc = this.location(node);
      return [loc.file, loc.start, loc.end];
    };
    const key = (
      node: ast.Node,
      path: readonly string[],
      frames: readonly Frame[],
    ) =>
      JSON.stringify([
        stamp(node),
        path,
        frames.map((frame) => stamp(frame.call)),
      ]);
    const gap = (node: ast.Node, message: string, evidence: FlowEvidence[]) => {
      const location = this.location(node);
      gaps.set(JSON.stringify([stamp(node), message]), {
        location,
        message,
        evidence: [...evidence].reverse(),
      });
    };
    const origin = (
      node: ast.Node,
      path: readonly string[],
      frames: readonly Frame[],
      evidence: FlowEvidence[],
      fresh = false,
    ) => {
      const id = key(node, path, frames);
      if (origins.has(id)) return;
      const value: FlowOrigin = {
        node,
        path,
        key: id,
        evidence: [...evidence].reverse(),
      };
      if (fresh && !path.length) value.identity = id;
      origins.set(id, value);
      this.contexts.set(value, frames);
    };
    const follow = (
      node: ast.Node,
      path: readonly string[],
      frames: readonly Frame[],
      trail: FlowEvidence[],
    ) => {
      const token = key(node, path, frames);
      if (active.has(token) || active.size >= 192) {
        gap(
          node,
          "A cyclic or excessively deep flow path could not be resolved.",
          trail,
        );
        return;
      }
      active.add(token);
      try {
        visit(node, path, frames, trail);
      } finally {
        active.delete(token);
      }
    };
    const visit = (
      node: ast.Node,
      path: readonly string[],
      frames: readonly Frame[],
      trail: FlowEvidence[],
    ): void => {
      const steps = (
        message: string,
        kind: FlowEvidence["kind"] = "source",
      ) => [...trail, this.step(node, message, kind)];
      if (stops.has(node)) {
        origin(node, path, frames, steps("Selected source."));
        return;
      }
      if (
        ast.isParenthesizedExpression(node) ||
        ast.isAsExpression(node) ||
        ast.isSatisfiesExpression(node) ||
        ast.isTypeAssertion(node) ||
        ast.isNonNullExpression(node)
      ) {
        follow(node.expression, path, frames, trail);
        return;
      }
      if (ast.isPropertyAccessExpression(node)) {
        follow(
          node.expression,
          [node.name.text, ...path],
          frames,
          steps(`Read field ${node.name.text}.`),
        );
        return;
      }
      if (ast.isElementAccessExpression(node)) {
        if (
          ast.isStringLiteralLikeNode(node.argumentExpression) ||
          ast.isNumericLiteral(node.argumentExpression)
        ) {
          follow(
            node.expression,
            [node.argumentExpression.text, ...path],
            frames,
            steps("Read a named field."),
          );
        } else {
          gap(node, "The computed field name is unknown.", trail);
        }
        return;
      }
      if (
        ast.isBinaryExpression(node) &&
        node.operatorToken.kind === ast.SyntaxKind.EqualsToken
      ) {
        follow(node.right, path, frames, steps("Result of an assignment."));
        return;
      }
      if (
        ast.isConditionalExpression(node) ||
        (ast.isBinaryExpression(node) && shortCircuit(node.operatorToken.kind))
      ) {
        const arms = ast.isConditionalExpression(node)
          ? [node.whenTrue, node.whenFalse]
          : [node.left, node.right];
        for (const arm of arms)
          follow(arm, path, frames, steps("Possible branch.", "approximation"));
        return;
      }
      if (ast.isObjectLiteralExpression(node)) {
        if (path.length === 0) {
          origin(node, path, frames, steps("Object literal allocation."), true);
          return;
        }
        for (const field of [...node.properties].reverse()) {
          if (ast.isSpreadAssignment(field)) {
            gap(
              field,
              "A spread can supply or replace the requested field.",
              trail,
            );
            return;
          }
          if (
            ast.isPropertyAssignment(field) ||
            ast.isShorthandPropertyAssignment(field)
          ) {
            const name = propertyName(field.name);
            if (name === undefined) {
              gap(
                field,
                "A computed property may replace the requested field.",
                trail,
              );
              return;
            }
            if (name !== path[0]) continue;
            follow(
              ast.isPropertyAssignment(field) ? field.initializer : field.name,
              path.slice(1),
              frames,
              [...trail, this.step(field, `Initialize field ${name}.`)],
            );
            return;
          }
        }
        gap(
          node,
          "The object has no modeled initializer for this field.",
          trail,
        );
        return;
      }
      if (ast.isIdentifier(node)) {
        const declaration = this.project.declaration(node);
        if (!declaration) {
          gap(node, "The value declaration could not be resolved.", trail);
          return;
        }
        const enclosing = lexicalFrames(declaration, frames);
        if (stops.has(declaration)) {
          origin(declaration, path, enclosing, steps("Read selected binding."));
          return;
        }
        if (
          ast.isVariableDeclaration(declaration) ||
          ast.isParameterDeclaration(declaration)
        ) {
          const definitions = this.writes.at(declaration, node, path);
          for (const definition of definitions) {
            const evidence = definition.condition
              ? [
                  ...trail,
                  this.step(
                    definition.condition,
                    "This branch may supply the reaching definition.",
                    "approximation",
                  ),
                ]
              : definitions.length > 1
                ? steps("A branch may supply this definition.", "approximation")
                : trail;
            if (definition.gap) {
              gap(node, definition.gap, evidence);
            } else if (definition.write) {
              const write = definition.write;
              const assigned = [
                ...evidence,
                this.step(write.node, "Write reaches this read."),
              ];
              if (write.value)
                follow(write.value, definition.path, enclosing, assigned);
              else origin(write.node, definition.path, enclosing, assigned);
            } else if (ast.isParameterDeclaration(declaration)) {
              const param = declaration;
              const fn = param.parent;
              if (!ast.isFunctionLikeDeclaration(fn)) {
                gap(
                  node,
                  "Parameter has no callable implementation.",
                  evidence,
                );
                continue;
              }
              const i = fn.parameters.indexOf(param);
              const bound = enclosing.at(-1);
              if (bound && bound.fn === fn) {
                const arg = positionalArgument(bound.call, i);
                const boundEvidence = [
                  ...evidence,
                  this.step(param, "Parameter of this invocation."),
                  this.step(bound.call, "Bind call argument."),
                ];
                if (arg && !param.dotDotDotToken)
                  follow(
                    arg,
                    definition.path,
                    enclosing.slice(0, -1),
                    boundEvidence,
                  );
                else
                  gap(
                    bound.call,
                    "This argument binding is unavailable.",
                    boundEvidence,
                  );
              } else if (options.followCallers) {
                // A named arrow/function expression is indexed under its immutable
                // variable binding. Inline functions have their own call target.
                let assigned: ast.Node = fn;
                while (
                  ast.isAsExpression(assigned.parent) ||
                  ast.isSatisfiesExpression(assigned.parent) ||
                  ast.isParenthesizedExpression(assigned.parent) ||
                  ast.isNonNullExpression(assigned.parent) ||
                  ast.isTypeAssertion(assigned.parent)
                )
                  assigned = assigned.parent;
                const target =
                  ast.isVariableDeclaration(assigned.parent) &&
                  assigned.parent.initializer === assigned
                    ? assigned.parent
                    : fn;
                const callers = this.project.callsTo(target);
                if (!callers.length)
                  gap(
                    param,
                    "No direct caller was resolved for this parameter.",
                    evidence,
                  );
                for (const call of callers) {
                  const arg = positionalArgument(call, i);
                  if (arg && !param.dotDotDotToken)
                    follow(
                      arg,
                      definition.path,
                      [],
                      [
                        ...evidence,
                        this.step(
                          call,
                          "Argument from a possible caller.",
                          "approximation",
                        ),
                      ],
                    );
                  else
                    gap(
                      call,
                      "This argument binding is unavailable.",
                      evidence,
                    );
                }
              } else {
                origin(param, definition.path, enclosing, [
                  ...evidence,
                  this.step(param, "Symbolic parameter source."),
                ]);
              }
            } else if (declaration.initializer) {
              follow(declaration.initializer, definition.path, enclosing, [
                ...evidence,
                this.step(declaration, "Initialize binding."),
              ]);
            } else {
              gap(
                declaration,
                "No reaching initializer or assignment was found.",
                evidence,
              );
            }
          }
        } else {
          gap(node, "Value flow for this binding is not modeled.", trail);
        }
        return;
      }
      if (ast.isCallExpression(node)) {
        const target = this.project.callTarget(node);
        let model = target && this.directModels.get(target);
        if (
          !model &&
          ast.isCallExpression(node.expression) &&
          this.resultModels.size > 0
        ) {
          const factory = this.project.callTarget(node.expression);
          model = factory && this.resultModels.get(factory);
        }
        if (model?.behavior === "fresh") {
          origin(
            node,
            path,
            frames,
            steps(
              `Model: ${model.target.name} produces a fresh instance.`,
              "model",
            ),
            true,
          );
          return;
        }
        if (model?.behavior === "returns-argument") {
          const arg = positionalArgument(node, model.argument);
          const evidence = steps(
            `Model: ${model.target.name} returns argument ${model.argument}.`,
            "model",
          );
          if (arg) follow(arg, path, frames, evidence);
          else
            gap(
              node,
              "The argument selected by the model is unavailable.",
              evidence,
            );
          return;
        }
        const fn = implementation(target);
        if (!fn?.body) {
          gap(
            node,
            !target
              ? "The call target could not be resolved."
              : "Return behavior is unavailable for this declaration.",
            trail,
          );
          return;
        }
        if (frames.some((frame) => frame.fn === fn)) {
          gap(node, "Recursive return flow is not modeled.", trail);
          return;
        }
        let values = this.returnCache.get(fn);
        if (!values) {
          values = returnValues(fn);
          this.returnCache.set(fn, values);
        }
        const next = [...frames, { call: node, fn }];
        for (const value of values) {
          const proof = steps("Result of a direct call.");
          proof.push(
            this.step(
              value,
              values.length > 1 ? "Possible return." : "Return value.",
              values.length > 1 ? "approximation" : "source",
            ),
          );
          follow(value, path, next, proof);
        }
        return;
      }
      if (
        ast.isBinaryExpression(node) ||
        ast.isTemplateExpression(node) ||
        ast.isPrefixUnaryExpression(node) ||
        ast.isLiteralExpression(node) ||
        ast.isBooleanLiteral(node) ||
        ast.isNullLiteral(node) ||
        ast.isArrayLiteralExpression(node)
      ) {
        origin(node, path, frames, steps("This expression produces a value."));
        return;
      }
      gap(node, "Value flow for this expression is not modeled.", trail);
    };
    follow(expr, options.path ?? [], startFrames ?? [], [
      this.step(expr, "Queried value."),
    ]);
    return { origins: [...origins.values()], gaps: [...gaps.values()] };
  }
}
