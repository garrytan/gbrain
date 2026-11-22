type Engine = {
  getPage(slug: string): Promise<{ slug: string } | null>;
  listPages(): Promise<string[]>;
  setConfig(key: string, value: string): Promise<void>;
  supersedingPageSlugs(ids: number[]): Promise<Map<number, string>>;
};
declare function rethrowCapabilityRefusal(err: unknown): void;
declare function degraded(stage: string): void;

/** Baselined: scripts/silent-read-catches-baseline.tsv carries a row for it. */
export async function legacyLookup(engine: Engine, slug: string): Promise<Array<{ slug: string }>> {
  try {
    const page = await engine.getPage(slug);
    return page ? [page] : [];
  } catch {
    return [];
  }
}

/** Opted out with a reason on the line above the catch. */
export async function preMigration(engine: Engine): Promise<string[]> {
  try {
    return await engine.listPages();
  // silent-read-ok: the table does not exist before migration 104, so no rows is the right answer
  } catch {
    return [];
  }
}

/** Opted out with an inline block comment that carries its reason. */
export async function inlineReason(engine: Engine): Promise<string[]> {
  try {
    return await engine.listPages();
  } catch { /* silent-read-ok: a brain older than migration 104 has no pages table, so no rows is right */ return []; }
}

/** A typed degraded marker, not an empty answer. */
export async function marked(engine: Engine, ids: number[]): Promise<Map<number, string>> {
  try {
    return await engine.supersedingPageSlugs(ids);
  } catch (err) {
    rethrowCapabilityRefusal(err);
    degraded('supersession');
    throw err;
  }
}

/** A write-only method on the named list: not a read, so not counted. */
export async function remember(engine: Engine): Promise<boolean> {
  try {
    await engine.setConfig('k', 'v');
    return true;
  } catch {
    return false;
  }
}

/** A catch around code that reads nothing from the brain. */
export function parseSettings(text: string): Record<string, unknown> {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}
