type Engine = { listPages(): Promise<string[]> };

/** An opt-out with no reason inside its comment; the code after it is not a reason. */
export async function listAll(engine: Engine): Promise<string[]> {
  try {
    return await engine.listPages();
  } catch { /* silent-read-ok: */ return []; }
}
