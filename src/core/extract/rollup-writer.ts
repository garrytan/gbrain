/**
 * v0.42 — Per-day extract-event rollup writer (best-effort cache).
 *
 * Sister module to receipt-writer.ts. Where receipts are first-class
 * brain pages (long-term audit trail), the rollup table is a fast-read
 * cache the doctor `extract_health` check reads to keep latency under
 * 100ms regardless of audit volume.
 *
 * F-OUT-19 dual-write posture:
 *   - JSONL audit (~/.gbrain/audit/...) is the SOURCE OF TRUTH
 *     (forensic, append-only, crash-safe).
 *   - This DB rollup is BEST-EFFORT. Failures bump a counter
 *     (rollup_write_failures) inside the table itself and stderr-warn;
 *     they NEVER fail the parent extraction operation.
 *   - When persistent failures accumulate (>10/hr per future doctor
 *     rule), an auto-rebuild from JSONL self-heals the cache.
 *
 * Schema (migration v106):
 *   extract_rollup_7d (kind, source_id, day, cost_usd, halt_count,
 *                      eval_fail_count, eval_pass_count,
 *                      round_completed_count, rollup_write_failures,
 *                      updated_at, PK(kind, source_id, day))
 *
 * Concurrency: PostgreSQL INSERT ... ON CONFLICT DO UPDATE is
 * concurrency-safe for the per-(kind, source_id, day) PK. Multiple
 * parallel extractions on the same day land cleanly without a lock
 * (UPSERT is atomic per row).
 */

import type { BrainEngine } from '../engine.ts';

/**
 * One UPSERT increments per audit event. All counters default to 0 so
 * callers only specify the deltas they care about (e.g. a round-completed
 * event passes round_completed_delta=1; an eval-fail event passes
 * eval_fail_delta=1; a halt event passes halt_delta=1). cost_delta is the
 * cumulative cost ADD for the period this event represents.
 */
export interface RollupUpsertInput {
  kind: string;
  source_id: string;
  /** ISO YYYY-MM-DD. Defaults to today (UTC) if omitted. */
  day?: string;
  cost_delta?: number;
  halt_delta?: number;
  eval_fail_delta?: number;
  eval_pass_delta?: number;
  round_completed_delta?: number;
  /** Increment rollup_write_failures inside the table (used by the
   * self-healing path that records its own write failures forensically). */
  failure_delta?: number;
}

function today(): string {
  // ISO YYYY-MM-DD in UTC. Matches Postgres CURRENT_DATE behavior for
  // UTC servers; for local-time servers there's a slight drift at midnight
  // but rollup is best-effort cache so the drift is acceptable.
  return new Date().toISOString().slice(0, 10);
}

/**
 * UPSERT one rollup event. Best-effort: catches all errors, logs to
 * stderr once per (kind, day, error-class) so it doesn't spam, returns
 * a boolean indicating success.
 *
 * Caller composes multiple deltas in one call (round_completed + cost
 * together is typical) so the rollup row is one UPSERT per audit event,
 * not N UPSERTs.
 */
export async function upsertExtractRollup(
  engine: BrainEngine,
  input: RollupUpsertInput,
): Promise<{ ok: boolean; error?: string }> {
  const day = input.day ?? today();
  const cost = input.cost_delta ?? 0;
  const halts = input.halt_delta ?? 0;
  const evalFails = input.eval_fail_delta ?? 0;
  const evalPasses = input.eval_pass_delta ?? 0;
  const completed = input.round_completed_delta ?? 0;
  const failures = input.failure_delta ?? 0;

  try {
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (
         kind, source_id, day,
         cost_usd, halt_count, eval_fail_count, eval_pass_count,
         round_completed_count, rollup_write_failures, updated_at
       )
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, now())
       ON CONFLICT (kind, source_id, day) DO UPDATE SET
         cost_usd               = extract_rollup_7d.cost_usd               + EXCLUDED.cost_usd,
         halt_count             = extract_rollup_7d.halt_count             + EXCLUDED.halt_count,
         eval_fail_count        = extract_rollup_7d.eval_fail_count        + EXCLUDED.eval_fail_count,
         eval_pass_count        = extract_rollup_7d.eval_pass_count        + EXCLUDED.eval_pass_count,
         round_completed_count  = extract_rollup_7d.round_completed_count  + EXCLUDED.round_completed_count,
         rollup_write_failures  = extract_rollup_7d.rollup_write_failures  + EXCLUDED.rollup_write_failures,
         updated_at             = now()`,
      [input.kind, input.source_id, day, cost, halts, evalFails, evalPasses, completed, failures],
    );
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // Don't spam: log once per process per (kind, day) error class.
    rollupErrorLogOnce(input.kind, day, msg);
    return { ok: false, error: msg };
  }
}

const _loggedRollupErrors = new Set<string>();
function rollupErrorLogOnce(kind: string, day: string, msg: string): void {
  // Classify by error first 80 chars to dedupe "lock timeout" vs
  // "connection refused" but not by exact text.
  const klass = msg.slice(0, 80);
  const key = `${kind}|${day}|${klass}`;
  if (_loggedRollupErrors.has(key)) return;
  _loggedRollupErrors.add(key);
  console.error(
    `[extract-rollup] write failed (best-effort; audit JSONL remains source of truth): ${msg}`,
  );
}

/**
 * Test seam: clear the logged-errors set so repeated test invocations
 * surface stderr each time.
 */
export function _resetRollupErrorLogForTests(): void {
  _loggedRollupErrors.clear();
}
