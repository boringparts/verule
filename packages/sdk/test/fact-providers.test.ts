import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  VeruleExecutionError,
  defineAdapter,
  defineConfig,
  defineFactProvider,
  defineFactType,
  defineRule,
  runCheck,
  type FactResult,
} from "@verule/sdk";

function createTempProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "verule-fact-providers-"));
  writeFileSync(
    join(root, "tsconfig.json"),
    JSON.stringify(
      {
        compilerOptions: {
          strict: true,
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
        },
        include: ["src/**/*.ts"],
      },
      null,
      2,
    ),
    "utf8",
  );
  for (const [relPath, content] of Object.entries(files)) {
    const absPath = join(root, relPath);
    mkdirSync(join(absPath, ".."), { recursive: true });
    writeFileSync(absPath, content, "utf8");
  }
  return root;
}

type EndpointAuthCondition = {
  readonly scope?: "all" | "exported";
};

type EndpointAuthFactValue = {
  readonly roles: readonly string[];
  readonly deniedRoles?: readonly string[];
  readonly allowAnonymous?: boolean;
  readonly hasDynamicRoles: boolean;
};

/**
 * Third-party FactType contract with explicit subjectKind, condition, field meanings,
 * and symmetric partial-merge / mutual-exclusion semantics.
 */
const ThirdPartyEndpointAuthFact = defineFactType<
  "call" | "syntax",
  EndpointAuthCondition | undefined,
  EndpointAuthFactValue
>({
  id: "thirdparty.endpoint.auth",
  description:
    "Authorization roles and anonymous-access guarantees extracted by third-party route adapters.",
  subjectKind: ["call", "syntax"],
  merge: (existing, incoming) => {
    if (
      existing.value.allowAnonymous !== undefined &&
      incoming.value.allowAnonymous !== undefined &&
      existing.value.allowAnonymous !== incoming.value.allowAnonymous
    ) {
      return {
        ok: false,
        conflict: {
          message: `Conflicting allowAnonymous conclusion (${String(existing.value.allowAnonymous)} vs ${String(incoming.value.allowAnonymous)})`,
          existingConclusion: `allowAnonymous=${String(existing.value.allowAnonymous)}`,
          incomingConclusion: `allowAnonymous=${String(incoming.value.allowAnonymous)}`,
          existingEvidence: existing.evidence,
          incomingEvidence: incoming.evidence,
        },
      };
    }

    const existingDenied = new Set(existing.value.deniedRoles ?? []);
    const incomingDenied = new Set(incoming.value.deniedRoles ?? []);
    const roleConflict =
      existing.value.roles.find((role) => incomingDenied.has(role)) ??
      incoming.value.roles.find((role) => existingDenied.has(role));
    if (roleConflict !== undefined) {
      return {
        ok: false,
        conflict: {
          message: `Conflicting requirement for role "${roleConflict}"`,
          existingConclusion: `roles=[${existing.value.roles.join(",")}], deniedRoles=[${(existing.value.deniedRoles ?? []).join(",")}]`,
          incomingConclusion: `roles=[${incoming.value.roles.join(",")}], deniedRoles=[${(incoming.value.deniedRoles ?? []).join(",")}]`,
          existingEvidence: existing.evidence,
          incomingEvidence: incoming.evidence,
        },
      };
    }

    const roles = [
      ...new Set([...existing.value.roles, ...incoming.value.roles]),
    ].toSorted();
    const deniedRoles = [
      ...new Set([
        ...(existing.value.deniedRoles ?? []),
        ...(incoming.value.deniedRoles ?? []),
      ]),
    ].toSorted();
    const allowAnonymous =
      existing.value.allowAnonymous ?? incoming.value.allowAnonymous;
    return {
      ok: true,
      value: {
        roles,
        ...(deniedRoles.length > 0 ? { deniedRoles } : {}),
        ...(allowAnonymous !== undefined ? { allowAnonymous } : {}),
        hasDynamicRoles:
          existing.value.hasDynamicRoles || incoming.value.hasDynamicRoles,
      },
    };
  },
});

const ThirdPartyRouteMethodFact = defineFactType<
  "syntax",
  undefined,
  { readonly method: "GET" | "POST" }
>({
  id: "thirdparty.route.method",
  subjectKind: "syntax",
});

void describe("@verule/sdk fact providers, replacement, and conflict semantics", () => {
  void it("complements partial facts and reports structured order-independent FACT_CONFLICT with both providers, conclusions, and evidence", async () => {
    const root = createTempProject({
      "src/routes.ts": [
        "export function registerRoute(path: string, handler: () => void) {",
        "  return { path, handler };",
        "}",
        'export const usersRoute = registerRoute("/users", () => {});',
        "",
      ].join("\n"),
    });

    const partialProviderA = defineAdapter({
      id: "auth-decorator-provider",
      provides: [
        defineFactProvider(ThirdPartyEndpointAuthFact, async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const target = calls.find((c) => c.text.startsWith("registerRoute("));
          if (!target) return [];
          return [
            {
              subject: target.ref,
              value: {
                roles: ["reader"],
                hasDynamicRoles: true,
              },
              evidence: [
                {
                  kind: "source",
                  message: "Decorator grants reader role",
                  at: target.location,
                },
              ],
              gaps: [
                {
                  kind: "dynamic-role-expression",
                  message:
                    "Additional role expression could not be resolved statically",
                  at: target.location,
                },
              ],
            },
          ];
        }),
      ],
    });

    const partialProviderB = defineAdapter({
      id: "auth-policy-provider",
      provides: [
        defineFactProvider(ThirdPartyEndpointAuthFact, async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const target = calls.find((c) => c.text.startsWith("registerRoute("));
          if (!target) return [];
          return [
            {
              subject: target.ref,
              value: {
                roles: ["editor"],
                allowAnonymous: false,
                hasDynamicRoles: false,
              },
              evidence: [
                {
                  kind: "note",
                  message:
                    "Policy requires editor role and disables anonymous access",
                  at: target.location,
                },
              ],
            },
          ];
        }),
      ],
    });

    const conflictingProviderC = defineAdapter({
      id: "auth-override-provider",
      provides: [
        defineFactProvider(ThirdPartyEndpointAuthFact, async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const target = calls.find((c) => c.text.startsWith("registerRoute("));
          if (!target) return [];
          return [
            {
              subject: target.ref,
              value: {
                roles: [],
                deniedRoles: ["reader"],
                allowAnonymous: true,
                hasDynamicRoles: false,
              },
              evidence: [
                {
                  kind: "source",
                  message:
                    "Override sets allowAnonymous=true and denies reader",
                  at: target.location,
                },
              ],
            },
          ];
        }),
      ],
    });

    const methodGetProvider = defineAdapter({
      id: "route-get-provider",
      provides: [
        defineFactProvider(ThirdPartyRouteMethodFact, async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const target = calls.find((c) => c.text.startsWith("registerRoute("));
          if (!target) return [];
          return [
            {
              subject: target.ref,
              value: { method: "GET" as const },
              evidence: [
                {
                  kind: "source",
                  message: "Inferred GET from handler name",
                  at: target.location,
                },
              ],
            },
          ];
        }),
      ],
    });

    const methodPostProvider = defineAdapter({
      id: "route-post-provider",
      provides: [
        defineFactProvider(ThirdPartyRouteMethodFact, async (ctx) => {
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const target = calls.find((c) => c.text.startsWith("registerRoute("));
          if (!target) return [];
          return [
            {
              subject: target.ref,
              value: { method: "POST" as const },
              evidence: [
                {
                  kind: "source",
                  message: "Inferred POST from payload signature",
                  at: target.location,
                },
              ],
            },
          ];
        }),
      ],
    });

    try {
      // 1. Complementary partial facts in [A, B] and [B, A] order
      let capturedForward: readonly FactResult<
        "call" | "syntax",
        EndpointAuthFactValue
      >[] = [];
      let capturedReverse: readonly FactResult<
        "call" | "syntax",
        EndpointAuthFactValue
      >[] = [];

      const makeRule = (
        onResult: (
          items: readonly FactResult<
            "call" | "syntax",
            EndpointAuthFactValue
          >[],
        ) => void,
      ) =>
        defineRule({
          id: "require-auth-roles",
          run: async (ctx) => {
            const items = await ctx.facts(ThirdPartyEndpointAuthFact, {
              condition: { scope: "exported" },
            });
            onResult(items);
            for (const item of items) {
              if (
                item.value.roles.includes("reader") &&
                item.value.roles.includes("editor")
              ) {
                const firstEv = item.evidence[0];
                if (firstEv?.at) {
                  ctx.report({
                    at: firstEv.at,
                    message: `Route requires roles [${item.value.roles.join(", ")}]`,
                    findingKey: "merged-auth-roles",
                    evidence: item.evidence,
                  });
                }
              }
            }
          },
        });

      const reportForward = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [partialProviderA, partialProviderB],
          rules: [
            makeRule((items) => {
              capturedForward = items;
            }),
          ],
        }),
      });
      const reportReverse = await runCheck({
        cwd: root,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [partialProviderB, partialProviderA],
          rules: [
            makeRule((items) => {
              capturedReverse = items;
            }),
          ],
        }),
      });

      assert.equal(capturedForward.length, 1);
      assert.deepEqual(capturedForward[0]!.providers, [
        "auth-decorator-provider",
        "auth-policy-provider",
      ]);
      assert.deepEqual(capturedForward[0]!.value, {
        roles: ["editor", "reader"],
        allowAnonymous: false,
        hasDynamicRoles: true,
      });
      assert.equal(capturedForward[0]!.gaps.length, 1);
      assert.equal(capturedForward[0]!.evidence.length, 2);

      // Strict order independence for FactResult & CheckReport (including diagnostic IDs and identity)
      assert.deepEqual(
        {
          providers: capturedForward[0]!.providers,
          value: capturedForward[0]!.value,
          evidence: capturedForward[0]!.evidence,
          gaps: capturedForward[0]!.gaps,
        },
        {
          providers: capturedReverse[0]!.providers,
          value: capturedReverse[0]!.value,
          evidence: capturedReverse[0]!.evidence,
          gaps: capturedReverse[0]!.gaps,
        },
      );
      assert.deepEqual(reportForward, reportReverse);

      // 2. Mutual exclusion conflict via FactType.merge -> structured FACT_CONFLICT, load-order independent
      const authRule = defineRule({
        id: "query-auth",
        run: async (ctx) => {
          await ctx.facts(ThirdPartyEndpointAuthFact);
        },
      });

      let authErrForward: unknown;
      try {
        await runCheck({
          cwd: root,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            adapters: [partialProviderB, conflictingProviderC],
            rules: [authRule],
          }),
        });
      } catch (err) {
        authErrForward = err;
      }

      let authErrReverse: unknown;
      try {
        await runCheck({
          cwd: root,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            adapters: [conflictingProviderC, partialProviderB],
            rules: [authRule],
          }),
        });
      } catch (err) {
        authErrReverse = err;
      }

      assert.ok(authErrForward instanceof VeruleExecutionError);
      assert.ok(authErrReverse instanceof VeruleExecutionError);
      assert.equal(authErrForward.code, "FACT_CONFLICT");
      assert.equal(authErrReverse.code, "FACT_CONFLICT");
      assert.equal(authErrForward.message, authErrReverse.message);
      assert.ok(authErrForward.conflict);
      assert.deepEqual(authErrForward.conflict, authErrReverse.conflict);
      assert.equal(
        authErrForward.conflict.factTypeId,
        "thirdparty.endpoint.auth",
      );
      assert.deepEqual(
        authErrForward.conflict.parties.map((p) => p.providerId),
        ["auth-override-provider", "auth-policy-provider"],
      );
      assert.match(authErrForward.message, /allowAnonymous=true/u);
      assert.match(authErrForward.message, /allowAnonymous=false/u);
      assert.match(
        authErrForward.message,
        /Override sets allowAnonymous=true/u,
      );
      assert.match(authErrForward.message, /Policy requires editor role/u);

      // 3. Default conflict (FactType without custom merge) includes both conclusions & evidence
      const methodRule = defineRule({
        id: "query-method",
        run: async (ctx) => {
          await ctx.facts(ThirdPartyRouteMethodFact);
        },
      });
      let methodErrA: unknown;
      try {
        await runCheck({
          cwd: root,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            adapters: [methodGetProvider, methodPostProvider],
            rules: [methodRule],
          }),
        });
      } catch (err) {
        methodErrA = err;
      }
      let methodErrB: unknown;
      try {
        await runCheck({
          cwd: root,
          config: defineConfig({
            tsconfig: "tsconfig.json",
            adapters: [methodPostProvider, methodGetProvider],
            rules: [methodRule],
          }),
        });
      } catch (err) {
        methodErrB = err;
      }

      assert.ok(methodErrA instanceof VeruleExecutionError);
      assert.ok(methodErrB instanceof VeruleExecutionError);
      assert.equal(methodErrA.code, "FACT_CONFLICT");
      assert.equal(methodErrA.message, methodErrB.message);
      assert.ok(methodErrA.conflict);
      assert.deepEqual(methodErrA.conflict, methodErrB.conflict);
      assert.deepEqual(
        methodErrA.conflict.parties.map((p) => p.conclusion),
        [{ method: "GET" }, { method: "POST" }],
      );
      assert.match(methodErrA.message, /"GET"/u);
      assert.match(methodErrA.message, /"POST"/u);
      assert.match(methodErrA.message, /Inferred GET/u);
      assert.match(methodErrA.message, /Inferred POST/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  void it("replaces third-party FactType providers without modifying rule code and enforces explicit providerId filtering & observability", async () => {
    // Independent third-party validator FactType defined via @verule/sdk
    type ValidationSpecCondition = { readonly scope?: "all" | "calls" };
    type ValidationSpecValue = {
      readonly requiredFields: readonly string[];
      readonly optionalFields: readonly string[];
      readonly schemaName?: string;
    };

    const ThirdPartyValidatorSpecFact = defineFactType<
      "call",
      ValidationSpecCondition | undefined,
      ValidationSpecValue
    >({
      id: "thirdparty.validator.spec",
      description:
        "Required and optional input fields declared by any validator library.",
      subjectKind: "call",
      merge: (existing, incoming) => {
        const conflictField =
          existing.value.requiredFields.find((f) =>
            incoming.value.optionalFields.includes(f),
          ) ??
          incoming.value.requiredFields.find((f) =>
            existing.value.optionalFields.includes(f),
          );
        if (conflictField !== undefined) {
          return {
            ok: false,
            conflict: {
              message: `Conflicting requirement for field "${conflictField}"`,
              existingConclusion: `${conflictField}: ${existing.value.requiredFields.includes(conflictField) ? "required" : "optional"}`,
              incomingConclusion: `${conflictField}: ${incoming.value.requiredFields.includes(conflictField) ? "required" : "optional"}`,
            },
          };
        }
        return {
          ok: true,
          value: {
            requiredFields: [
              ...new Set([
                ...existing.value.requiredFields,
                ...incoming.value.requiredFields,
              ]),
            ].toSorted(),
            optionalFields: [
              ...new Set([
                ...existing.value.optionalFields,
                ...incoming.value.optionalFields,
              ]),
            ].toSorted(),
            ...((existing.value.schemaName ?? incoming.value.schemaName) !==
            undefined
              ? {
                  schemaName:
                    existing.value.schemaName ?? incoming.value.schemaName,
                }
              : {}),
          },
        };
      },
    });

    const UnrelatedFact = defineFactType<
      "syntax",
      undefined,
      { readonly ok: true }
    >({
      id: "thirdparty.unrelated",
      subjectKind: "syntax",
    });

    // Unchanged business rule that only depends on ThirdPartyValidatorSpecFact
    const requireEmailRule = defineRule({
      id: "require-email-field",
      run: async (ctx) => {
        const specs = await ctx.facts(ThirdPartyValidatorSpecFact, {
          condition: { scope: "calls" },
        });
        for (const spec of specs) {
          if (!spec.value.requiredFields.includes("email")) {
            const rows = await ctx.syntaxOf([spec.subject], {
              select: { location: true },
            });
            const at = rows[0]?.location ?? spec.evidence[0]?.at;
            if (!at) continue;
            ctx.report({
              at,
              message: `Validator "${spec.value.schemaName ?? "unknown"}" must require "email" (via ${spec.providers.join(", ")})`,
              findingKey: "missing-email-requirement",
              evidence: spec.evidence,
            });
          }
        }
      },
    });

    const zodStyleRoot = createTempProject({
      "src/app.ts": [
        "const userSchema = { fields: { name: 'required' } };",
        "declare function zParse(schema: unknown, data: unknown): unknown;",
        "export function submit(data: unknown) {",
        "  return zParse(userSchema, data);",
        "}",
        "",
      ].join("\n"),
    });

    const valibotStyleRoot = createTempProject({
      "src/app.ts": [
        "const userValibot = { fields: { name: 'required' } };",
        "declare function vParse(schema: unknown, data: unknown): unknown;",
        "export function submit(data: unknown) {",
        "  return vParse(userValibot, data);",
        "}",
        "",
      ].join("\n"),
    });

    let zodExtracts = 0;
    let valibotExtracts = 0;

    const zodLikeProvider = defineAdapter({
      id: "zod-like-provider",
      provides: [
        defineFactProvider(ThirdPartyValidatorSpecFact, async (ctx) => {
          zodExtracts += 1;
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
          return resolved.flatMap((row, idx) => {
            const callSyntax = calls[idx];
            if (
              !callSyntax ||
              !callSyntax.text.startsWith("zParse(") ||
              row.call === null
            ) {
              return [];
            }
            return [
              {
                subject: row.call,
                value: {
                  requiredFields: ["name"],
                  optionalFields: [],
                  schemaName: "userSchema",
                },
                evidence: [
                  {
                    kind: "source" as const,
                    message: "Extracted from zParse(userSchema, ...)",
                    at: callSyntax.location,
                  },
                ],
              },
            ];
          });
        }),
      ],
    });

    const valibotLikeProvider = defineAdapter({
      id: "valibot-like-provider",
      provides: [
        defineFactProvider(ThirdPartyValidatorSpecFact, async (ctx) => {
          valibotExtracts += 1;
          const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
          const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
          return resolved.flatMap((row, idx) => {
            const callSyntax = calls[idx];
            if (
              !callSyntax ||
              !callSyntax.text.startsWith("vParse(") ||
              row.call === null
            ) {
              return [];
            }
            return [
              {
                subject: row.call,
                value: {
                  requiredFields: ["name"],
                  optionalFields: [],
                  schemaName: "userValibot",
                },
                evidence: [
                  {
                    kind: "source" as const,
                    message: "Extracted from vParse(userValibot, ...)",
                    at: callSyntax.location,
                  },
                ],
              },
            ];
          });
        }),
      ],
    });

    const unrelatedAdapter = defineAdapter({
      id: "unrelated-provider",
      provides: [defineFactProvider(UnrelatedFact, () => [])],
    });

    try {
      // 1. Run rule with zodLikeProvider -> findings with zod evidence
      const repZod = await runCheck({
        cwd: zodStyleRoot,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [zodLikeProvider],
          rules: [requireEmailRule],
        }),
      });
      assert.equal(repZod.status, "findings");
      assert.equal(repZod.diagnostics.length, 1);
      assert.match(
        repZod.diagnostics[0]!.message,
        /userSchema.*zod-like-provider/u,
      );

      // 2. Replace provider with valibotLikeProvider; zero rule changes!
      const repValibot = await runCheck({
        cwd: valibotStyleRoot,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [valibotLikeProvider],
          rules: [requireEmailRule],
        }),
      });
      assert.equal(repValibot.status, "findings");
      assert.equal(repValibot.diagnostics.length, 1);
      assert.match(
        repValibot.diagnostics[0]!.message,
        /userValibot.*valibot-like-provider/u,
      );
      assert.ok(
        repValibot.diagnostics[0]!.evidence.some((ev) =>
          ev.message.includes("vParse(userValibot"),
        ),
      );

      // 3. Explicit providerId filtering: only invokes requested provider & reflects in observation/explain
      zodExtracts = 0;
      valibotExtracts = 0;
      const scopedRule = defineRule({
        id: "scoped-valibot-only",
        run: async (ctx) => {
          const items = await ctx.facts(ThirdPartyValidatorSpecFact, {
            providerId: "valibot-like-provider",
          });
          assert.equal(items.length, 1);
          assert.deepEqual(items[0]!.providers, ["valibot-like-provider"]);
        },
      });
      const scopedReport = await runCheck({
        cwd: valibotStyleRoot,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [zodLikeProvider, valibotLikeProvider],
          rules: [scopedRule],
        }),
        observe: "detail",
        at: "src/app.ts:4:10",
      });
      assert.equal(zodExtracts, 0);
      assert.equal(valibotExtracts, 1);
      assert.deepEqual(scopedReport.observation?.providers, [
        "engine",
        "valibot-like-provider",
      ]);
      assert.equal(
        scopedReport.observation?.providers.includes("zod-like-provider"),
        false,
      );
      assert.deepEqual(scopedReport.explanation?.providers, [
        "valibot-like-provider",
      ]);
      const valibotQuery = scopedReport.explanation?.queries.find(
        (q) => q.op === "facts:thirdparty.validator.spec",
      );
      assert.equal(valibotQuery?.provider, "valibot-like-provider");
      assert.equal(valibotQuery?.candidateCount, 1);

      // 4. Explicit providerId that is not enabled or doesn't support the FactType -> invokes neither provider, observable
      zodExtracts = 0;
      valibotExtracts = 0;
      const missingAndUnsupportedRule = defineRule({
        id: "missing-or-unsupported-provider",
        run: async (ctx) => {
          const notEnabled = await ctx.facts(ThirdPartyValidatorSpecFact, {
            providerId: "not-enabled-provider",
          });
          const unsupported = await ctx.facts(ThirdPartyValidatorSpecFact, {
            providerId: "unrelated-provider",
          });
          assert.deepEqual(notEnabled, []);
          assert.deepEqual(unsupported, []);
        },
      });
      const missingReport = await runCheck({
        cwd: valibotStyleRoot,
        config: defineConfig({
          tsconfig: "tsconfig.json",
          adapters: [zodLikeProvider, valibotLikeProvider, unrelatedAdapter],
          rules: [missingAndUnsupportedRule],
        }),
        observe: "detail",
        at: "src/app.ts:4:10",
      });
      assert.equal(zodExtracts, 0);
      assert.equal(valibotExtracts, 0);
      assert.deepEqual(missingReport.observation?.providers, []);
      assert.deepEqual(missingReport.explanation?.providers, []);
      const detailQueries = (missingReport.observation?.details ?? []).filter(
        (d) => d.kind === "query",
      );
      assert.equal(detailQueries.length, 2);
      assert.deepEqual(detailQueries[0]?.detail, {
        factTypeId: "thirdparty.validator.spec",
        providers: [],
        providerFilter: "not-enabled-provider",
        providerFilterStatus: "not_enabled",
        candidateCount: 0,
      });
      assert.deepEqual(detailQueries[1]?.detail, {
        factTypeId: "thirdparty.validator.spec",
        providers: [],
        providerFilter: "unrelated-provider",
        providerFilterStatus: "unsupported",
        candidateCount: 0,
      });

      // 5. Empty/whitespace providerId throws INVALID_CONFIG
      await assert.rejects(
        () =>
          runCheck({
            cwd: valibotStyleRoot,
            config: defineConfig({
              tsconfig: "tsconfig.json",
              adapters: [valibotLikeProvider],
              rules: [
                defineRule({
                  id: "empty-provider-filter",
                  run: async (ctx) => {
                    await ctx.facts(ThirdPartyValidatorSpecFact, {
                      providerId: "   ",
                    });
                  },
                }),
              ],
            }),
          }),
        (err: unknown) =>
          err instanceof VeruleExecutionError && err.code === "INVALID_CONFIG",
      );
    } finally {
      rmSync(zodStyleRoot, { recursive: true, force: true });
      rmSync(valibotStyleRoot, { recursive: true, force: true });
    }
  });
});
