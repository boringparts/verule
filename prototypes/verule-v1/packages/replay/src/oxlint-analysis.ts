import { dirname, relative, resolve } from "node:path";

import ts from "typescript";

type FunctionBody =
  | ts.FunctionDeclaration
  | ts.ArrowFunction
  | ts.FunctionExpression;
interface Frame {
  call: ts.CallExpression;
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
  node: ts.Node;
  fields: readonly string[];
  frame: Frame | undefined;
  key: string;
  evidence: readonly ts.Node[];
  reason: string;
}

function unwrap(value: ts.Expression): ts.Expression {
  while (
    ts.isAsExpression(value) ||
    ts.isTypeAssertionExpression(value) ||
    ts.isSatisfiesExpression(value) ||
    ts.isParenthesizedExpression(value) ||
    ts.isNonNullExpression(value)
  )
    value = value.expression;
  return value;
}

function lexicalFunction(node: ts.Node): ts.Node | undefined {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isFunctionLike(parent)) return parent;
  }
  return undefined;
}

function frameAt(node: ts.Node, frame: Frame | undefined): Frame | undefined {
  const owner = lexicalFunction(node);
  while (frame && frame.fn !== owner) frame = frame.outer;
  return frame;
}

function nodeKey(node: ts.Node): string {
  return node.getSourceFile().fileName + ":" + node.getStart();
}

function outcome(
  kind: Origin["kind"],
  node: ts.Node,
  fields: readonly string[],
  frame: Frame | undefined,
  evidence: readonly ts.Node[],
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

function singleReturn(fn: FunctionBody): ts.Expression | undefined {
  if (!fn.body) return undefined;
  if (!ts.isBlock(fn.body)) return fn.body;
  const returns: ts.ReturnStatement[] = [];
  function visit(node: ts.Node): void {
    if (ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node)) returns.push(node);
    else ts.forEachChild(node, visit);
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
  readonly program: ts.Program;
  private readonly checker: ts.TypeChecker;
  readonly parse: ts.Declaration;
  readonly execute: ts.Declaration;
  readonly createBuilder: ts.Declaration;
  readonly validate: ts.Declaration;
  readonly dispatch: ts.Declaration;
  private readonly targets = new WeakMap<
    ts.CallExpression,
    ts.Declaration | undefined
  >();
  private readonly returns = new WeakMap<
    FunctionBody,
    ts.Expression | undefined
  >();

  constructor(config: string) {
    this.root = dirname(config);
    const configData = ts.readConfigFile(config, (file) =>
      ts.sys.readFile(file),
    );
    if (configData.error)
      throw new Error(
        ts.flattenDiagnosticMessageText(configData.error.messageText, "\n"),
      );
    const parsed = ts.parseJsonConfigFileContent(
      configData.config,
      ts.sys,
      this.root,
      {},
      config,
    );
    if (parsed.errors.length)
      throw new Error(
        parsed.errors
          .map((error) =>
            ts.flattenDiagnosticMessageText(error.messageText, "\n"),
          )
          .join("\n"),
      );
    this.program = ts.createProgram({
      rootNames: parsed.fileNames,
      options: parsed.options,
    });
    this.checker = this.program.getTypeChecker();
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

  point(node: ts.Node): Point {
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

  private binding(symbol: ts.Symbol | undefined): ts.Declaration | undefined {
    if (!symbol) return undefined;
    if (symbol.flags & ts.SymbolFlags.Alias)
      symbol = this.checker.getAliasedSymbol(symbol);
    const declarations = symbol.declarations ?? [];
    return (
      declarations.find((d) => ts.isFunctionDeclaration(d) && d.body) ??
      symbol.valueDeclaration ??
      declarations[0]
    );
  }

  private named(path: string, name: string): ts.Declaration {
    const file = this.program.getSourceFile(resolve(this.root, path));
    if (file) {
      const module = this.checker.getSymbolAtLocation(file);
      if (module) {
        const value = this.binding(
          this.checker
            .getExportsOfModule(module)
            .find((symbol) => symbol.name === name),
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

  target(call: ts.CallExpression): ts.Declaration | undefined {
    if (this.targets.has(call)) return this.targets.get(call);
    const expression = unwrap(call.expression);
    let decl =
      ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)
        ? expression
        : this.binding(this.checker.getSymbolAtLocation(expression));
    const seen = new Set<ts.Node>();
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
      decl = this.binding(this.checker.getSymbolAtLocation(value));
    }
    this.targets.set(call, decl);
    return decl;
  }

  trace(
    node: ts.Expression,
    fields: readonly string[] = [],
    stop?: ts.Declaration,
    frame?: Frame,
    evidence: readonly ts.Node[] = [],
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
      ts.isStringLiteralLike(value.argumentExpression)
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
          !(ts.isIdentifier(prop.name) || ts.isStringLiteralLike(prop.name)) ||
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
        ? this.checker.getShorthandAssignmentValueSymbol(value.parent)
        : this.checker.getSymbolAtLocation(value);
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
      if (decl && ts.isParameter(decl)) {
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
