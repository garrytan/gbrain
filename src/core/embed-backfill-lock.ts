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
