// Life Chronicle (#5876): read-only rollups of the `chronicle_page_state` ledger for doctor and
// the advisor. One query module so the surfaces cannot drift from the ledger's columns.
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';
import type { ChronicleLedgerStats } from '../engine-sql/doctor-acc.ts';

export type { ChronicleLedgerStats };


/** Automatic (trigger='auto') rows only: backfill is manual and bounded by its own --limit. */
export function readChronicleLedgerStats(engine: BrainEngine): Promise<ChronicleLedgerStats> {
  return engine.readChronicleLedgerStats();
}

export interface ChronicleDuplicateEvents { pages: number; surplus: number }

/**
 * #8972: depth pages holding live events from earlier extraction runs that the page's newest extraction (its latest
 * decided extracted ledger row, any extractor version) did not produce, and how many such events. Releases before the
 * fix re-judged long pages on every revision and added a reworded copy of each event per run; a page's partial
 * generations (#7013) count too. Read-only; only pages with two or more ledger rows that recorded events are read.
 */
export async function readChronicleDuplicateEvents(engine: BrainEngine): Promise<ChronicleDuplicateEvents> {
  try {
    const [row] = await engine.executeRaw<{ pages: number; surplus: number }>(
      `WITH multi AS (
         SELECT source_id, page_id FROM chronicle_page_state WHERE cardinality(event_slugs) > 0 GROUP BY source_id, page_id HAVING count(*) > 1),
       newest AS (
         SELECT DISTINCT ON (c.source_id, c.page_id) c.source_id, c.page_id, c.event_slugs
           FROM chronicle_page_state c JOIN multi m ON m.source_id = c.source_id AND m.page_id = c.page_id
          WHERE c.state = 'extracted' ORDER BY c.source_id, c.page_id, c.decided_at DESC, c.updated_at DESC),
       live AS (
         SELECT DISTINCT c.source_id, c.page_id, e.slug
           FROM chronicle_page_state c JOIN multi m ON m.source_id = c.source_id AND m.page_id = c.page_id
           CROSS JOIN LATERAL unnest(c.event_slugs) AS s(slug)
           JOIN pages e ON e.source_id = c.source_id AND e.slug = s.slug AND e.deleted_at IS NULL AND e.content_hash = ANY(c.event_hashes))
       SELECT count(DISTINCT l.source_id || ':' || l.page_id)::int AS pages, count(*)::int AS surplus
         FROM live l LEFT JOIN newest n ON n.source_id = l.source_id AND n.page_id = l.page_id
        WHERE n.event_slugs IS NULL OR NOT (l.slug = ANY(n.event_slugs))`);
    return { pages: Number(row?.pages ?? 0), surplus: Number(row?.surplus ?? 0) };
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', ['chronicle_page_state'])) return { pages: 0, surplus: 0 };
    throw error;
  }
}

/**
 * One line for doctor/advisor: 24 h usage against the limit, the largest writer's share, 7-day
 * outcomes and spend. `nameWriters: false` (remote advisor callers) keeps the share but not who.
 */
export function describeChronicleActivity(stats: ChronicleLedgerStats, dailyLimit: number, opts: { nameWriters?: boolean } = {}): string {
  const top = stats.principals24h[0];
  const who = opts.nameWriters === false ? '' : ` ${top?.principal}`;
  const share = top ? `; largest writer${who} used ${Math.round((top.calls / dailyLimit) * 100)}% of the daily limit` : '';
  const reasons = Object.entries(stats.last7d.reasons).slice(0, 4).map(([r, n]) => `${r} ${n}`).join(', ');
  const usd = `$${stats.spend7d.knownUsd.toFixed(2)} known spend`;
  const unpriced = stats.spend7d.unpricedCalls > 0 ? ` + ${stats.spend7d.unpricedCalls} unpriced call(s)` : '';
  const incomplete = stats.spend7d.incompleteRecords > 0 ? ` + ${stats.spend7d.incompleteRecords} call(s) with no cost record` : '';
  return `Last 24 h: ${stats.autoCalls24h} of ${dailyLimit} automatic extraction calls${share}. ` +
    `Last 7 days: ${stats.last7d.extracted} extracted, ${stats.last7d.failed} failed, ${stats.last7d.skipped} skipped` +
    `${reasons ? ` (${reasons})` : ''}; ${usd}${unpriced}${incomplete}. ${stats.pending} page(s) pending.`;
}
