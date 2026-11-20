/**
 * Doctor reads, second set: the statements `gbrain doctor` checks of the access, token, OAuth, request-log, decide,
 * memory-proposal, chronicle, feedback, belief and volunteer families ran through `executeRaw`, each with the same
 * text and parameters on the engine's own `executeRaw`; only their home moved (src/commands/doctor/**, src/core/**).
 * The Rust engine answers them from what its store keeps (rust/docs/store/cli-reads-doctor-acc.md): a relation the
 * store has no writer for answers as an empty one does.
 */
import type { EngineRawRead } from './cli-reads-ops.ts';
import { isMissingSchemaObject } from '../utils.ts';

export type { EngineRawRead } from './cli-reads-ops.ts';

/** Life Chronicle ledger rollups (automatic rows only). `available` is false when the ledger tables are absent. */
export interface ChronicleLedgerStats {
  available: boolean;
  pending: number;
  autoCalls24h: number;
  principals24h: Array<{ principal: string; calls: number }>;
  last7d: { extracted: number; failed: number; skipped: number; reasons: Record<string, number>; failedReasons: Record<string, number> };
  spend7d: { knownUsd: number; unpricedCalls: number; incompleteRecords: number };
}

export const EMPTY_CHRONICLE_LEDGER_STATS: ChronicleLedgerStats = {
  available: false, pending: 0, autoCalls24h: 0, principals24h: [],
  last7d: { extracted: 0, failed: 0, skipped: 0, reasons: {}, failedReasons: {} },
  spend7d: { knownUsd: 0, unpricedCalls: 0, incompleteRecords: 0 },
};

export async function readChronicleLedgerStats(raw: EngineRawRead): Promise<ChronicleLedgerStats> {
  try {
    const [counts] = await raw<{ pending: number; extracted: number; failed: number; skipped: number;
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
       FROM chronicle_page_state WHERE trigger = 'auto'`);
    const reasons = await raw<{ state: string; reason: string; n: number }>(
      `SELECT state, reason, count(*)::int AS n FROM chronicle_page_state
       WHERE trigger = 'auto' AND state IN ('skipped','failed') AND reason IS NOT NULL AND updated_at > now() - interval '7 days'
       GROUP BY state, reason ORDER BY n DESC, reason`);
    const tally = (rows: typeof reasons) => rows.reduce<Record<string, number>>((acc, r) => {
      acc[r.reason] = (acc[r.reason] ?? 0) + Number(r.n);
      return acc;
    }, {});
    // One reservation row per automatic judge call (retries included): the daily limit's own count.
    const [calls] = await raw<{ n: number }>(
      `SELECT count(*)::int AS n FROM chronicle_judge_reservations WHERE reserved_at > now() - interval '24 hours'`);
    const principals = await raw<{ principal: string; calls: number }>(
      `SELECT coalesce(l.principal_kind, 'unattributed') || coalesce(':' || l.principal_id, '') AS principal, count(*)::int AS calls
       FROM chronicle_judge_reservations r
       LEFT JOIN chronicle_page_state l ON l.source_id = r.source_id AND l.page_id = r.page_id
         AND l.content_hash = r.content_hash AND l.trigger = 'auto'
       WHERE r.reserved_at > now() - interval '24 hours'
       GROUP BY 1 ORDER BY calls DESC, principal LIMIT 5`);
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
    if (isMissingSchemaObject(error, 'table', ['chronicle_page_state', 'chronicle_judge_reservations'])) return EMPTY_CHRONICLE_LEDGER_STATS;
    throw error;
  }
}
