/**
 * The changed-page window of a per-source cycle that runs no sync for its
 * source: a connector source (#6803), a source whose automatic sync is skipped
 * (`syncEnabled=false`, activation pending, a gbrain-owned content directory)
 * or a source with no checkout (#8573). With no sync there is no sync-derived
 * page set, so without a window its extract, extract_facts and
 * recompute_emotional_weight phases took full-walk mode and read every page of
 * the source on every cycle, past the 30-minute job deadline on a large one.
 *
 * The window is the source's pages after the cursor the previous cycle stamped
 * (`last_source_cycle_window_at`, with `last_source_cycle_window_slug` as the
 * tie-break), in (`updated_at`, slug) order, at most `sourceWindow.pageLimit`
 * per cycle. A cycle that lists the rest of the window stamps its listing
 * instant; one that stops at the limit stamps its last page, so the next cycle
 * resumes there. A source with no recorded cycle starts from its oldest page.
 * A page edited while a cycle runs, or by an explicit `gbrain sync --source`
 * between cycles, moves past the cursor and falls in a later window.
 */
import type { BrainEngine } from '../engine.ts';

export const sourceWindow = { pageLimit: 2_000 };

/** The phases that work on the window's pages; the window advances only when every one of them ran without failing. */
const WINDOW_CONSUMERS = ['extract', 'extract_facts', 'recompute_emotional_weight'];

export interface SourceCycleWindow {
  /** The cursor the next window starts after (`next`), and the one this window started after (`since`). */
  next: { at: string; slug: string } | undefined;
  since: { at: string | null; slug: string };
  slugs: string[];
}

/**
 * One window of the source's live pages after `since` (every page when null), and the cursor the next one starts after.
 * Cursors bind as text: a driver that reads a timestamp parameter as a JS date keeps only milliseconds.
 * They are written as UTC ISO with microseconds whatever the session DateStyle and TimeZone (#8771): the queued
 * handler drops a cursor Date.parse cannot read, and a day-first style is not one.
 */
export async function listSourceChangedPages(engine: BrainEngine, sourceId: string, since: string | null): Promise<SourceCycleWindow> {
  const at = await engine.readCycleListingInstant();
  const config = (await engine.readSourceState(sourceId))?.config;
  const stamped = config?.last_source_cycle_window_at;
  const stampedSlug = config?.last_source_cycle_window_slug;
  const slug = since !== null && stamped === since && typeof stampedSlug === 'string' ? stampedSlug : '';
  const limit = sourceWindow.pageLimit;
  const rows = await engine.listSourceChangedPagesAfter(sourceId, since, slug, limit + 1);
  const window = { since: { at: since, slug }, slugs: rows.slice(0, limit).map(row => row.slug) };
  if (!at) return { ...window, next: undefined };
  if (rows.length <= limit) return { ...window, next: { at, slug: '' } };
  const last = rows[limit - 1]!;
  // Both are UTC ISO text with microseconds (`YYYY-MM-DDTHH:MM:SS.UUUUUUZ`), so text order is time order.
  const before = at < last.updated_at;
  return { ...window, next: before ? { at, slug: '' } : { at: last.updated_at, slug: last.slug } };
}

/**
 * The config stamp that starts the next window: its cursor, or, when a phase
 * that works on the window failed or did not run, the same window again ('' =
 * from the source's oldest page).
 */
export function sourceCycleWindowStamp(phases: ReadonlyArray<{ phase: string; status: string }>, window: SourceCycleWindow | undefined): Record<string, string> {
  if (!window?.next) return {};
  const consumed = WINDOW_CONSUMERS.every(name => phases.some(r => r.phase === name && r.status !== 'fail'));
  const cursor = consumed ? window.next : { at: window.since.at ?? '', slug: window.since.slug };
  return { last_source_cycle_window_at: cursor.at, last_source_cycle_window_slug: cursor.slug };
}

/** The union of the incremental slug sets the cycle collected, or undefined (full walk) when none was collected. */
export function unionSlugSets(...sets: Array<readonly string[] | undefined>): string[] | undefined {
  return sets.some(set => set !== undefined) ? Array.from(new Set(sets.flatMap(set => set ?? []))) : undefined;
}
