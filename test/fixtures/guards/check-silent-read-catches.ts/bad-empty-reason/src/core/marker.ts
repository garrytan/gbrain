type Engine = { listPages(): Promise<string[]> };

export async function listAll(engine: Engine): Promise<string[]> {
  try {
    return await engine.listPages();
  } catch { // silent-read-ok:
    return [];
  }
}
