/**
 * #5012: the opt-in Updates reciprocity rule for the deterministic loop
 * detector. With `loops.updates_require_reciprocity` on (default off), a
 * reply-owed loop on Gmail Updates mail opens only when the owner has written
 * to the sender: the sender appears in a stored thread the owner wrote in, or
 * the owner wrote a substantive message in this thread. Off, the set is null
 * and the detector ignores the category, so a cold introduction that Gmail
 * files under Updates still opens a loop.
 *
 * The owner-wrote-to set is built from stored email pages (one query over the
 * source's thread pages whose `senders` include an owner address), at most
 * once per sweep: it is cached per engine and source for REBUILD_MS.
 */
import type { BrainEngine } from '../engine.ts';

export const LOOPS_UPDATES_RECIPROCITY_KEY = 'loops.updates_require_reciprocity';
const REBUILD_MS = 10 * 60_000;
const ON = new Set(['true', '1', 'on', 'yes']);
const OFF = new Set(['false', '0', 'off', 'no']);

/** Null when `value` is a boolean `config set` accepts for the key; otherwise the refusal text (nothing is written). */
export function validateLoopsReciprocityConfigValue(key: string, value: string): string | null {
  if (key !== LOOPS_UPDATES_RECIPROCITY_KEY) return null;
  const v = value.trim().toLowerCase();
  return ON.has(v) || OFF.has(v) ? null
    : `${key} must be true or false (default false: Gmail Updates mail opens reply-owed loops like any other mail; got "${value}"). Nothing was written.`;
}

const cache = new WeakMap<BrainEngine, Map<string, { set: ReadonlySet<string> | null; loadedAt: number }>>();

/** The addresses the owner has written to in this source, or null when the rule is off (the default). */
export async function ownerWroteToFor(engine: BrainEngine, sourceId: string, myAddresses: ReadonlySet<string>): Promise<ReadonlySet<string> | null> {
  let perEngine = cache.get(engine);
  if (!perEngine) cache.set(engine, perEngine = new Map());
  const hit = perEngine.get(sourceId);
  if (hit && Date.now() - hit.loadedAt < REBUILD_MS) return hit.set;
  let enabled = false;
  try {
    enabled = ON.has(String(await engine.getConfig(LOOPS_UPDATES_RECIPROCITY_KEY) ?? '').trim().toLowerCase());
  } catch { /* unreadable config keeps the default (off) */ }
  let set: ReadonlySet<string> | null = null;
  if (enabled) {
    const rows = await engine.executeRaw<{ addr: string }>(
      `SELECT DISTINCT lower(a.addr) AS addr
         FROM pages p,
              jsonb_array_elements_text(CASE WHEN jsonb_typeof(p.frontmatter->'participants') = 'array'
                                             THEN p.frontmatter->'participants' ELSE '[]'::jsonb END) AS a(addr)
        WHERE p.source_id = $1 AND p.type = 'email' AND p.deleted_at IS NULL
          AND jsonb_typeof(p.frontmatter->'senders') = 'array'
          AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.frontmatter->'senders') AS s(addr)
                       WHERE lower(s.addr) = ANY(string_to_array($2, E'\\n')))`,
      [sourceId, [...myAddresses].join('\n')],
    );
    set = new Set(rows.map((r) => r.addr).filter((a) => !myAddresses.has(a)));
  }
  perEngine.set(sourceId, { set, loadedAt: Date.now() });
  return set;
}

/** Test seam: forget the cached setting and set (per engine when given). */
export function __clearReciprocityCacheForTests(engine: BrainEngine): void {
  cache.delete(engine);
}
