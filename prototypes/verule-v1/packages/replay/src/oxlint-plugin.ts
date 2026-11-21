import { resolve } from "node:path";

import type * as ast from "typescript-7/unstable/ast";

import {
  ComparisonProject,
  type Origin,
  type Point,
} from "./oxlint-analysis.ts";
import { ts } from "./oxlint-compiler.ts";

type RuleName = "contract-instance" | "validated-input";

export interface ComparisonFinding {
  kind: "violation" | "unknown";
  ruleId: `cli/${RuleName}`;
  location: Point;
  reason: string;
  evidence: Point[];
}

function finding(
  project: ComparisonProject,
  ruleName: RuleName,
  kind: ComparisonFinding["kind"],
  node: ast.Node,
  reason: string,
  evidence: readonly ast.Node[],
): ComparisonFinding {
  return {
    kind,
    ruleId: `cli/${ruleName}`,
    location: project.point(node),
    reason,
    evidence: [...new Set(evidence)].map((item) => project.point(item)),
  };
}

function compareInstance(
  project: ComparisonProject,
  call: ast.CallExpression,
): ComparisonFinding | undefined {
  const [contract, options] = call.arguments;
  if (!contract || !options) return undefined;
  const invocation = project.trace(options, ["invocation"], project.parse);
  const unknown = (origin: Origin) =>
    finding(
      project,
      "contract-instance",
      "unknown",
      origin.node,
      origin.reason ||
        "Cannot establish the issuing and executing allocation identities.",
      origin.evidence,
    );
  if (
    invocation.kind !== "boundary" ||
    invocation.fields.length ||
    !ts.isCallExpression(invocation.node)
  )
    return unknown(invocation);
  const source = invocation.node.arguments[0];
  if (!source) return unknown(invocation);
  const issuer = project.trace(source, [], undefined, invocation.frame);
  const receiver = project.trace(contract);
  // A repeated read of the same parameter is enough to establish equality.
  if (
    issuer.kind === "parameter" &&
    receiver.kind === "parameter" &&
    issuer.key === receiver.key
  )
    return undefined;
  if (issuer.kind !== "fresh") return unknown(issuer);
  if (receiver.kind !== "fresh") return unknown(receiver);
  if (issuer.key === receiver.key) return undefined;
  return finding(
    project,
    "contract-instance",
    "violation",
    contract,
    "The invocation was issued by a different contract instance.",
    [...invocation.evidence, ...issuer.evidence, ...receiver.evidence],
  );
}

function compareInput(
  project: ComparisonProject,
  call: ast.CallExpression,
): ComparisonFinding | undefined {
  const input = call.arguments[2];
  const options = call.arguments[3];
  if (!input || !options) return undefined;
  const actual = project.trace(input, [], project.validate);
  if (
    actual.kind === "boundary" &&
    actual.fields.length === 1 &&
    actual.fields[0] === "value"
  )
    return undefined;
  const raw = project.trace(options, ["invocation", "input"]);
  if (actual.kind !== "unknown" && actual.key === raw.key) {
    return finding(
      project,
      "validated-input",
      "violation",
      input,
      "Raw invocation input bypasses the validated output.",
      [...actual.evidence, ...raw.evidence],
    );
  }
  return finding(
    project,
    "validated-input",
    "unknown",
    actual.node,
    actual.reason || "Cannot establish a validated input source.",
    actual.evidence,
  );
}

interface LintPosition {
  line: number;
  column: number;
}
interface PluginContext {
  filename: string;
  cwd: string;
  report(diagnostic: {
    loc: { start: LintPosition; end: LintPosition };
    message: string;
  }): void;
}

// Oxlint owns worker and file lifetimes. A one-thread replay constructs the
// selected native compiler session once and shares it across both plugin rules.
let shared: ComparisonProject | undefined;

function rule(name: RuleName) {
  return {
    meta: { type: "problem" },
    create(context: PluginContext) {
      return {
        Program() {
          shared ??= new ComparisonProject(
            resolve(
              context.cwd,
              process.env.VERULE_COMPARISON_TSCONFIG ?? "tsconfig.json",
            ),
          );
          const project = shared;
          for (const node of project.calls(
            resolve(context.cwd, context.filename),
          )) {
            const target = project.target(node);
            const result =
              name === "contract-instance" && target === project.execute
                ? compareInstance(project, node)
                : name === "validated-input" && target === project.dispatch
                  ? compareInput(project, node)
                  : undefined;
            if (result) {
              // Oxlint's report location is local to the visitor file. The JSON
              // payload preserves the true source and cross-file evidence for gaps.
              const point =
                result.location.file === project.point(node).file
                  ? result.location
                  : project.point(node);
              context.report({
                loc: {
                  start: { line: point.line, column: point.column - 1 },
                  end: { line: point.endLine, column: point.endColumn - 1 },
                },
                message: JSON.stringify(result),
              });
            }
          }
        },
      };
    },
  };
}

export default {
  meta: { name: "contract-comparison" },
  rules: {
    "contract-instance": rule("contract-instance"),
    "validated-input": rule("validated-input"),
  },
};
