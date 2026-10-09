import type { BrainEngine } from '../engine.ts';
import { validateSlug } from '../utils.ts';
import type { PageKey } from './types.ts';
import { pipelined } from './transactions.ts';

/**
 * Source locks precede auth/request locks in callers; repeat held locks safely.
 * #5984: the guard statements are pipelined in the sorted key order. Keys that
 * all carry their source's expected `incarnation` send the source reads in the
 * same pipeline; a source that is missing or was recreated then fails the call
 * after its statements ran, so the caller's transaction must roll back.
 */
export async function lockPageKeys(engine: Pick<BrainEngine, 'executeRaw'> & { kind?: string }, keys: readonly PageKey[]): Promise<void> {
  const unique = new Map<string, PageKey>();
  for (const key of keys) {
    if (!key.sourceId) throw new TypeError('A page guard requires an exact sourceId');
    const slug = validateSlug(key.slug);
    unique.set(JSON.stringify([key.sourceId, slug]), { sourceId: key.sourceId, slug, ...(key.incarnation ? { incarnation: key.incarnation } : {}) });
  }
  const ordered = [...unique.values()].sort((a, b) => a.sourceId < b.sourceId ? -1 : a.sourceId > b.sourceId ? 1 : a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);
  const expected = new Map<string, string>();
  for (const { sourceId, incarnation } of ordered) if (incarnation && (expected.get(sourceId) ?? incarnation) === incarnation) expected.set(sourceId, incarnation);
  const hinted = ordered.every(key => key.incarnation && expected.get(key.sourceId) === key.incarnation);
  const readSource = (sourceId: string) => engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE', [sourceId]).then(rows => {
    if (!rows.length) throw new Error(`Page source does not exist: ${sourceId}`);
    if (hinted && rows[0]!.incarnation !== expected.get(sourceId)) throw new Error(`Page source was recreated: ${sourceId}`);
    return rows[0]!.incarnation;
  });
  // One unhinted key (the common single write): its share lock and the guard statements are sent together;
  // the guards take the incarnation from the locked row, and a missing source is reported before anything else.
  if (!hinted && ordered.length === 1) {
    const key = ordered[0]!;
    await pipelined({ kind: engine.kind ?? '' }, [
      async () => {
        const rows = await engine.executeRaw<{ incarnation: string }>('SELECT incarnation FROM sources WHERE id=$1 FOR SHARE', [key.sourceId]);
        if (!rows.length) throw new Error(`Page source does not exist: ${key.sourceId}`);
      },
      () => engine.executeRaw('INSERT INTO page_write_guards(source_incarnation,slug) SELECT incarnation,$2 FROM sources WHERE id=$1 ON CONFLICT DO NOTHING', [key.sourceId, key.slug]),
      () => engine.executeRaw('SELECT g.slug FROM page_write_guards g JOIN sources s ON s.incarnation=g.source_incarnation WHERE s.id=$1 AND g.slug=$2 FOR UPDATE OF g', [key.sourceId, key.slug]),
      // Also fence direct SQL row writers. The guard remains when this row is absent.
      () => engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [key.sourceId, key.slug]),
    ]);
    return;
  }
  const run = (calls: Array<() => Promise<unknown>>) => pipelined({ kind: engine.kind ?? '' }, calls);
  const sources = new Map<string, string>(hinted ? expected : []);
  const reads: Array<() => Promise<unknown>> = [];
  for (const sourceId of new Set(ordered.map(key => key.sourceId))) {
    if (hinted) reads.push(() => readSource(sourceId));
    else sources.set(sourceId, await readSource(sourceId));
  }
  if (ordered.length > 1) {
    // #5984: many keys in three statements, still created and locked in the sorted key order.
    const incarnations = ordered.map(key => sources.get(key.sourceId)!), slugs = ordered.map(key => key.slug), sourceIds = ordered.map(key => key.sourceId);
    await run([...reads,
      () => engine.executeRaw('INSERT INTO page_write_guards(source_incarnation,slug) SELECT i,s FROM unnest($1::uuid[],$2::text[]) WITH ORDINALITY AS k(i,s,n) ORDER BY n ON CONFLICT DO NOTHING', [incarnations, slugs]),
      () => engine.executeRaw(`SELECT g.slug FROM unnest($1::uuid[],$2::text[]) WITH ORDINALITY AS k(i,s,n)
      JOIN page_write_guards g ON g.source_incarnation=k.i AND g.slug=k.s ORDER BY k.n FOR UPDATE OF g`, [incarnations, slugs]),
      () => engine.executeRaw(`SELECT p.id FROM unnest($1::text[],$2::text[]) WITH ORDINALITY AS k(src,s,n)
      JOIN pages p ON p.source_id=k.src AND p.slug=k.s ORDER BY k.n FOR UPDATE OF p`, [sourceIds, slugs]),
    ]);
    return;
  }
  await run([...reads, ...ordered.flatMap(key => {
    const params = [sources.get(key.sourceId)!, key.slug];
    return [
      () => engine.executeRaw('INSERT INTO page_write_guards(source_incarnation,slug) VALUES ($1::uuid,$2) ON CONFLICT DO NOTHING', params),
      () => engine.executeRaw('SELECT slug FROM page_write_guards WHERE source_incarnation=$1::uuid AND slug=$2 FOR UPDATE', params),
      // Also fence direct SQL row writers. The guard remains when this row is absent.
      () => engine.executeRaw('SELECT id FROM pages WHERE source_id=$1 AND slug=$2 FOR UPDATE', [key.sourceId, key.slug]),
    ];
  })]);
}

/**
 * Guards a transaction already holds, chained through its open savepoints.
 * The transaction's session owns them until the transaction or savepoint
 * ends, so they are not re-acquired. That includes a key whose pages row was
 * absent when it was locked: the only pages INSERT (engine-sql/pages.ts
 * putPage) runs after both engines' putPage take the same guard.
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
export async function lockUnheldPageKeys(engine: Pick<BrainEngine, 'executeRaw'> & { kind?: string }, held: HeldPageKeys, keys: readonly PageKey[]): Promise<void> {
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
