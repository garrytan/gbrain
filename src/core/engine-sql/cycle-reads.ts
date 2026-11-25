/**
 * The cycle, belief and sync statements that ran through `engine.executeRaw` and are now typed members, so a Rust brain
 * answers each from its store (rust/docs/store/cycle-window.md, trust.md). PGLite and Postgres run the statements their callers ran; the notes below name the
 * few places a statement changed shape.
 *
 *  - the per-source cycle's changed-page window (cycle/source-window.ts): the listing instant and one window of pages.
 *    The "is the listing instant before the last page" comparison now happens on the two UTC ISO texts, which sort as
 *    time, instead of in a third statement.
 *  - the belief ledger's orphan lifetimes (belief/coverage-report.ts): the limit is a bound parameter, not spliced text.
 *  - the phantom-redirect pass's walk of root pages lives in engine-sql/facts-cycle.ts (`listRootPageSlugsAfter`).
 */
import type { EngineRawRead } from './cli-reads-ops.ts';

export type { EngineRawRead };

// ─── the per-source cycle's window ───────────────────────────────────────

/** One page of a window; `updated_at` is UTC ISO with microseconds. */
export interface SourceChangedPageRow { slug: string; updated_at: string }

/**
 * The listing instant, moved back to just before the oldest transaction still open on another connection the cycle's
 * role can see (at most 10 minutes back), as UTC ISO text with microseconds; null when the engine returns no row.
 */
export async function readCycleListingInstant(raw: EngineRawRead): Promise<string | null> {
  const [row] = await raw<{ at: string | null }>(`SELECT to_char(GREATEST(LEAST(clock_timestamp(),
  (SELECT min(xact_start) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type <> 'autovacuum worker') - interval '1 millisecond'),
  clock_timestamp() - interval '10 minutes') AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`);
  return row?.at ?? null;
}

/** Up to `limit` live pages of a source after the cursor `(since, slug)`, by `(updated_at, slug bytes)`; every page when `since` is null. Cursors bind as text (a driver reading a timestamp parameter as a JS date keeps milliseconds). */
export async function listSourceChangedPagesAfter(raw: EngineRawRead, sourceId: string, since: string | null, slug: string, limit: number): Promise<SourceChangedPageRow[]> {
  return raw<SourceChangedPageRow>(`SELECT slug, to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at FROM pages
      WHERE source_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR (updated_at, slug COLLATE "C") > ($2::text::timestamptz, $3::text))
      ORDER BY updated_at, slug COLLATE "C" LIMIT $4`, [sourceId, since, slug, limit]);
}

// ─── the belief ledger's orphan lifetimes ────────────────────────────────

export type OrphanReason = 'no_page' | 'no_lifetime';
export interface OrphanLifetimeSamples { count: number; samples: Array<{ slug: string; page_lifetime: string; reason: OrphanReason }> }

/** Open lifetimes with no page at their slug (an untracked hard delete), and (`deep`, a whole-ledger read) events naming a lifetime that does not exist. */
export async function listOrphanLifetimes(raw: EngineRawRead, sourceId: string, limit: number, deep: boolean): Promise<OrphanLifetimeSamples> {
  const rows = await raw<{ slug: string; page_lifetime: string; reason: OrphanReason; total: number }>(`SELECT slug, page_lifetime, reason, count(*) OVER ()::int AS total FROM (
      SELECT l.slug, l.page_lifetime::text AS page_lifetime, 'no_page' AS reason FROM belief_page_lifetimes l JOIN sources s ON s.id = l.source_id AND s.incarnation = l.source_incarnation
      WHERE l.source_id = $1 AND l.ended_at IS NULL AND NOT EXISTS (SELECT 1 FROM pages p WHERE p.source_id = l.source_id AND p.slug = l.slug)
      UNION ALL SELECT DISTINCT e.slug, e.page_lifetime::text, 'no_lifetime' FROM belief_events e
      WHERE $2::boolean AND e.source_id = $1 AND e.page_lifetime IS NOT NULL AND NOT EXISTS (SELECT 1 FROM belief_page_lifetimes l WHERE l.page_lifetime = e.page_lifetime)
    ) o ORDER BY slug COLLATE "C", page_lifetime COLLATE "C" LIMIT $3`, [sourceId, deep, Math.min(Math.max(1, Math.floor(limit)), 2 ** 31 - 1)]);
  return { count: Number(rows[0]?.total ?? 0), samples: rows.map(r => ({ slug: r.slug, page_lifetime: r.page_lifetime, reason: r.reason })) };
}
