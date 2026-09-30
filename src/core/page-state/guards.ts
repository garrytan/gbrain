import type { BrainEngine } from '../engine.ts';
import { validateSlug } from '../utils.ts';
import type { PageKey } from './types.ts';

/** Source locks precede auth/request locks in callers; repeat held locks safely. */
export async function lockPageKeys(engine: Pick<BrainEngine, 'executeRaw'>, keys: readonly PageKey[]): Promise<void> {
  const unique = new Map<string, PageKey>();
  for (const key of keys) {
    if (!key.sourceId) throw new TypeError('A page guard requires an exact sourceId');
    const slug = validateSlug(key.slug);
    unique.set(JSON.stringify([key.sourceId, slug]), { sourceId: key.sourceId, slug });
  }
  const ordered = [...unique.values()].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const sources = new Map<string, string>();
  for (const { sourceId } of ordered) {
    if (sources.has(sourceId)) continue;
    const rows = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE', [sourceId]);
    if (!rows.length) throw new Error(`Page source does not exist: ${sourceId}`);
    sources.set(sourceId, rows[0].incarnation);
  }
  for (const key of ordered) {
    const params = [sources.get(key.sourceId)!, key.slug];
    await engine.executeRaw('INSERT INTO page_write_guards(source_incarnation,slug) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', params);
    await engine.executeRaw('SELECT slug FROM page_write_guards WHERE source_incarnation=$1::uuid AND slug=$2 FOR UPDATE', params);
    // Also fence direct SQL row writers. The guard remains when this row is absent.
    await engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [key.sourceId, key.slug]);
  }
}

/**
 * Guards a PGLite transaction already holds, chained through its open
 * savepoints. The single PGLite session owns them until the transaction or
 * savepoint ends, so they are not re-acquired.
 */
export interface HeldPageKeys { keys: Set<string>; parent: HeldPageKeys | null }
function pageGuardKey(key: PageKey): string | null {
  if (!key.sourceId) return null;
  try { return JSON.stringify([key.sourceId, validateSlug(key.slug)]); } catch { return null; }
}
function holds(held: HeldPageKeys | null, id: string): boolean {
  for (; held; held = held.parent) if (held.keys.has(id)) return true;
  return false;
}
/** lockPageKeys for keys this transaction does not hold yet; invalid keys still reach its checks. */
export async function lockUnheldPageKeys(engine: Pick<BrainEngine, 'executeRaw'>, held: HeldPageKeys, keys: readonly PageKey[]): Promise<void> {
  const pending = keys.filter(key => { const id = pageGuardKey(key); return id === null || !holds(held, id); });
  if (!pending.length) return;
  await lockPageKeys(engine, pending);
  for (const key of pending) held.keys.add(pageGuardKey(key)!);
}
/** Runs a transaction or savepoint; a released savepoint's guards stay held by its parent, a rolled-back one's do not. */
export async function withHeldPageKeys<T>(parent: HeldPageKeys | null, run: (held: HeldPageKeys) => Promise<T>): Promise<T> {
  const held: HeldPageKeys = { keys: new Set(), parent };
  const result = await run(held);
  for (const key of held.keys) parent?.keys.add(key);
  return result;
}
