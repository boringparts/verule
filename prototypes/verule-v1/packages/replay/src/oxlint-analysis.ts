import { dirname, relative, resolve } from "node:path";

import type * as ast from "typescript-7/unstable/ast";
import type { Symbol as NativeSymbol } from "typescript-7/unstable/sync";

import { compiler, ts } from "./oxlint-compiler.ts";

type FunctionBody =
  | ast.FunctionDeclaration
  | ast.ArrowFunction
  | ast.FunctionExpression;
interface Frame {
  call: ast.CallExpression;
  fn: FunctionBody;
  outer: Frame | undefined;
}

export interface Point {
  file: string;
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

export interface Origin {
  kind: "fresh" | "boundary" | "parameter" | "unknown";
  node: ast.Node;
  fields: readonly string[];
  frame: Frame | undefined;
  key: string;
  evidence: readonly ast.Node[];
  reason: string;
}

function unwrap(value: ast.Expression): ast.Expression {
  while (
    ts.isAsExpression(value) ||
    ts.isTypeAssertion(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isNonNullExpression(value)
  )
    value = value.expression;
  return value;
}

function lexicalFunction(node: ast.Node): ast.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLikeDeclaration(parent)) return parent;
  }
  return undefined;
}

function frameAt(node: ast.Node, frame: Frame | undefined): Frame | undefined {
  const owner = lexicalFunction(node);
  while (frame && frame.fn !== owner) frame = frame.outer;
  return frame;
}

function nodeKey(node: ast.Node): string {
  return node.getSourceFile().fileName + ":" + node.getStart();
}

function outcome(
  kind: Origin["kind"],
  node: ast.Node,
  fields: readonly string[],
  frame: Frame | undefined,
  evidence: readonly ast.Node[],
  reason = "",
): Origin {
  // Two visits to the same factory body through different callers allocate distinct objects.
  const activation: string[] = [];
  for (let step = frame; step; step = step.outer)
    activation.push(nodeKey(step.call));
  return {
    kind,
    node,
    fields,
    frame,
    evidence: [...evidence, node],
    reason,
    key: JSON.stringify([kind, nodeKey(node), fields, activation]),
  };
}

function singleReturn(fn: FunctionBody): ast.Expression | undefined {
  if (!fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;
  const returns: ast.ReturnStatement[] = [];
  function visit(node: ast.Node): void {
    if (ts.isFunctionLikeDeclaration(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    else node.forEachChild(visit);
  }
  visit(fn.body);
  const only = returns[0];
  return returns.length === 1 && only?.parent === fn.body
    ? only.expression
    : undefined;
}

/** Compiler and call-frame machinery supplied by the comparison plugin itself. */
export class ComparisonProject {
  readonly root: string;
  private readonly native: ReturnType<typeof compiler.open>;
  private readonly callLists = new WeakMap<
    ast.SourceFile,
    ast.CallExpression[]
  >();
  private readonly references = new WeakMap<
    ast.Node,
    NativeSymbol | undefined
  >();
  private readonly declarations = new WeakMap<
    NativeSymbol,
    ast.Node | undefined
  >();
  readonly parse: ast.Node;
  readonly execute: ast.Node;
  readonly createBuilder: ast.Node;
  readonly validate: ast.Node;
  readonly dispatch: ast.Node;
  private readonly targets = new WeakMap<
    ast.CallExpression,
    ast.Node | undefined
  >();
  private readonly returns = new WeakMap<
    FunctionBody,
    ast.Expression | undefined
  >();

  constructor(config: string) {
    this.root = dirname(config);
    this.native = compiler.open(config);
    this.parse = this.named("src/index.ts", "parseCliInvocation");
    this.execute = this.named("src/index.ts", "executeCli");
    this.createBuilder = this.named("src/index.ts", "defineCli");
    this.validate = this.named(
      "src/cli-input-validation.ts",
      "validateCliInput",
    );
    this.dispatch = this.named(
      "src/cli-execution.ts",
      "executeApplicationResult",
    );
  }

  point(node: ast.Node): Point {
    const file = node.getSourceFile();
    const start = node.getStart(file);
    const end = node.getEnd();
    const first = file.getLineAndCharacterOfPosition(start);
    const last = file.getLineAndCharacterOfPosition(end);
    return {
      file: relative(this.root, file.fileName).replaceAll("\\", "/"),
      start,
      end,
      line: first.line + 1,
      column: first.character + 1,
      endLine: last.line + 1,
      endColumn: last.character + 1,
    };
  }

  private binding(symbol: NativeSymbol | undefined): ast.Node | undefined {
    if (!symbol) return undefined;
    if (this.declarations.has(symbol)) return this.declarations.get(symbol);
    let node: ast.Node | undefined;
    if (symbol.flags & compiler.aliasFlag) {
      this.declarations.set(symbol, undefined);
      node = this.binding(this.native.checker.getAliasedSymbol(symbol));
    } else {
      node = (symbol.valueDeclaration ?? symbol.declarations[0])?.resolve();
      if (
        symbol.declarations.length > 1 &&
        node &&
        ts.isFunctionDeclaration(node)
      ) {
        for (const item of symbol.declarations) {
          const candidate = item.resolve();
          if (
            candidate &&
            ts.isFunctionDeclaration(candidate) &&
            candidate.body
          ) {
            node = candidate;
            break;
          }
        }
      }
    }
    this.declarations.set(symbol, node);
    return node;
  }

  calls(filename: string): readonly ast.CallExpression[] {
    const file = this.native.program.getSourceFile(filename);
    if (!file) return [];
    const cached = this.callLists.get(file);
    if (cached) return cached;
    const calls: ast.CallExpression[] = [];
    function visit(node: ast.Node) {
      if (ts.isCallExpression(node)) calls.push(node);
      node.forEachChild(visit);
    }
    visit(file);
    // The checker lives in a separate native process. Resolve one file's
    // syntactic call heads in one request and share the result across rules.
    if (calls.length) {
      const heads = calls.map((call) => unwrap(call.expression));
      const symbols = this.native.checker.getSymbolAtLocation(heads);
      heads.forEach((head, index) => this.references.set(head, symbols[index]));
    }
    this.callLists.set(file, calls);
    return calls;
  }

  private symbolAt(node: ast.Node) {
    if (!this.references.has(node)) {
      this.references.set(node, this.native.checker.getSymbolAtLocation(node));
    }
    return this.references.get(node);
  }

  private named(path: string, name: string): ast.Node {
    const file = this.native.program.getSourceFile(resolve(this.root, path));
    if (file) {
      const module = this.symbolAt(file);
      if (module) {
        const value = this.binding(
          this.native.checker.getMemberInModuleExports(module, name),
        );
        if (value) return value;
      }
      for (const item of file.statements) {
        if (ts.isFunctionDeclaration(item) && item.name?.text === name)
          return item;
      }
    }
    throw new Error(`Cannot resolve comparison target '${name}' in '${path}'.`);
  }

  target(call: ast.CallExpression): ast.Node | undefined {
    if (this.targets.has(call)) return this.targets.get(call);
    const expression = unwrap(call.expression);
    let decl =
      ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
        ? expression
        : this.binding(this.symbolAt(expression));
    const seen = new Set<ast.Node>();
    while (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
      if (seen.has(decl) || !(decl.parent.flags & ts.NodeFlags.Const)) {
        decl = undefined;
        break;
      }
      seen.add(decl);
      const value = unwrap(decl.initializer);
      if (ts.isArrowFunction(value) || ts.isFunctionExpression(value)) {
        decl = value;
        break;
      }
      if (!ts.isIdentifier(value) && !ts.isPropertyAccessExpression(value))
        break;
      decl = this.binding(this.symbolAt(value));
    }
    this.targets.set(call, decl);
    return decl;
  }

  trace(
    node: ast.Expression,
    fields: readonly string[] = [],
    stop?: ast.Node,
    frame?: Frame,
    evidence: readonly ast.Node[] = [],
  ): Origin {
    const value = unwrap(node);
    const gap = (reason: string) =>
      outcome("unknown", value, fields, frame, evidence, reason);
    if (evidence.length >= 100)
      return gap("Recursive or excessively deep forwarding.");
    const path = [...evidence, value];
    if (ts.isPropertyAccessExpression(value))
      return this.trace(
        value.expression,
        [value.name.text, ...fields],
        stop,
        frame,
        path,
      );
    if (
      ts.isElementAccessExpression(value) &&
      ts.isStringLiteralLikeNode(value.argumentExpression)
    ) {
      return this.trace(
        value.expression,
        [value.argumentExpression.text, ...fields],
        stop,
        frame,
        path,
      );
    }
    if (ts.isObjectLiteralExpression(value)) {
      if (!fields.length)
        return outcome("fresh", value, fields, frame, evidence);
      for (const prop of value.properties.toReversed()) {
        if (
          ts.isSpreadAssignment(prop) ||
          (prop.name && ts.isComputedPropertyName(prop.name))
        ) {
          return gap(
            "An object spread or computed property may overwrite this field.",
          );
        }
        if (
          !prop.name ||
          !(
            ts.isIdentifier(prop.name) || ts.isStringLiteralLikeNode(prop.name)
          ) ||
          prop.name.text !== fields[0]
        )
          continue;
        if (ts.isPropertyAssignment(prop))
          return this.trace(
            prop.initializer,
            fields.slice(1),
            stop,
            frame,
            path,
          );
        if (ts.isShorthandPropertyAssignment(prop))
          return this.trace(prop.name, fields.slice(1), stop, frame, path);
        break;
      }
      return gap("Cannot resolve this object field.");
    }
    if (ts.isIdentifier(value)) {
      const symbol = ts.isShorthandPropertyAssignment(value.parent)
        ? this.native.checker.getShorthandAssignmentValueSymbol(value.parent)
        : this.symbolAt(value);
      const decl = this.binding(symbol);
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer) {
        if (!(decl.parent.flags & ts.NodeFlags.Const))
          return gap("Mutable local requires reaching definitions.");
        return this.trace(
          decl.initializer,
          fields,
          stop,
          frameAt(decl, frame),
          path,
        );
      }
      if (decl && ts.isParameterDeclaration(decl)) {
        const owner = frameAt(decl, frame);
        if (owner) {
          const index = owner.fn.parameters.indexOf(decl);
          const arg = owner.call.arguments[index];
          if (arg && !ts.isSpreadElement(arg))
            return this.trace(arg, fields, stop, owner.outer, path);
          return gap("No direct actual argument for this parameter.");
        }
        return outcome("parameter", decl, fields, undefined, path);
      }
      return gap("No immutable value binding.");
    }
    if (ts.isCallExpression(value)) {
      const fn = this.target(value);
      if (stop && fn === stop)
        return outcome("boundary", value, fields, frame, evidence);
      if (
        ts.isCallExpression(value.expression) &&
        this.target(value.expression) === this.createBuilder
      ) {
        if (fields.length)
          return gap("The factory model describes identity only.");
        return outcome("fresh", value, fields, frame, evidence);
      }
      if (
        !fn ||
        !(
          ts.isFunctionDeclaration(fn) ||
          ts.isArrowFunction(fn) ||
          ts.isFunctionExpression(fn)
        ) ||
        !fn.body
      ) {
        return gap("The callee has no modeled or readable body.");
      }
      if (!this.returns.has(fn)) this.returns.set(fn, singleReturn(fn));
      const returned = this.returns.get(fn);
      if (!returned)
        return gap("The callee does not have a single direct return.");
      return this.trace(
        returned,
        fields,
        stop,
        { call: value, fn, outer: frame },
        path,
      );
    }
    return gap(
      "Value is outside the comparison plugin's direct-forwarding subset.",
    );
  }
}
