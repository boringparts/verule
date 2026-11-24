import { db, page, selectWorkspaceSchema } from "@fixture/db";
import { dynSchema, pageSlugSchema } from "@fixture/validators";

declare function extraFields(): Record<string, unknown>;

export async function checkCases(external: unknown) {
  const partialPage = await db.query.page.findFirst({
    columns: { slug: true, customDomain: true },
    with: { workspace: { columns: { id: true } } },
  });
  if (!partialPage) return null;

  // Bracket access on nested relation missing `slug` -> MUST report
  const badBracketWs = selectWorkspaceSchema.safeParse(
    partialPage["workspace"],
  );

  // Destructured same-name and aliased relation missing `slug` -> MUST report
  const { workspace } = partialPage;
  const badDestructWs = selectWorkspaceSchema.safeParse(workspace);
  const { workspace: wsAlias } = partialPage;
  const badAliasWs = selectWorkspaceSchema.safeParse(wsAlias);

  // Chained rest destructuring omitting `slug` -> MUST report missing `slug`
  const { customDomain: _cd, ...r1 } = partialPage;
  const { slug: _slug, ...r2 } = r1;
  const badChainedRest = pageSlugSchema.parse(r2);

  // Counterexample: rest omitted `workspace`, so `withoutWs.workspace` must NOT match original relation
  const { workspace: _omittedWs, ...withoutWs } = partialPage;
  const omittedRel = selectWorkspaceSchema.safeParse(
    (withoutWs as Record<string, unknown>).workspace,
  );

  // Passing case: r1 retains `slug`
  const okRest = pageSlugSchema.parse(r1);

  // Dynamic projection gap case
  const dynRow = await db
    .select({ id: page.id, ...extraFields() })
    .from(page)
    .get();
  const dynOut = dynRow ? dynSchema.parse(dynRow) : null;

  // Unrelated non-query input
  const extOut = pageSlugSchema.parse(external);

  return {
    badBracketWs,
    badDestructWs,
    badAliasWs,
    badChainedRest,
    omittedRel,
    okRest,
    dynOut,
    extOut,
  };
}
