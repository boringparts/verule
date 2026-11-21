import { dirname } from "node:path";

import type * as syntax from "typescript-7/unstable/ast";
import type { Checker, Program } from "typescript-7/unstable/sync";

export type ComparisonCompiler = "tsgo" | "tsrs";

interface CompilerProject {
  program: Pick<Program, "getSourceFile">;
  checker: Pick<
    Checker,
    | "getSymbolAtLocation"
    | "getAliasedSymbol"
    | "getMemberInModuleExports"
    | "getShorthandAssignmentValueSymbol"
  >;
}

interface Compiler {
  ast: Pick<
    typeof syntax,
    | "NodeFlags"
    | "isAsExpression"
    | "isTypeAssertion"
    | "isSatisfiesExpression"
    | "isParenthesizedExpression"
    | "isNonNullExpression"
    | "isFunctionLikeDeclaration"
    | "isBlock"
    | "isReturnStatement"
    | "isFunctionDeclaration"
    | "isArrowFunction"
    | "isFunctionExpression"
    | "isVariableDeclaration"
    | "isIdentifier"
    | "isPropertyAccessExpression"
    | "isElementAccessExpression"
    | "isStringLiteralLikeNode"
    | "isObjectLiteralExpression"
    | "isSpreadAssignment"
    | "isComputedPropertyName"
    | "isPropertyAssignment"
    | "isShorthandPropertyAssignment"
    | "isParameterDeclaration"
    | "isSpreadElement"
    | "isCallExpression"
  >;
  aliasFlag: number;
  open(config: string): CompilerProject;
}

async function loadCompiler(name: string | undefined): Promise<Compiler> {
  if (name === "tsgo") {
    const [ast, { API, SymbolFlags, DiagnosticCategory }] = await Promise.all([
      import("typescript-7/unstable/ast"),
      import("typescript-7/unstable/sync"),
    ]);
    return {
      ast,
      aliasFlag: SymbolFlags.Alias,
      open(config) {
        const api = new API({ cwd: dirname(config) });
        process.prependOnceListener("exit", () => api.close());
        const project = api
          .updateSnapshot({ openProjects: [config] })
          .getProject(config);
        if (!project) throw new Error(`No TypeScript project for ${config}`);
        const errors = project.program
          .getConfigFileParsingDiagnostics()
          .filter((d) => d.category === DiagnosticCategory.Error);
        if (errors.length)
          throw new Error(errors.map((d) => d.text).join("\n"));
        return project;
      },
    };
  }
  if (name === "tsrs") {
    const [ast, { API, SymbolFlags, DiagnosticCategory, formatDiagnostics }] =
      await Promise.all([import("tsrs/ast"), import("tsrs/sync")]);
    // tsrs adds members to nodes and gives symbols a distinct nominal type. The
    // rule uses the common TS7 subset and always keeps guards, nodes and checker
    // from the same compiler, including its own SyntaxKind and NodeFlags values.
    return {
      ast,
      aliasFlag: SymbolFlags.Alias,
      open(config: string) {
        const api = new API({ cwd: dirname(config) });
        process.prependOnceListener("exit", () => api.close());
        const project = api
          .createSnapshot({ openProjects: [config] })
          .getConfiguredProject(config);
        if (!project) throw new Error(`No tsrs project for ${config}`);
        const errors = project.program
          .getConfigFileParsingDiagnostics()
          .filter((d) => d.category === DiagnosticCategory.Error);
        if (errors.length)
          throw new Error(formatDiagnostics(errors, project.program));
        return project;
      },
    } as unknown as Compiler;
  }
  throw new Error("Set VERULE_COMPARISON_COMPILER to tsgo or tsrs.");
}

// Oxlint's JS parserServices has no checker. Both rules share this worker's
// native session; loading only the selected module keeps cold timings comparable.
export const compiler = await loadCompiler(
  process.env.VERULE_COMPARISON_COMPILER,
);
export const ts = compiler.ast;
