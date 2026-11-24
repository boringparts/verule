import { defineAdapter, defineFactProvider } from "@verule/sdk";

import { ValidatorContractFact } from "./validator-contract.ts";

export const partA = defineAdapter({
  id: "provider-a",
  provides: [
    defineFactProvider(ValidatorContractFact, async (ctx) => {
      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
      const firstCall = calls[0];
      const subject = resolved[0]?.call;
      if (!firstCall || !subject) return [];
      return [
        {
          subject,
          value: {
            schemaName: "UserSchema",
            fields: {
              id: {
                requirement: "required" as const,
                evidence: [
                  {
                    kind: "source" as const,
                    message: "provider-a id=required",
                    at: firstCall.location,
                  },
                ],
              },
            },
            requiredFields: ["id"],
            hasDynamicFields: true,
          },
          evidence: [
            {
              kind: "source",
              message: "provider-a partial schema",
              at: firstCall.location,
            },
          ],
          gaps: [
            {
              kind: "dynamic-spread",
              message: "provider-a dynamic spread",
              at: firstCall.location,
            },
          ],
        },
      ];
    }),
  ],
});

export const partB = defineAdapter({
  id: "provider-b",
  provides: [
    defineFactProvider(ValidatorContractFact, async (ctx) => {
      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
      const firstCall = calls[0];
      const subject = resolved[0]?.call;
      if (!firstCall || !subject) return [];
      return [
        {
          subject,
          value: {
            schemaName: "UserSchema",
            fields: {
              name: {
                requirement: "required" as const,
                evidence: [
                  {
                    kind: "source" as const,
                    message: "provider-b name=required",
                    at: firstCall.location,
                  },
                ],
              },
            },
            requiredFields: ["name"],
            hasDynamicFields: false,
          },
          evidence: [
            {
              kind: "source",
              message: "provider-b complemented name",
              at: firstCall.location,
            },
          ],
        },
      ];
    }),
  ],
});

export const conflictC = defineAdapter({
  id: "provider-c",
  provides: [
    defineFactProvider(ValidatorContractFact, async (ctx) => {
      const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
      const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
      const firstCall = calls[0];
      const subject = resolved[0]?.call;
      if (!firstCall || !subject) return [];
      return [
        {
          subject,
          value: {
            schemaName: "UserSchema",
            fields: {
              id: {
                requirement: "optional" as const,
                evidence: [
                  {
                    kind: "source" as const,
                    message: "provider-c id=optional",
                    at: firstCall.location,
                  },
                ],
              },
            },
            requiredFields: [],
            hasDynamicFields: false,
          },
          evidence: [
            {
              kind: "source",
              message: "provider-c contradicts id",
              at: firstCall.location,
            },
          ],
        },
      ];
    }),
  ],
});
