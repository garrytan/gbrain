type Engine = { supersedingPageSlugs(ids: number[]): Promise<Map<number, string>> };

/** A bounded local Map fallback, returned from the handler. */
export async function supersededBy(engine: Engine, ids: number[]): Promise<Map<number, string>> {
  const empty = new Map<number, string>();
  try {
    return await engine.supersedingPageSlugs(ids);
  } catch {
    return empty;
  }
}
