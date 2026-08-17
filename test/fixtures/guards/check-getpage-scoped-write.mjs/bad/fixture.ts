// BAD: unscoped existence check + default-scoped write in one file.
export async function badNoOpts(engine: any, slug: string): Promise<void> {
  const existing = await engine.getPage(slug);
  if (!existing) await engine.putPage(slug, { title: 'x' });
}
// BAD: conditional-undefined read (any-source when unset) + write via importFromContent.
export async function badTernary(engine: any, slug: string, sourceId?: string): Promise<void> {
  const existing = await engine.getPage(slug, sourceId ? { sourceId } : undefined);
  if (!existing) await importFromContent(engine, slug, '# x', { sourceId });
}
// BAD: EXPANDED ternary — `{ sourceId: x }` object-literal colon must not hide the
// undefined false branch (regression pin for the [^:]* regex gap).
export async function badExpandedTernary(engine: any, slug: string, src?: string): Promise<void> {
  const existing = await engine.getPage(slug, src ? { sourceId: src } : undefined);
  if (!existing) await engine.putPage(slug, { title: 'x' }, { sourceId: src ?? 'default' });
}
// BAD: empty-object false branch — {} is just as unscoped as undefined.
export async function badEmptyObjectBranch(engine: any, slug: string, src?: string): Promise<void> {
  const existing = await engine.getPage(slug, src ? { sourceId: src } : {});
  if (!existing) await engine.putPage(slug, { title: 'x' }, { sourceId: src ?? 'default' });
}
declare function importFromContent(...args: unknown[]): Promise<unknown>;
