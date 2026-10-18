/**
 * #6803: the changed-page window of a connector source's cycle. A connector
 * cycle has no sync phase, so without a window its extract_facts and
 * recompute_emotional_weight phases took full-walk mode and read every page of
 * the brain on every cycle, past the 30-minute job deadline on a large brain.
 * The window is the source's pages changed after the previous cycle listed its
 * pages (`last_source_cycle_window_at`), read before this cycle lists them, so
 * a page edited while a cycle runs falls in the next one.
 */
import type { BrainEngine } from '../engine.ts';

export interface SourceCycleWindow { at: string | undefined; slugs: string[] }

/** The source's live pages changed after `since` (every page when null), and when the listing began. */
export async function listSourceChangedPages(engine: BrainEngine, sourceId: string, since: string | null): Promise<SourceCycleWindow> {
  const at = (await engine.executeRaw<{ at: string }>('SELECT clock_timestamp()::text AS at'))[0]?.at;
  const rows = await engine.executeRaw<{ slug: string }>(
    'SELECT slug FROM pages WHERE source_id=$1 AND deleted_at IS NULL AND ($2::timestamptz IS NULL OR updated_at>$2::timestamptz) ORDER BY slug',
    [sourceId, since]);
  return { at, slugs: rows.map(row => row.slug) };
}

/**
 * The config stamp that starts the next window: this listing's instant, or,
 * when a phase that consumed the window failed, the same window again
 * ('' = every page of the source).
 */
export function sourceCycleWindowStamp(phases: ReadonlyArray<{ phase: string; status: string }>, since: string | null | undefined,
  window: SourceCycleWindow | undefined): { last_source_cycle_window_at?: string } {
  if (!window?.at) return {};
  const failed = phases.some(r => (r.phase === 'extract_facts' || r.phase === 'recompute_emotional_weight') && r.status === 'fail');
  return { last_source_cycle_window_at: failed ? (since ?? '') : window.at };
}

/** The union of the incremental slug sets the cycle collected, or undefined (full walk) when none was collected. */
export function unionSlugSets(...sets: Array<readonly string[] | undefined>): string[] | undefined {
  return sets.some(set => set !== undefined) ? Array.from(new Set(sets.flatMap(set => set ?? []))) : undefined;
}
