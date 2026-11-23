type Engine = { listPages(): Promise<string[]> };

/** An initialized empty fallback and an empty catch: a failed read looks like "no pages". */
export async function pageSlugs(engine: Engine): Promise<string[]> {
  let rows: string[] = [];
  try {
    rows = await engine.listPages();
  } catch {}
  return rows;
}
