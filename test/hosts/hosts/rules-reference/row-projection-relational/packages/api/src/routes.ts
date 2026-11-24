import { db, page, selectPageSchema, selectWorkspaceSchema } from "@fixture/db";
import { userAgeSchema } from "@fixture/validators";

declare function extraFields(): Record<string, unknown>;

const gateFieldsSchema = selectPageSchema.pick({
  slug: true,
  customDomain: true,
  password: true,
});

export async function getGate() {
  const _page = await db.query.page.findFirst({
    columns: {
      slug: true,
      customDomain: true,
    },
    with: { workspace: true },
  });
  if (!_page) return null;
  const ws = selectWorkspaceSchema.safeParse(_page.workspace);
  const { workspace: _ws, ...rest } = _page;
  const gate = gateFieldsSchema.parse(rest);
  return { ws, gate };
}

export async function checkDynamicAndStripped() {
  const dynRow = await db
    .select({ id: page.id, ...extraFields() })
    .from(page)
    .get();
  const maybeOk = dynRow ? userAgeSchema.parse(dynRow) : null;
  const { age: _strippedAge, ...withoutAge } = dynRow ?? {};
  const definitelyMissing = userAgeSchema.parse(withoutAge);
  return { maybeOk, definitelyMissing };
}
