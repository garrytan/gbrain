// Life Chronicle (#5876): read-only rollups of the `chronicle_page_state` ledger for doctor and
// the advisor. One query module so the surfaces cannot drift from the ledger's columns.
import type { BrainEngine } from '../engine.ts';
import { isMissingSchemaObject } from '../utils.ts';

export interface ChronicleLedgerStats {
  /** False when the ledger table is absent (migration not applied yet). */
  available: boolean;
  pending: number;
  /** Automatic extraction calls in the last rolling 24 hours (each counts against the daily limit). */
  autoCalls24h: number;
  /** Automatic calls per writer principal in the last 24 hours, largest first. */
  principals24h: Array<{ principal: string; calls: number }>;
  /** Automatic rows decided in the last 7 days: by state, by skip/failure reason, and failure reasons alone. */
  last7d: { extracted: number; failed: number; skipped: number; reasons: Record<string, number>; failedReasons: Record<string, number> };
  /** Automatic spend in the last 7 days: priced dollars, unpriced calls and calls with no cost record, kept apart. */
  spend7d: { knownUsd: number; unpricedCalls: number; incompleteRecords: number };
}

const EMPTY: ChronicleLedgerStats = {
  available: false, pending: 0, autoCalls24h: 0, principals24h: [],
  last7d: { extracted: 0, failed: 0, skipped: 0, reasons: {}, failedReasons: {} },
  spend7d: { knownUsd: 0, unpricedCalls: 0, incompleteRecords: 0 },
};

/** Automatic (trigger='auto') rows only: backfill is manual and bounded by its own --limit. */
export async function readChronicleLedgerStats(engine: BrainEngine): Promise<ChronicleLedgerStats> {
  try {
    const [counts] = await engine.executeRaw<{ pending: number; extracted: number; failed: number; skipped: number;
      known_usd: number | null; unpriced: number; incomplete: number }>(
      `SELECT
         count(*) FILTER (WHERE state = 'pending')::int AS pending,
         count(*) FILTER (WHERE state = 'extracted' AND updated_at > now() - interval '7 days')::int AS extracted,
         count(*) FILTER (WHERE state = 'failed' AND updated_at > now() - interval '7 days')::int AS failed,
         count(*) FILTER (WHERE state = 'skipped' AND updated_at > now() - interval '7 days')::int AS skipped,
         sum(cost_usd) FILTER (WHERE NOT unpriced AND updated_at > now() - interval '7 days')::float8 AS known_usd,
         count(*) FILTER (WHERE unpriced AND state IN ('extracted','failed') AND updated_at > now() - interval '7 days')::int AS unpriced,
         count(*) FILTER (WHERE NOT unpriced AND cost_usd IS NULL AND state IN ('extracted','failed') AND attempts > 0
           AND updated_at > now() - interval '7 days')::int AS incomplete
       FROM chronicle_page_state WHERE trigger = 'auto'`,
    );
    const reasons = await engine.executeRaw<{ state: string; reason: string; n: number }>(
      `SELECT state, reason, count(*)::int AS n FROM chronicle_page_state
       WHERE trigger = 'auto' AND state IN ('skipped','failed') AND reason IS NOT NULL AND updated_at > now() - interval '7 days'
       GROUP BY state, reason ORDER BY n DESC, reason`,
    );
    const tally = (rows: typeof reasons) => rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + Number(r.n);
      return acc;
    }, {});
    // One reservation row per automatic judge call (retries included): the daily limit's own count.
    const [calls] = await engine.executeRaw<{ n: number }>(
      `SELECT count(*)::int AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'`,
    );
    const principals = await engine.executeRaw<{ principal: string; calls: number }>(
      `SELECT coalesce(l.principal_kind, 'unattributed') || coalesce(':' || l.principal_id, '') AS principal, count(*)::int AS calls
       FROM chronicle_judge_reservations r
       LEFT JOIN chronicle_page_state l ON l.source_id = r.source_id AND l.page_id = r.page_id
         AND l.content_hash = r.content_hash AND l.trigger = 'auto'
       WHERE r.reserved_at > now() - interval '24 hours'
       GROUP BY 1 ORDER BY calls DESC, principal LIMIT 5`,
    );
    return {
      available: true,
      pending: Number(counts?.pending ?? 0),
      autoCalls24h: Number(calls?.n ?? 0),
      principals24h: principals.map((p) => ({ principal: p.principal, calls: Number(p.calls) })),
      last7d: { extracted: Number(counts?.extracted ?? 0), failed: Number(counts?.failed ?? 0), skipped: Number(counts?.skipped ?? 0),
        reasons: tally(reasons), failedReasons: tally(reasons.filter((r) => r.state === 'failed')) },
      spend7d: { knownUsd: Number(counts?.known_usd ?? 0), unpricedCalls: Number(counts?.unpriced ?? 0),
        incompleteRecords: Number(counts?.incomplete ?? 0) },
    };
  } catch (error) {
    if (isMissingSchemaObject(error, 'table', ['chronicle_page_state', 'chronicle_judge_reservations'])) return EMPTY;
    throw error;
  }
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
