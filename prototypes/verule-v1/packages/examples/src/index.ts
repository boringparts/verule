import type {
  CallExpression,
  FlowOrigin,
  Model,
  Node,
  Rule,
  RuleContext,
  SymbolRef,
} from "@verule/sdk";

function calls(
  query: RuleContext,
  target: SymbolRef,
): readonly CallExpression[] {
  const { value } = query.symbol(target);
  return value ? query.calls(value) : [];
}

function* registrations(query: RuleContext) {
  for (const site of calls(query, { file: "api.ts", name: "register" })) {
    const arg = site.arguments[0];
    if (arg) yield { site: arg, names: query.strings(arg).values };
  }
}

export const duplicateCommand: Rule = {
  id: "commands/duplicate",
  run(query) {
    const first = new Map<string, Node>();
    for (const { site, names } of registrations(query)) {
      // A union describes alternatives. Counting every alternative would
      // turn a possible duplicate into a definite duplicate.
      if (names.length !== 1) continue;
      const name = names[0]!;
      const previous = first.get(name);
      if (previous)
        query.report({
          at: site,
          message: `Command '${name}' was registered twice.`,
          key: name,
          evidence: [
            query.evidence(previous, "First registration."),
            query.evidence(site, "Repeated registration."),
          ],
        });
      else first.set(name, site);
    }
  },
};

export const declaredCommand: Rule = {
  id: "commands/declared",
  run(query) {
    const { value: declaration } = query.symbol({
      file: "api.ts",
      name: "CommandName",
    });
    if (!declaration) return;
    const allowed = query.strings(declaration);
    if (allowed.gaps.length) return;
    for (const { site, names } of registrations(query))
      for (const name of names)
        if (!allowed.values.includes(name))
          query.report({
            at: site,
            key: name,
            message: `Command '${name}' is outside CommandName.`,
            evidence: [
              query.evidence(site, "Registered name."),
              query.evidence(declaration, "Declared set of command names."),
            ],
          });
  },
};

export const previewId: Rule = {
  id: "orders/preview-id",
  run(query) {
    const sources = calls(query, { file: "api.ts", name: "preview" });
    for (const call of calls(query, { file: "api.ts", name: "submit" })) {
      const arg = call.arguments[0];
      if (!arg) continue;
      const result = query.trace(arg, { stopAt: sources, followCallers: true });
      const path = result.origins.find(
        (origin) =>
          !origin.path.length &&
          sources.some((source) => source === origin.node),
      );
      if (path)
        query.report({
          at: arg,
          message: "A preview ID may reach order submission.",
          evidence: path.evidence,
        });
    }
  },
};

export const exampleRules = [duplicateCommand, declaredCommand, previewId];
export const exampleModels: Model[] = [
  {
    target: { file: "external.d.ts", name: "pass" },
    behavior: "returns-argument",
    argument: 0,
  },
];

const library = "src/index.ts";

/** A comparison is definite only if every alternative denotes the same known allocation. */
function allocation(origins: readonly FlowOrigin[], gaps: readonly unknown[]) {
  const one = origins[0];
  if (
    gaps.length ||
    !one?.identity ||
    !origins.every((origin) => origin.identity === one.identity)
  )
    return undefined;
  return one;
}

export const contractIdentity: Rule = {
  id: "cli/contract-instance",
  run(query) {
    const parse = calls(query, { file: library, name: "parseCliInvocation" });
    const bySite = new Map<Node, CallExpression>(
      parse.map((site) => [site, site]),
    );
    for (const execute of calls(query, { file: library, name: "executeCli" })) {
      const [contract, options] = execute.arguments;
      if (!contract || !options) continue;
      const invocation = query.trace(options, {
        path: ["invocation"],
        stopAt: parse,
      });
      if (invocation.gaps.length || !invocation.origins.length) continue;
      const actual = query.trace(contract);
      const receiving = allocation(actual.origins, actual.gaps);
      const proofs = [];
      let uncertain = false;
      let canMatch = false;
      for (const origin of invocation.origins) {
        const issuingArg =
          !origin.path.length && bySite.get(origin.node)?.arguments[0];
        if (!issuingArg) {
          uncertain = true;
          continue;
        }
        const issued = query.trace(issuingArg, { from: origin });
        const issuing = allocation(issued.origins, issued.gaps);
        if (
          issued.origins.length === 1 &&
          actual.origins.length === 1 &&
          !issued.gaps.length &&
          !actual.gaps.length &&
          issued.origins[0]?.key === actual.origins[0]?.key
        ) {
          canMatch = true;
        } else if (
          receiving &&
          issuing &&
          receiving.identity !== issuing.identity
        ) {
          proofs.push(...issuing.evidence, ...origin.evidence);
        } else uncertain = true;
      }
      // A mismatch requires different allocations for every feasible origin.
      if (!uncertain && !canMatch && receiving)
        query.report({
          at: contract,
          message:
            "The invocation was issued by a different contract instance.",
          evidence: [...proofs, ...receiving.evidence],
        });
      else if (uncertain && !actual.gaps.length)
        query.unknown(
          contract,
          "Cannot establish the identity of the issuing and executing contract instances.",
        );
    }
  },
};

export const validatedInput: Rule = {
  id: "cli/validated-input",
  run(query) {
    const validations = calls(query, {
      file: "src/cli-input-validation.ts",
      name: "validateCliInput",
    });
    for (const dispatch of calls(query, {
      file: "src/cli-execution.ts",
      name: "executeApplicationResult",
    })) {
      const input = dispatch.arguments[2];
      const options = dispatch.arguments[3];
      if (!input || !options) continue;
      const raw = query.trace(options, { path: ["invocation", "input"] });
      const actual = query.trace(input, { stopAt: validations });
      const bypass = actual.origins.find((origin) =>
        raw.origins.some((candidate) => candidate.key === origin.key),
      );
      if (bypass)
        query.report({
          at: input,
          message: "Raw invocation input bypasses the validated output.",
          evidence: bypass.evidence,
        });
      else if (
        actual.origins.some(
          (origin) =>
            !validations.some((site) => site === origin.node) ||
            origin.path.join(".") !== "value",
        )
      )
        query.unknown(
          input,
          "Cannot establish that this input came from the successful validation output.",
        );
    }
  },
};
export const contractRules = [contractIdentity, validatedInput];
export const contractModels: Model[] = [
  {
    target: { file: library, name: "defineCli" },
    resultCall: true,
    behavior: "fresh",
  },
];
