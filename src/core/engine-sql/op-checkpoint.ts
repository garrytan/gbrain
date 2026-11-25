/** Op checkpoint and applied-capture bookkeeping statements, SQL once for both SQL engines. */
import type { BrainEngine } from '../engine.ts';

type Raw = Pick<BrainEngine, 'executeRaw'>;

/**
 * The applied-capture records (`ingest_applied_captures`) older than `ttlDays` days deleted; how many. The dream
 * cycle's bookkeeping purge (ingestion/applied-captures.ts purgeStaleAppliedCaptures), beside the checkpoint purge.
 */
export async function purgeStaleAppliedCaptures(raw: Raw, ttlDays: number): Promise<number> {
  const rows = await raw.executeRaw<{ count: string | number }>(
    `WITH deleted AS (
       DELETE FROM ingest_applied_captures WHERE applied_at < now() - ($1 || ' days')::interval RETURNING 1
     )
     SELECT count(*)::text AS count FROM deleted`,
    [String(ttlDays)]);
  return Number(rows[0]?.count ?? 0);
}
