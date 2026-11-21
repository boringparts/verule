import { createHash, randomUUID } from "node:crypto";
import { dirname, relative, resolve } from "node:path";

import { getLeadingCommentRanges, type Node } from "tsrs/ast";

import { Flow, type FlowEvidence, type Model } from "./flow.ts";
import { Project, type SymbolRef } from "./project.ts";

export { Project, type SymbolRef } from "./project.ts";
export type { Node, CallExpression } from "tsrs/ast";
export type { FlowOrigin, Model } from "./flow.ts";

export interface Location {
  file: string;
  line: number;
  column: number;
  endLine: number;
  endColumn: number;
}
export interface Evidence {
  at: Location;
  reason: string;
  kind: "source" | "model" | "approximation";
}
export interface Gap {
  at: Location;
  rule: string;
  reason: string;
}
export interface Diagnostic {
  id: string;
  rule: string;
  message: string;
  at: Location;
  evidence: Evidence[];
}
export interface Report {
  version: string;
  diagnostics: Diagnostic[];
  gaps: Gap[];
}
export interface Rule {
  id: string;
  /** Runs synchronously. Nodes and evidence belong to this check’s snapshot. */
  run(query: RuleContext): void;
}
export interface Config {
  tsconfig: string;
  rules: readonly Rule[];
  models?: readonly Model[];
}
export function defineConfig(config: Config): Config {
  return config;
}

function publicLocation({
  file,
  line,
  column,
  endLine,
  endColumn,
}: Location): Location {
  return { file, line, column, endLine, endColumn };
}

function isIgnored(node: Node, location: Location, rule: string): boolean {
  if (location.line < 2) return false;
  const source = node.getSourceFile();
  // Only inspect trivia attached to the source line. Text in strings and block
  // comments cannot turn off a finding.
  for (
    let current: Node | undefined = node;
    current;
    current = current.parent
  ) {
    if (current.getStart(source) > node.getStart(source)) continue;
    for (const range of getLeadingCommentRanges(source.text, current.pos) ??
      []) {
      const directive =
        /^\/\/\s*verule-ignore-next-line\s+(\S+?)(?:\s+--(?:\s+.*)?)?\s*$/u.exec(
          source.text.slice(range.pos, range.end),
        );
      if (
        directive?.[1] === rule &&
        source.getLineAndCharacterOfPosition(range.pos).line + 2 ===
          location.line
      )
        return true;
    }
  }
  return false;
}

interface Finding {
  at: Node;
  message: string;
  /** An optional domain key distinguishes multiple findings at one expression. */
  key?: string;
  /** Source or model evidence produced by this rule’s current queries. */
  evidence?: readonly (Evidence | FlowEvidence)[];
}

const finishRule = Symbol("finishRule");

export class RuleContext {
  #active = true;
  readonly #evidence = new WeakSet<Evidence | FlowEvidence>();

  [finishRule]() {
    this.#active = false;
  }

  #assertActive() {
    if (!this.#active) throw new Error("This rule execution has finished.");
  }
  readonly #project: Project;
  readonly #flow: Flow;
  readonly #dir: string;
  readonly #rule: string;
  readonly #report: Report;
  readonly #occurrences = new Map<string, number>();

  /** @internal Created for a single rule and revision. */
  constructor(
    project: Project,
    flow: Flow,
    dir: string,
    rule: string,
    report: Report,
  ) {
    this.#project = project;
    this.#flow = flow;
    this.#dir = dir;
    this.#rule = rule;
    this.#report = report;
  }

  #gap(reason: string, location: Location): Gap {
    const gap = { rule: this.#rule, reason, at: publicLocation(location) };
    this.#report.gaps.push(gap);
    return gap;
  }

  /** Resolve one exported or top-level local declaration, following re-exports. */
  symbol(ref: SymbolRef) {
    this.#assertActive();
    const value = this.#project.resolveSymbol(ref);
    const gaps = value
      ? []
      : [
          this.#gap(`Cannot resolve declaration '${ref.name}'.`, {
            file: relative(this.#dir, resolve(this.#dir, ref.file)),
            line: 1,
            column: 1,
            endLine: 1,
            endColumn: 1,
          }),
        ];
    return { value, gaps };
  }

  /** All direct calls whose callee resolves to this declaration. */
  calls(declaration: Node) {
    this.#assertActive();
    return this.#project.callsTo(declaration);
  }

  /** Enumerate a finite string literal type at this program point. */
  strings(node: Node) {
    this.#assertActive();
    const values = this.#project.literalStrings(node);
    const gaps =
      values === undefined
        ? [
            this.#gap(
              "Cannot enumerate this type as string literals.",
              this.#project.location(node),
            ),
          ]
        : [];
    return { values: values ?? [], gaps };
  }

  /** Trace an original value. Unknown paths are retained even if the caller
   * only consumes the known origins. */
  trace(node: Node, options?: Parameters<Flow["trace"]>[1]) {
    this.#assertActive();
    this.#project.assertCurrent(node);
    for (const stop of options?.stopAt ?? []) this.#project.assertCurrent(stop);
    const result = this.#flow.trace(node, options);
    for (const path of [...result.origins, ...result.gaps])
      for (const step of path.evidence) this.#evidence.add(step);
    for (const gap of result.gaps) this.#gap(gap.message, gap.location);
    return result;
  }

  /** Record a domain-specific gap when known query results cannot establish the relation. */
  unknown(node: Node, reason: string): Gap {
    this.#assertActive();
    return this.#gap(reason, this.#project.location(node));
  }

  evidence(node: Node, reason: string): Evidence {
    this.#assertActive();
    const item: Evidence = {
      kind: "source",
      at: publicLocation(this.#project.location(node)),
      reason,
    };
    this.#evidence.add(item);
    return item;
  }

  report(finding: Finding) {
    this.#assertActive();
    const at = publicLocation(this.#project.location(finding.at));
    if (isIgnored(finding.at, at, this.#rule)) return;
    const signature = JSON.stringify([
      this.#rule,
      at.file,
      finding.at.getText(),
      finding.key ?? finding.message,
    ]);
    const occurrence = this.#occurrences.get(signature) ?? 0;
    this.#occurrences.set(signature, occurrence + 1);
    const id = createHash("sha256")
      .update(signature)
      .update(String(occurrence))
      .digest("hex")
      .slice(0, 20);
    const evidence = (
      finding.evidence ?? [this.evidence(finding.at, finding.message)]
    ).map((item) => {
      if (!this.#evidence.has(item))
        throw new Error(
          "Evidence must come from a query in the current rule execution.",
        );
      return "location" in item
        ? {
            kind: item.kind,
            at: publicLocation(item.location),
            reason: item.message,
          }
        : { ...item, at: publicLocation(item.at) };
    });
    this.#report.diagnostics.push({
      id,
      rule: this.#rule,
      message: finding.message,
      at,
      evidence,
    });
  }
}

export class AnalysisSession {
  /** The underlying tsrs project is exposed for compiler-fact measurements. */
  readonly project: Project;
  readonly #dir: string;
  readonly #session = randomUUID();
  #revision = 0;
  constructor(tsconfig: string) {
    this.#dir = dirname(resolve(tsconfig));
    this.project = new Project(resolve(tsconfig));
  }

  get filePaths(): readonly string[] {
    return this.project.filePaths;
  }

  /** Supply all changed source paths since the previous check. A full check
   * discards Verule indexes but keeps the language service. */
  check(
    config: Pick<Config, "rules" | "models">,
    options: {
      changedFiles?: readonly string[];
      full?: boolean;
      version?: string;
    } = {},
  ): Report {
    if (options.changedFiles?.length) this.project.update(options.changedFiles);
    if (options.full) this.project.clearAnalysisCache();
    const report: Report = {
      version: options.version ?? `${this.#session}/${++this.#revision}`,
      diagnostics: [],
      gaps: [],
    };
    const flow = new Flow(this.project, config.models ?? []);
    const ids = new Set<string>();
    for (const rule of config.rules) {
      if (!rule.id || ids.has(rule.id))
        throw new Error(`Invalid or duplicate rule ID: '${rule.id}'.`);
      ids.add(rule.id);
      const context = new RuleContext(
        this.project,
        flow,
        this.#dir,
        rule.id,
        report,
      );
      try {
        const result: unknown = rule.run(context);
        if (
          result &&
          typeof result === "object" &&
          "then" in result &&
          typeof result.then === "function"
        ) {
          // Consume a rejected continuation after reporting the configuration error.
          void Promise.resolve(result).catch(() => {});
          throw new Error(
            `Rule '${rule.id}' returned a promise. Rules must run synchronously.`,
          );
        }
      } finally {
        context[finishRule]();
      }
    }
    const order = (
      a: { at: Location; rule: string },
      b: { at: Location; rule: string },
    ) =>
      a.at.file.localeCompare(b.at.file) ||
      a.at.line - b.at.line ||
      a.at.column - b.at.column ||
      a.rule.localeCompare(b.rule);
    report.diagnostics.sort((a, b) => order(a, b) || a.id.localeCompare(b.id));
    report.gaps = [
      ...new Map(report.gaps.map((gap) => [JSON.stringify(gap), gap])).values(),
    ].sort((a, b) => order(a, b) || a.reason.localeCompare(b.reason));
    return report;
  }
  close() {
    this.project.close();
  }
}
export function openProject(tsconfig: string): AnalysisSession {
  return new AnalysisSession(tsconfig);
}
