/**
 * Shared lock identity for embed backfills (paced-backfill E-2).
 *
 * The per-source lock key + TTL live here, in a zero-dependency module, so BOTH
 * the `embed-backfill` minion handler AND the CLI `embed --stale` single-flight
 * take the SAME key — a hand-run backfill and a queued job are then mutually
 * exclusive per source. Kept dependency-free to avoid an import cycle between
 * embed.ts, embed-stale.ts, and the handler.
 */

/** Per-source embed-backfill lock id, namespaced like sync's. */
export function embedBackfillLockId(sourceId: string): string {
  return `gbrain-embed-backfill:${sourceId}`;
}

/** Lock TTL (minutes) for embed backfills. */
export const EMBED_BACKFILL_LOCK_TTL_MIN = 60;

/**
 * Lock id for the `embed --stale --facts` drain. Its own key, NOT
 * `embedBackfillLockId('facts')`: a source may legitimately be named `facts`,
 * and the facts pass must neither block nor be blocked by the chunk drain.
 * ponytail: one global key regardless of --source scope, so an all-source run
 * and a scoped run stay mutually exclusive without the chunk path's sorted
 * per-source acquire; per-source keys if concurrent scoped facts drains ever
 * matter.
 */
export const EMBED_FACTS_BACKFILL_LOCK_ID = 'gbrain-embed-facts-backfill';
