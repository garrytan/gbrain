// GOOD: read scoped to the write's source (the canonical pattern).
export async function goodScoped(engine: any, slug: string, sourceId?: string): Promise<void> {
  const existing = await engine.getPage(slug, { sourceId: sourceId ?? 'default' });
  if (!existing) await engine.putPage(slug, { title: 'x' }, { sourceId: sourceId ?? 'default' });
}
// GOOD: unscoped read with an explicit opt-out marker (read-only first-match semantics).
export async function goodMarked(engine: any, slug: string): Promise<void> {
  const page = await engine.getPage(slug); // gbrain-allow-unscoped-getpage: read-only probe, first-match semantics documented
  if (page) await engine.putPage(slug, { title: page.title }, { sourceId: 'default' });
}
// GOOD: inner ternary INSIDE a scoped opts object — always source-scoped, must
// not false-positive on the "ends in undefined branch" probe.
export async function goodInnerTernary(engine: any, slug: string, src?: string): Promise<void> {
  const existing = await engine.getPage(slug, { sourceId: src ? src : 'default' });
  if (!existing) await engine.putPage(slug, { title: 'x' }, { sourceId: src ?? 'default' });
}
