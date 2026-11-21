import * as ast from "tsrs/ast";

import type { Project } from "./project.ts";

export function scopeOf(
  node: ast.Node,
): ast.SourceFile | ast.FunctionLikeDeclaration {
  let parent = node.parent;
  while (!ast.isFunctionLikeDeclaration(parent) && !ast.isSourceFile(parent)) {
    parent = parent.parent;
  }
  return parent;
}

export function propertyName(node: ast.Node | undefined): string | undefined {
  if (
    node &&
    (ast.isIdentifier(node) ||
      ast.isStringLiteralLikeNode(node) ||
      ast.isNumericLiteral(node))
  ) {
    return node.text;
  }
  return undefined;
}

export function shortCircuit(kind: ast.SyntaxKind): boolean {
  return (
    ast.isLogicalOperator(kind) ||
    kind === ast.SyntaxKind.QuestionQuestionToken ||
    ast.isLogicalOrCoalescingAssignmentOperator(kind)
  );
}

interface Write {
  node: ast.Node;
  root: ast.Identifier;
  path: (string | undefined)[];
  value: ast.Node | undefined;
}

export interface Definition {
  /** Absent for the initial value of a parameter or declaration. */
  write?: Write;
  path: readonly string[];
  gap?: string;
  condition?: ast.Node;
}

function asWrite(node: ast.Node): Write | undefined {
  let target: ast.Node;
  let value: ast.Node | undefined;
  if (
    ast.isBinaryExpression(node) &&
    ast.isAssignmentOperator(node.operatorToken.kind)
  ) {
    target = node.left;
    value =
      node.operatorToken.kind === ast.SyntaxKind.EqualsToken ||
      ast.isLogicalOrCoalescingAssignmentOperator(node.operatorToken.kind)
        ? node.right
        : undefined;
  } else if (
    ast.isPostfixUnaryExpression(node) ||
    (ast.isPrefixUnaryExpression(node) &&
      (node.operator === ast.SyntaxKind.PlusPlusToken ||
        node.operator === ast.SyntaxKind.MinusMinusToken))
  ) {
    target = node.operand;
  } else {
    return undefined;
  }

  const path: (string | undefined)[] = [];
  while (
    ast.isPropertyAccessExpression(target) ||
    ast.isElementAccessExpression(target)
  ) {
    if (ast.isPropertyAccessExpression(target)) {
      path.unshift(target.name.text);
    } else if (
      ast.isStringLiteralLikeNode(target.argumentExpression) ||
      ast.isNumericLiteral(target.argumentExpression)
    ) {
      path.unshift(target.argumentExpression.text);
    } else {
      path.unshift(undefined);
    }
    target = target.expression;
  }
  if (!ast.isIdentifier(target)) return undefined;
  return { node, root: target, path, value };
}

const isUnstructured = (node: ast.Node) =>
  ast.isForStatement(node) ||
  ast.isForOfStatement(node) ||
  ast.isForInStatement(node) ||
  ast.isWhileStatement(node) ||
  ast.isDoStatement(node) ||
  ast.isSwitchStatement(node) ||
  ast.isTryStatement(node);

interface Alias {
  binding: ast.Node;
  path: readonly string[];
  certain: boolean;
}

function stableBinding(node: ast.Node): boolean {
  return (
    ast.isVariableDeclaration(node) &&
    (node.parent.flags & ast.NodeFlags.Const) !== 0
  );
}

/** Reaching definitions for a direct assignment to a binding or one of its named fields. */
export class ReachingWrites {
  private readonly scopes = new WeakMap<ast.Node, Map<string, Write[]>>();
  private readonly project: Project;
  private readonly aliasCache = new WeakMap<ast.Node, Alias[]>();

  constructor(project: Project) {
    this.project = project;
  }

  private inScope(scope: ast.Node): Map<string, Write[]> {
    const cached = this.scopes.get(scope);
    if (cached) return cached;
    const named = new Map<string, Write[]>();
    const visit = (node: ast.Node) => {
      if (node !== scope && ast.isFunctionLikeDeclaration(node)) return;
      const write = asWrite(node);
      if (write) {
        const writes = named.get(write.root.text) ?? [];
        writes.push(write);
        named.set(write.root.text, writes);
      }
      node.forEachChild(visit);
    };
    visit(scope);
    this.scopes.set(scope, named);
    return named;
  }

  // These aliases describe object references held by local bindings. A const-to-
  // const copy preserves identity. Mutable copies, selected operands, and call
  // results can alias an input, but their writes cannot prove a definite source.
  private aliases(binding: ast.Node, seen = new Set<ast.Node>()): Alias[] {
    const cached = this.aliasCache.get(binding);
    if (cached) return cached;
    const aliases: Alias[] = [{ binding, path: [], certain: true }];
    if (!ast.isVariableDeclaration(binding) || seen.has(binding))
      return aliases;
    seen.add(binding);
    const collect = (
      node: ast.Node,
      fields: readonly string[],
      certain: boolean,
    ): void => {
      if (ast.isIdentifier(node)) {
        const target = this.project.declaration(node);
        if (!target || seen.has(target)) return;
        for (const source of this.aliases(target, seen)) {
          aliases.push({
            binding: source.binding,
            path: [...source.path, ...fields],
            certain: certain && stableBinding(target) && source.certain,
          });
        }
      } else if (
        ast.isParenthesizedExpression(node) ||
        ast.isAsExpression(node) ||
        ast.isNonNullExpression(node) ||
        ast.isSatisfiesExpression(node) ||
        ast.isTypeAssertion(node)
      ) {
        collect(node.expression, fields, certain);
      } else if (ast.isPropertyAccessExpression(node)) {
        collect(node.expression, [node.name.text, ...fields], false);
      } else if (ast.isConditionalExpression(node)) {
        collect(node.whenTrue, fields, false);
        collect(node.whenFalse, fields, false);
      } else if (
        ast.isBinaryExpression(node) &&
        shortCircuit(node.operatorToken.kind)
      ) {
        collect(node.left, fields, false);
        collect(node.right, fields, false);
      } else if (ast.isCallExpression(node)) {
        for (const arg of node.arguments) collect(arg, fields, false);
        if (ast.isPropertyAccessExpression(node.expression))
          collect(node.expression.expression, fields, false);
      }
    };
    if (binding.initializer)
      collect(binding.initializer, [], stableBinding(binding));
    if (!stableBinding(binding) && ast.isIdentifier(binding.name)) {
      for (const write of this.inScope(scopeOf(binding)).get(
        binding.name.text,
      ) ?? []) {
        if (
          !write.path.length &&
          write.value &&
          this.project.declaration(write.root) === binding
        )
          collect(write.value, [], false);
      }
    }
    seen.delete(binding);
    // A recursive alias exploration can be truncated by its ancestor; only cache
    // a completed top-level query.
    if (!seen.size) this.aliasCache.set(binding, aliases);
    return aliases;
  }

  private fieldWrite(
    declaration: ast.Node,
    path: readonly string[],
    root: ast.Node,
    write: Write,
  ): Definition | undefined {
    let ambiguous: Definition | undefined;
    for (const source of this.aliases(declaration)) {
      for (const target of this.aliases(root)) {
        if (source.binding !== target.binding) continue;
        const read = [...source.path, ...path];
        const written = [...target.path, ...write.path];
        if (
          written.length > read.length ||
          written.some((field, i) => field !== undefined && read[i] !== field)
        )
          continue;
        if (source.certain && target.certain && !written.includes(undefined)) {
          return { write, path: read.slice(written.length) };
        }
        ambiguous = {
          path,
          gap: "A write through a possible object alias or computed field may replace this value.",
        };
      }
    }
    return ambiguous;
  }

  at(
    declaration: ast.VariableOrParameterDeclaration,
    use: ast.Node,
    path: readonly string[],
  ): Definition[] {
    const initial: Definition = { path };
    if (!ast.isIdentifier(declaration.name)) return [initial];
    const scope = scopeOf(declaration);
    const indexed = this.inScope(scope);
    const sameScope = scope === scopeOf(use);
    const start = use.getStart();
    const applicable = new Map<ast.Node, Definition>();
    const candidates = path.length
      ? [...indexed.values()].flat()
      : (indexed.get(declaration.name.text) ?? []);
    for (const write of candidates) {
      if (
        (sameScope && write.node.end > start) ||
        (write.path.length > 0 && path.length === 0)
      )
        continue;
      const root = this.project.declaration(write.root);
      if (!root) continue;
      if (root === declaration && !write.path.length) {
        applicable.set(write.node, { write, path });
      } else if (path.length && write.path.length) {
        const definition = this.fieldWrite(declaration, path, root, write);
        if (definition) applicable.set(write.node, definition);
      }
    }
    if (!applicable.size) return [initial];
    if (!sameScope) {
      return [
        {
          path,
          gap: "The execution order of writes to this captured binding is unknown.",
        },
      ];
    }

    // Visit only ancestors of writes and of the read. A complete straight-line write
    // kills earlier definitions, whereas an if/else keeps the last write on each arm.
    const relevant = new Set<ast.Node>();
    for (const node of [...applicable.keys(), use]) {
      let current = node;
      while (!relevant.has(current)) {
        relevant.add(current);
        if (current === scope) break;
        current = current.parent;
      }
    }
    const join = (
      left: Definition[],
      right: Definition[],
      condition: ast.Node,
    ) => {
      const combined = [...new Set([...left, ...right])];
      if (combined.length < 2) return combined;
      return combined.map((value) =>
        value.condition ? value : { ...value, condition },
      );
    };
    let result: Definition[] | undefined;
    function walk(node: ast.Node, incoming: Definition[]): Definition[] {
      if (!relevant.has(node) || result) return incoming;
      if (node === use) {
        result = incoming;
        return incoming;
      }
      const assigned = applicable.get(node);
      // The RHS of a logical operator executes on only one path. Logical
      // assignment also keeps the old binding on the path that skips the RHS.
      if (
        ast.isBinaryExpression(node) &&
        shortCircuit(node.operatorToken.kind)
      ) {
        const left = walk(node.left, incoming);
        const right = walk(node.right, left);
        return join(left, assigned ? [assigned] : right, node.left);
      }
      if (
        (ast.isCallExpression(node) || ast.isElementAccessExpression(node)) &&
        node.flags & ast.NodeFlags.OptionalChain
      ) {
        const receiver = walk(node.expression, incoming);
        const optional = ast.isCallExpression(node)
          ? node.arguments
          : [node.argumentExpression];
        let executed = receiver;
        for (const operand of optional) executed = walk(operand, executed);
        return join(receiver, executed, node.expression);
      }
      if (assigned)
        return assigned.gap ? join(incoming, [assigned], node) : [assigned];
      if (ast.isIfStatement(node) || ast.isConditionalExpression(node)) {
        const [condition, yes, no] = ast.isIfStatement(node)
          ? [node.expression, node.thenStatement, node.elseStatement]
          : [node.condition, node.whenTrue, node.whenFalse];
        const start = walk(condition, incoming);
        return join(walk(yes, start), no ? walk(no, start) : start, condition);
      }
      let state = incoming;
      const uncertain =
        isUnstructured(node) &&
        [...applicable.keys()].some(
          (candidate) => candidate.pos >= node.pos && candidate.end <= node.end,
        );
      node.forEachChild((child) => {
        state = walk(child, state);
      });
      if (uncertain) {
        const unknown: Definition = {
          path,
          gap: "Control flow through this write is not modeled.",
        };
        // A read inside the construct and a subsequent read can both be affected.
        // A later unconditional assignment outside the construct kills this uncertainty.
        if (result) result = [...new Set([...result, ...incoming, unknown])];
        state = [...new Set([...state, ...incoming, unknown])];
      }
      return state;
    }
    walk(scope, [initial]);
    return result ?? [initial];
  }
}
