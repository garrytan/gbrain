type Engine = { getPage(slug: string): Promise<{ slug: string } | null> };

/** No silent catch any more: the baseline row below is stale and must be deleted. */
export async function lookupPages(engine: Engine, slug: string): Promise<Array<{ slug: string }>> {
  const page = await engine.getPage(slug);
  return page ? [page] : [];
}
