/**
 * The reads of a per-source cycle's changed-page window (src/core/cycle/source-window.ts) that ran through
 * `engine.executeRaw`, now typed members so a Rust brain answers them from its store (rust/docs/store/cycle-window.md).
 * The statements are the ones the window ran; the window's "is the listing instant before the last page" comparison now
 * happens on the two ISO texts, which sort as time. Unscoped on master (they ran on the pool).
 */
import type { LegacyUnscopedRead } from './brands.ts';

/** One page of a window; `updated_at` is UTC ISO with microseconds. */
export interface SourceChangedPageRow { slug: string; updated_at: string }

/**
 * The listing instant, moved back to just before the oldest transaction still open on another connection the cycle's
 * role can see (at most 10 minutes back), as UTC ISO text with microseconds.
 */
export const CYCLE_LISTING_INSTANT_SQL = `SELECT to_char(GREATEST(LEAST(clock_timestamp(),
  (SELECT min(xact_start) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type <> 'autovacuum worker') - interval '1 millisecond'),
  clock_timestamp() - interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`;

/** The cycle's listing instant, or null when the engine answers no row. */
export async function readCycleListingInstant(exec: LegacyUnscopedRead): Promise<string | null> {
  const [row] = await exec.executeRaw<{ at: string | null }>(CYCLE_LISTING_INSTANT_SQL);
  return row?.at ?? null;
}

/** One window of live pages after the cursor `(since, slug)`; cursors bind as text (a driver reading a timestamp parameter as a JS date keeps milliseconds). */
export const SOURCE_CHANGED_PAGES_AFTER_SQL = `SELECT slug, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR (updated_at, slug COLLATE "C") > ($2::text::timestamptz, $3::text))
      ORDER BY updated_at, slug COLLATE "C" LIMIT $4`;

/** Up to `limit` live pages of a source after the cursor, by `(updated_at, slug bytes)`; every page when `since` is null. */
export async function listSourceChangedPagesAfter(exec: LegacyUnscopedRead, sourceId: string, since: string | null, slug: string, limit: number): Promise<SourceChangedPageRow[]> {
  return exec.executeRaw<SourceChangedPageRow>(SOURCE_CHANGED_PAGES_AFTER_SQL, [sourceId, since, slug, limit]);
}
