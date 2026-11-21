/**
 * What the serving process tells the shadow follower about committed primary writes (shadow follow, plan PR 1).
 *
 * After the outermost commit (or a standalone write) the wrapper publishes one batch of items. An item names the
 * smallest thing the follower must re-read from the primary: rows of one relation picked by a column -> `::text`
 * selector, a whole relation, or the whole mirror (`invalid`: something the producer cannot describe). `seq` rises by
 * one per batch in this process; a gap means a batch was lost, and the follower marks its watermark invalid.
 * Publishing never throws and nothing awaits it.
 */
export type Invalidation =
  /** Rows of `relation` whose columns equal `selector` (compared as text). `before_keys` are the primary-key tuples
   *  (text) of the rows that matched before the write, or null when the write only inserts or updates in place. */
  | { kind: 'rows'; relation: string; selector: Record<string, string>; before_keys: string[][] | null }
  | { kind: 'relation'; relation: string; reason: string }
  | { kind: 'invalid'; reason: string };

export interface InvalidationBatch { seq: number; committed_at: number; items: Invalidation[] }

export interface InvalidationSink {
  /** Never throws, never awaited. */
  publish(batch: InvalidationBatch): void;
}

let seqCounter = 0;
/** The next batch number for this process. */
export function nextSeq(): number { return ++seqCounter; }

const selectorKey = (relation: string, selector: Record<string, string>): string =>
  `${relation}\u0000${JSON.stringify(Object.entries(selector).sort(([a], [b]) => (a < b ? -1 : 1)))}`;

/** Drops duplicates, unions `before_keys` of equal selectors, and lets a relation item stand for its row items. */
export function mergeItems(items: readonly Invalidation[]): Invalidation[] {
  const whole = new Set<string>();
  for (const item of items) if (item.kind === 'relation') whole.add(item.relation);
  const out = new Map<string, Invalidation>();
  for (const item of items) {
    if (item.kind === 'invalid') { out.set(`i\u0000${item.reason}`, item); continue; }
    if (item.kind === 'relation') { if (!out.has(`r\u0000${item.relation}`)) out.set(`r\u0000${item.relation}`, item); continue; }
    if (whole.has(item.relation)) continue;
    const key = selectorKey(item.relation, item.selector);
    const seen = out.get(key);
    if (!seen || seen.kind !== 'rows') { out.set(key, { ...item }); continue; }
    if (item.before_keys) {
      const have = new Set((seen.before_keys ?? []).map((k) => JSON.stringify(k)));
      const added = item.before_keys.filter((k) => !have.has(JSON.stringify(k)));
      seen.before_keys = [...(seen.before_keys ?? []), ...added];
    }
  }
  return [...out.values()];
}

/** Publishes `items` as one batch; nothing when empty. Never throws. */
export function publishItems(sink: InvalidationSink, items: readonly Invalidation[]): void {
  try {
    if (items.length === 0) return;
    sink.publish({ seq: nextSeq(), committed_at: Date.now(), items: mergeItems(items) });
  } catch { /* the follower never fails a write */ }
}
