type Engine = { getLinks(slug: string): Promise<string[]> };

export async function linksOf(engine: Engine, slug: string): Promise<string[]> {
  return engine.getLinks(slug).catch(() => []);
}
