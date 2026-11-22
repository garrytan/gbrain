type Engine = { listPages(): Promise<string[]> };
declare function isEngineCapabilityRefusal(err: unknown): boolean;

/** Rethrows one kind of failure, then answers "no pages" for every other: a failed read still looks empty. */
export async function pageSlugs(engine: Engine): Promise<string[]> {
  try {
    return await engine.listPages();
  } catch (err) {
    if (isEngineCapabilityRefusal(err)) throw err;
    return [];
  }
}
