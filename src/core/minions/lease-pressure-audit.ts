/**
 * v0.41 Bug 2 + Eng D3+D8 — lease-pressure audit writer.
 *
 * Writes one row per `RateLeaseUnavailableError` bounce to the
 * `minion_lease_pressure_log` table (migration v94). The doctor check
 * `subagent_health` and `gbrain jobs stats lease_pressure` read this
 * table to surface pressure to operators.
 *
 * Why DB table (not JSONL): doctor + jobs stats need SQL aggregation
 * across many bounces in a rolling window; JSONL would require parsing
 * + filtering per query. The audit table has indexes on `bounced_at DESC`
 * and `job_id` for the exact access patterns those consumers need.
 *
 * Denormalization at write time (Eng D8 / codex pass-3 #7): `queue_name`,
 * `job_name`, `model`, `provider`, `root_owner_id` are persisted inline so
 * post-NULL forensic queries (after `gbrain jobs prune` pulls the job row)
 * still carry enough context to answer "was there pressure on Anthropic
 * messages last Tuesday at 3pm." Without denormalization, post-NULL rows
 * would be timestamp-only residue.
 *
 * Best-effort: write failures (e.g. DB blip during the worker's lease-full
 * bypass) log to stderr but never throw — losing one audit row is
 * preferable to failing the bypass path that prevents dead-letter.
 */

import type { BrainEngine } from '../engine.ts';

export interface LeasePressureRecord {
  /** Job that bounced (FK target; SET NULL on prune so audit survives). */
  job_id: number;
  /** Lease key the bounce happened on (e.g. `anthropic:messages`). */
  lease_key: string;
  /** `activeCount` observed at bounce time (diagnostic). */
  active_at_bounce: number;
  /** `maxConcurrent` checked against (diagnostic). */
  max_concurrent: number;
  /**
   * Denormalized context — persists past job pruning so aggregate forensic
   * queries (the "what model had pressure last week" shape) still work.
   * Pass best-effort values from the calling worker; nulls are accepted.
   */
  queue_name?: string | null;
  job_name?: string | null;
  model?: string | null;
  provider?: string | null;
  root_owner_id?: number | null;
}

/**
 * Append one lease-pressure event. Best-effort — DB failures log to stderr
 * and return without throwing so the worker's lease-full bypass path
 * (which is the actual fix for the field-report dead-letter loop) is
 * never blocked by audit-table write problems.
 */
export async function logLeasePressure(
  engine: BrainEngine,
  record: LeasePressureRecord,
): Promise<void> {
  try {
    await engine.executeRaw(
      `INSERT INTO minion_lease_pressure_log
         (job_id, lease_key, active_at_bounce, max_concurrent,
          queue_name, job_name, model, provider, root_owner_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        record.job_id,
        record.lease_key,
        record.active_at_bounce,
        record.max_concurrent,
        record.queue_name ?? null,
        record.job_name ?? null,
        record.model ?? null,
        record.provider ?? null,
        record.root_owner_id ?? null,
      ],
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[lease-pressure-audit] WARN: write failed for job ${record.job_id}: ${msg}\n`,
    );
  }
}

/**
 * Read lease-pressure events in a rolling window. Used by `gbrain doctor`'s
 * `subagent_health` check and by `gbrain jobs stats lease_pressure`.
 * Returns the raw rows so callers can do their own aggregation; the count
 * is the operationally useful aggregate.
 */
export async function readRecentLeasePressure(
  engine: BrainEngine,
  windowMs: number,
  opts: { limit?: number } = {},
): Promise<Array<LeasePressureRecord & { id: number; bounced_at: string }>> {
  const limit = opts.limit ?? 1000;
  const rows = await engine.executeRaw<{
    id: number;
    job_id: number | null;
    lease_key: string;
    active_at_bounce: number;
    max_concurrent: number;
    bounced_at: string;
    queue_name: string | null;
    job_name: string | null;
    model: string | null;
    provider: string | null;
    root_owner_id: number | null;
  }>(
    `SELECT id, job_id, lease_key, active_at_bounce, max_concurrent,
            bounced_at, queue_name, job_name, model, provider, root_owner_id
       FROM minion_lease_pressure_log
       WHERE bounced_at > now() - ($1::double precision * interval '1 millisecond')
       ORDER BY bounced_at DESC
       LIMIT $2`,
    [windowMs, limit],
  );
  return rows.map(r => ({
    id: r.id,
    job_id: r.job_id ?? 0, // job_id is SET NULL after prune; surface as 0 for callers that don't care
    lease_key: r.lease_key,
    active_at_bounce: r.active_at_bounce,
    max_concurrent: r.max_concurrent,
    bounced_at: r.bounced_at,
    queue_name: r.queue_name,
    job_name: r.job_name,
    model: r.model,
    provider: r.provider,
    root_owner_id: r.root_owner_id,
  }));
}

/**
 * Bounded count of lease-pressure events in a rolling window. Cheaper
 * than `readRecentLeasePressure` for callers that only want the metric.
 */
export async function countRecentLeasePressure(
  engine: BrainEngine,
  windowMs: number,
): Promise<number> {
  const rows = await engine.executeRaw<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM minion_lease_pressure_log
       WHERE bounced_at > now() - ($1::double precision * interval '1 millisecond')`,
    [windowMs],
  );
  return parseInt(rows[0]?.count ?? '0', 10);
}
