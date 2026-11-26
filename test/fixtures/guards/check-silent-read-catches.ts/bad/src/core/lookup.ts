type Engine = { getPage(slug: string): Promise<{ slug: string } | null> };

/** A failed read answers "no rows": the new site the guard must refuse. */
export async function lookupPages(engine: Engine, slug: string): Promise<Array<{ slug: string }>> {
  try {
    const page = await engine.getPage(slug);
    return page ? [page] : [];
  } catch {
    return [];
  }
}
