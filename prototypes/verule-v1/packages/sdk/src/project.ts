import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import * as ast from "tsrs/ast";
import {
  API,
  DiagnosticCategory,
  formatDiagnostics,
  SymbolFlags,
  type Project as CompilerProject,
  type Snapshot,
  type Symbol as CompilerSymbol,
} from "tsrs/sync";

export interface SymbolRef {
  /** Absolute or relative to the directory containing the selected tsconfig. */
  file: string;
  name: string;
}

export interface SourceLocation {
  file: string;
  /** Half-open UTF-16 code unit offsets. Lines and columns are one-based. */
  start: number;
  end: number;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}

interface ProjectFiles {
  paths: readonly string[];
  sources: readonly ast.SourceFile[];
}

function configuredProject(
  snapshot: Snapshot,
  config: string,
): CompilerProject {
  const project = snapshot.getConfiguredProject(config);
  if (!project)
    throw new Error(`Could not open TypeScript project '${config}'.`);
  const errors = project.program
    .getConfigFileParsingDiagnostics()
    .filter((diagnostic) => diagnostic.category === DiagnosticCategory.Error);
  if (errors.length)
    throw new Error(formatDiagnostics(errors, project.program).trim());
  return project;
}

/** Expressions for which the compiler's symbol can identify the lexical callee. */
function calleeExpression(expression: ast.Expression): ast.Expression {
  while (
    ast.isAsExpression(expression) ||
    ast.isParenthesizedExpression(expression) ||
    ast.isNonNullExpression(expression) ||
    ast.isSatisfiesExpression(expression) ||
    ast.isTypeAssertion(expression)
  ) {
    expression = expression.expression;
  }
  return expression;
}

// Semantic facts are valid for one project snapshot. A caller can change its meaning
// without changing its own syntax (e.g. when a barrel changes its re-export).
class SemanticIndex {
  readonly declarations = new Map<CompilerSymbol, ast.Node | undefined>();
  readonly references = new WeakMap<ast.Node, ast.Node | undefined>();
  readonly calls = new WeakMap<ast.CallExpression, ast.Node | undefined>();
  readonly literals = new WeakMap<ast.Node, readonly string[] | undefined>();
  byTarget: Map<ast.Node, ast.CallExpression[]> | undefined;
}

/** Owns a single compiler process. Use returned nodes only during the current analysis. */
export class Project {
  readonly tsconfig: string;
  readonly directory: string;
  private readonly api: API;
  private snapshot: Snapshot;
  private compiler: CompilerProject;
  private files: ProjectFiles | undefined;
  private currentSources = new WeakSet<ast.SourceFile>();
  private semantic = new SemanticIndex();
  private syntaxCalls = new WeakMap<ast.SourceFile, ast.CallExpression[]>();
  private localTargets = new WeakMap<ast.CallExpression, ast.Node>();
  private readonly pendingChanges = new Set<string>();
  private closed = false;

  constructor(tsconfig: string) {
    this.tsconfig = resolve(tsconfig);
    this.directory = dirname(this.tsconfig);
    if (!existsSync(this.tsconfig))
      throw new Error(`Missing TypeScript project '${this.tsconfig}'.`);
    this.api = new API({ cwd: this.directory });
    try {
      this.snapshot = this.api.createSnapshot({
        openProjects: [this.tsconfig],
      });
      this.compiler = configuredProject(this.snapshot, this.tsconfig);
    } catch (error) {
      this.api.close();
      throw error;
    }
  }

  /** Compiler-only access for measuring primitive fact reads against the same tsconfig. */
  get raw(): CompilerProject {
    return this.compiler;
  }

  private projectFiles(): ProjectFiles {
    if (this.files) return this.files;
    const program = this.compiler.program;
    const names = program.getSourceFileNames();
    const metadata = this.api.batch(
      ...names.map((file) => program.getSourceFileMetadata.gen(file)),
    );
    const paths = names
      .filter((_, i) => {
        const entry = metadata[i];
        return entry && !entry.isDefaultLibrary && !entry.isFromExternalLibrary;
      })
      .sort();
    const sources = this.api.batch(
      ...paths.map((file) => program.getSourceFile.gen(file)),
    );
    this.files = {
      paths,
      sources: sources.map((file, i) => {
        if (!file)
          throw new Error(`Could not read project source '${paths[i]}'.`);
        this.currentSources.add(file);
        return file;
      }),
    };
    return this.files;
  }

  /** Includes project-owned declaration files and imported sources outside the root directory. */
  get sourceFiles(): readonly ast.SourceFile[] {
    return this.projectFiles().sources;
  }

  get filePaths(): readonly string[] {
    return this.projectFiles().paths;
  }

  update(changedPaths: readonly string[]): void {
    for (const file of changedPaths)
      this.pendingChanges.add(resolve(this.directory, file));
    if (!this.pendingChanges.size) return;
    const known = new Set<string>(this.compiler.program.getSourceFileNames());
    known.add(this.tsconfig);
    const changed: string[] = [];
    const created: string[] = [];
    const deleted: string[] = [];
    for (const file of this.pendingChanges) {
      if (!existsSync(file)) deleted.push(file);
      else if (known.has(file)) changed.push(file);
      else created.push(file);
    }
    // Request the configured project again so tsrs materializes its new program.
    // File notifications alone can return a new snapshot carrying the old program.
    const next = this.snapshot.update({
      openProjects: [this.tsconfig],
      fileNotifications: { changed, created, deleted },
    });
    const previous = this.snapshot;
    try {
      const compiler = configuredProject(next, this.tsconfig);
      this.compiler = compiler;
      this.snapshot = next;
      this.files = undefined;
      this.currentSources = new WeakSet();
      this.semantic = new SemanticIndex();
      this.pendingChanges.clear();
    } catch (error) {
      if (next !== previous) next.dispose();
      throw error;
    }
    if (next !== previous) previous.dispose();
  }

  /** Discards Verule-derived indexes while keeping the same compiler session. */
  clearAnalysisCache(): void {
    this.syntaxCalls = new WeakMap();
    this.localTargets = new WeakMap();
    this.semantic = new SemanticIndex();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.snapshot.dispose();
    } finally {
      this.api.close();
    }
  }

  /** Unchanged interned source files may be shared by successive snapshots. */
  assertCurrent(node: ast.Node): ast.SourceFile {
    if (this.closed) throw new Error("The project snapshot has been closed.");
    const source = node.getSourceFile();
    if (!this.currentSources.has(source)) {
      // External declarations also belong to the program even though they are
      // excluded from the list of files scanned for rule candidates.
      if (
        !source ||
        this.compiler.program.getSourceFileByPath(source.path) !== source
      ) {
        throw new Error(
          "The node does not belong to the current project snapshot.",
        );
      }
      this.currentSources.add(source);
    }
    return source;
  }

  location(node: ast.Node): SourceLocation {
    const source = this.assertCurrent(node);
    const start = node.getStart(source);
    const end = node.getEnd();
    const first = source.getLineAndCharacterOfPosition(start);
    const last = source.getLineAndCharacterOfPosition(end);
    return {
      file: relative(this.directory, source.fileName).split(sep).join("/"),
      start,
      end,
      line: first.line + 1,
      column: first.character + 1,
      endLine: last.line + 1,
      endColumn: last.character + 1,
    };
  }

  private symbolDeclaration(
    symbol: CompilerSymbol | undefined,
  ): ast.Node | undefined {
    if (!symbol) return undefined;
    const cache = this.semantic.declarations;
    if (cache.has(symbol)) return cache.get(symbol);
    if (symbol.flags & SymbolFlags.Alias) {
      cache.set(symbol, undefined);
      const declaration = this.symbolDeclaration(
        this.compiler.checker.getAliasedSymbol(symbol),
      );
      cache.set(symbol, declaration);
      return declaration;
    }
    let declaration = (
      symbol.valueDeclaration ?? symbol.declarations[0]
    )?.resolve(this.compiler);
    if (
      declaration &&
      symbol.declarations.length > 1 &&
      ast.isFunctionLikeDeclaration(declaration)
    ) {
      for (const handle of symbol.declarations) {
        const candidate = handle.resolve(this.compiler);
        if (
          candidate &&
          ast.isFunctionLikeDeclaration(candidate) &&
          candidate.body
        ) {
          declaration = candidate;
          break;
        }
      }
    }
    cache.set(symbol, declaration);
    return declaration;
  }

  /** Looks up an export (including re-exports), then a file-local top-level binding. */
  resolveSymbol(ref: SymbolRef): ast.Node | undefined {
    const file = this.compiler.program.getSourceFile(
      resolve(this.directory, ref.file),
    );
    if (!file) return undefined;
    const checker = this.compiler.checker;
    const module = checker.getSymbolAtLocation(file);
    const exported =
      module && checker.getMemberInModuleExports(module, ref.name);
    if (exported) return this.symbolDeclaration(exported);
    const local = checker.resolveName(
      ref.name,
      SymbolFlags.Value | SymbolFlags.Type | SymbolFlags.Alias,
      file,
      true,
    );
    return this.symbolDeclaration(local);
  }

  /** A shorthand property's name resolves to the value binding captured by that property. */
  declaration(node: ast.Node): ast.Node | undefined {
    this.assertCurrent(node);
    const cache = this.semantic.references;
    if (cache.has(node)) return cache.get(node);
    const checker = this.compiler.checker;
    const shorthand = ast.isShorthandPropertyAssignment(node)
      ? node
      : node.parent;
    const symbol =
      shorthand &&
      ast.isShorthandPropertyAssignment(shorthand) &&
      (shorthand === node || shorthand.name === node)
        ? checker.getShorthandAssignmentValueSymbol(shorthand)
        : checker.getSymbolAtLocation(node);
    const declaration = this.symbolDeclaration(symbol);
    cache.set(node, declaration);
    return declaration;
  }

  private directTarget(binding: ast.Node | undefined): ast.Node | undefined {
    const seen = new Set<ast.Node>();
    while (binding && ast.isVariableDeclaration(binding)) {
      if (!(binding.parent.flags & ast.NodeFlags.Const) || seen.has(binding))
        return undefined;
      seen.add(binding);
      if (!binding.initializer) return binding;
      const value = calleeExpression(binding.initializer);
      if (ast.isArrowFunction(value) || ast.isFunctionExpression(value))
        return binding;
      if (!ast.isIdentifier(value) && !ast.isPropertyAccessExpression(value))
        return undefined;
      binding = this.declaration(value);
    }
    // A receiver's static class can name a method whose runtime override is unknown.
    return binding &&
      (ast.isFunctionDeclaration(binding) ||
        ast.isFunctionExpression(binding) ||
        ast.isArrowFunction(binding))
      ? binding
      : undefined;
  }

  /** Resolves direct calls, including immutable function aliases. Dynamic calls have no unique target. */
  callTarget(call: ast.CallExpression): ast.Node | undefined {
    this.assertCurrent(call);
    const local = this.localTargets.get(call);
    if (local) return local;
    const cache = this.semantic.calls;
    if (cache.has(call)) return cache.get(call);
    const callee = calleeExpression(call.expression);
    const target =
      ast.isArrowFunction(callee) || ast.isFunctionExpression(callee)
        ? callee
        : this.directTarget(this.declaration(callee));
    cache.set(call, target);
    return target;
  }

  private callsIn(source: ast.SourceFile): ast.CallExpression[] {
    const existing = this.syntaxCalls.get(source);
    if (existing) return existing;
    const calls: ast.CallExpression[] = [];
    function visit(node: ast.Node): void {
      if (ast.isCallExpression(node)) calls.push(node);
      node.forEachChild(visit);
    }
    visit(source);
    // tsrs interns SourceFiles by path, content and parse options. Syntax-only
    // traversal can therefore be reused even when a dependency invalidates types.
    this.syntaxCalls.set(source, calls);
    return calls;
  }

  callsTo(target: ast.Node): readonly ast.CallExpression[] {
    this.assertCurrent(target);
    if (!this.semantic.byTarget) {
      const index = new Map<ast.Node, ast.CallExpression[]>();
      for (const source of this.sourceFiles) {
        const calls = this.callsIn(source);
        if (!calls.length) continue;
        const unresolved = calls.filter((call) => !this.localTargets.has(call));
        const expressions = unresolved.map((call) =>
          calleeExpression(call.expression),
        );
        const symbols = expressions.length
          ? this.compiler.checker.getSymbolAtLocation(expressions)
          : [];
        for (const [i, call] of unresolved.entries()) {
          const expression = expressions[i]!;
          const symbol = symbols[i];
          const binding = this.symbolDeclaration(symbol);
          this.semantic.references.set(expression, binding);
          // Only a lexical binding in this exact external-module AST survives a
          // dependency edit. Imports, aliases, property types and global scripts
          // must go back through the new checker, including previous misses.
          if (
            source.externalModuleIndicator &&
            ast.isIdentifier(expression) &&
            symbol &&
            !(symbol.flags & SymbolFlags.Alias) &&
            binding &&
            binding.getSourceFile() === source &&
            this.callTarget(call) === binding
          ) {
            this.localTargets.set(call, binding);
          }
        }
        for (const call of calls) {
          const declaration =
            this.localTargets.get(call) ?? this.callTarget(call);
          if (!declaration) continue;
          const list = index.get(declaration);
          if (list) list.push(call);
          else index.set(declaration, [call]);
        }
      }
      this.semantic.byTarget = index;
    }
    return (
      this.semantic.byTarget.get(this.directTarget(target) ?? target) ?? []
    );
  }

  /** Undefined means the checker cannot enumerate every possible string at this point. */
  literalStrings(node: ast.Node): readonly string[] | undefined {
    this.assertCurrent(node);
    const cache = this.semantic.literals;
    if (cache.has(node)) return cache.get(node);
    const type = this.compiler.checker.getTypeAtLocation(node);
    const members = type.isUnionType() ? type.getTypes() : [type];
    const values: string[] = [];
    for (const member of members) {
      if (!member.isStringLiteralType()) {
        cache.set(node, undefined);
        return undefined;
      }
      values.push(member.value);
    }
    cache.set(node, values);
    return values;
  }
}
