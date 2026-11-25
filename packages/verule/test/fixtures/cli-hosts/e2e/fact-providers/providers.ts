import {
  type AdapterContext,
  defineAdapter,
  defineFactProvider,
} from "@boringparts/verule";

import { InputSpecFact, type InputSpecValue } from "./fact-contract.ts";

async function firstCall(ctx: AdapterContext) {
  const calls = await ctx.findSyntax({ kinds: ["CallExpression"] });
  const resolved = await ctx.resolveCalls(calls.map((c) => c.ref));
  return { call: resolved[0]!.call!, at: calls[0]!.location };
}

export const providerA = defineAdapter({
  id: "provider-a",
  provides: [
    defineFactProvider(InputSpecFact, async (ctx) => {
      const { call, at } = await firstCall(ctx);
      return [
        {
          subject: call,
          value: {
            fields: {
              id: {
                requirement: "required",
                evidence: [
                  { kind: "source", message: "provider-a id=required", at },
                ],
              },
            },
            required: ["id"],
          } satisfies InputSpecValue,
          evidence: [
            { kind: "source", message: "provider-a extracted id", at },
          ],
          gaps: [
            {
              kind: "dynamic-spread",
              message: "provider-a saw dynamic spread",
              at,
            },
          ],
        },
      ];
    }),
  ],
});

export const providerB = defineAdapter({
  id: "provider-b",
  provides: [
    defineFactProvider(InputSpecFact, async (ctx) => {
      const { call, at } = await firstCall(ctx);
      return [
        {
          subject: call,
          value: {
            fields: {
              name: {
                requirement: "required",
                evidence: [
                  { kind: "source", message: "provider-b name=required", at },
                ],
              },
            },
            required: ["name"],
          } satisfies InputSpecValue,
          evidence: [
            { kind: "source", message: "provider-b extracted name", at },
          ],
        },
      ];
    }),
  ],
});

export const providerConflict = defineAdapter({
  id: "provider-conflict",
  provides: [
    defineFactProvider(InputSpecFact, async (ctx) => {
      const { call, at } = await firstCall(ctx);
      return [
        {
          subject: call,
          value: {
            fields: {
              id: {
                requirement: "optional",
                evidence: [
                  {
                    kind: "source",
                    message: "provider-conflict id=optional",
                    at,
                  },
                ],
              },
            },
            required: [],
          } satisfies InputSpecValue,
          evidence: [
            { kind: "source", message: "provider-conflict id=optional", at },
          ],
        },
      ];
    }),
  ],
});
