/**
 * The changed-page window of a per-source cycle that runs no sync for its
 * source: a connector source (#6803), a source whose automatic sync is skipped
 * (`syncEnabled=false`, activation pending, a gbrain-owned content directory)
 * or a source with no checkout (#8573). With no sync there is no sync-derived
 * page set, so without a window its extract_facts and
 * recompute_emotional_weight phases took full-walk mode and read every page of
 * the source on every cycle, past the 30-minute job deadline on a large one.
 * The window is the source's pages changed after the previous cycle listed its
 * pages (`last_source_cycle_window_at`), read before this cycle lists them, so
 * a page edited while a cycle runs, or by an explicit `gbrain sync --source`
 * between cycles, falls in the next one.
 *
 * A source with no recorded cycle walks its pages in slug order, at most
 * `sourceFirstWalk.pageLimit` per cycle. The cursor
 * (`last_source_cycle_walk_after`) and the instant the walk began
 * (`last_source_cycle_walk_at`) are stamped so the next cycle resumes; the
 * last chunk stamps that first instant as the window, so every page changed
 * during the walk is in the window after it.
 */
import type { BrainEngine } from '../engine.ts';

export const sourceFirstWalk = { pageLimit: 2_000 };

export interface SourceCycleWindow {
  at: string | undefined;
  slugs: string[];
  /** Set on a first walk: when it began, and the last slug of this chunk when pages remain (null: walk complete). */
  walk?: { startedAt: string | undefined; next: string | null };
}

/**
 * The listing instant, moved back to just before the oldest transaction still
 * open on another connection (at most 10 minutes back): `pages.updated_at` is
 * its writer's transaction start, so a page that commits after the listing
 * still lands after the instant.
 */
const LISTING_INSTANT_SQL = `SELECT GREATEST(LEAST(clock_timestamp(),
  (SELECT min(xact_start) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()) - interval '1 millisecond'),
  clock_timestamp() - interval '10 minutes')::text AS at`;

/** The source's live pages changed after `since` (one first-walk chunk when null), and when the listing began. */
export async function listSourceChangedPages(engine: BrainEngine, sourceId: string, since: string | null): Promise<SourceCycleWindow> {
  const at = (await engine.executeRaw<{ at: string }>(LISTING_INSTANT_SQL))[0]?.at;
  if (since !== null) {
    const rows = await engine.executeRaw<{ slug: string }>(
      'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND updated_at>$2::timestamptz ORDER BY slug',
      [sourceId, since]);
    return { at, slugs: rows.map(row => row.slug) };
  }
  const [state] = await engine.executeRaw<{ after: string | null; started: string | null }>(
    `SELECT NULLIF(config->>'last_source_cycle_walk_after', '') AS after, NULLIF(config->>'last_source_cycle_walk_at', '') AS started
       FROM sources WHERE id=$1`, [sourceId]);
  const resume = state?.after && state.started && Number.isFinite(Date.parse(state.started)) ? state : null;
  const limit = sourceFirstWalk.pageLimit;
  const rows = await engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND ($2::text IS NULL OR slug>$2) ORDER BY slug LIMIT $3',
    [sourceId, resume?.after ?? null, limit + 1]);
  const slugs = rows.slice(0, limit).map(row => row.slug);
  return { at, slugs, walk: { startedAt: resume?.started ?? at, next: rows.length > limit ? slugs[slugs.length - 1]! : null } };
}

/**
 * The config stamp that starts the next window: this listing's instant, or,
 * when a phase that consumed the window (extract, extract_facts,
 * recompute_emotional_weight) failed, the same window again
 * ('' = the first walk, resumed from its stamped cursor). A first-walk chunk
 * stamps its cursor; the last one stamps the walk's first instant.
 */
export function sourceCycleWindowStamp(phases: ReadonlyArray<{ phase: string; status: string }>, since: string | null | undefined,
  window: SourceCycleWindow | undefined): Record<string, string | null> {
  if (!window?.at) return {};
  const failed = phases.some(r => (r.phase === 'extract' || r.phase === 'extract_facts' || r.phase === 'recompute_emotional_weight') && r.status === 'fail');
  if (failed) return { last_source_cycle_window_at: since ?? '' };
  if (!window.walk) return { last_source_cycle_window_at: window.at };
  return window.walk.next !== null
    ? { last_source_cycle_window_at: '', last_source_cycle_walk_after: window.walk.next, last_source_cycle_walk_at: window.walk.startedAt ?? window.at }
    : { last_source_cycle_window_at: window.walk.startedAt ?? window.at, last_source_cycle_walk_after: null, last_source_cycle_walk_at: null };
}

/** The union of the incremental slug sets the cycle collected, or undefined (full walk) when none was collected. */
export function unionSlugSets(...sets: Array<readonly string[] | undefined>): string[] | undefined {
  return sets.some(set => set !== undefined) ? Array.from(new Set(sets.flatMap(set => set ?? []))) : undefined;
}
