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
 * #5495: why a round halted, as a closed vocabulary stored per reason in
 * `extract_rollup_7d.halt_reasons` (migration v239) next to `halt_count`.
 * No provider text and no paths ever enter the table: a caller passes one of
 * these, or `true` for a halt it cannot classify, which reads back as
 * `unknown` (`halt_count - sum(halt_reasons)`, computed on read, so rows
 * written before the column and by older writers need no backfill).
 */
export const HALT_REASONS = Object.freeze([
  'provider_auth',
  'provider_billing',
  'provider_rate_limit',
  'provider_model_not_found',
  'no_pricing',
  'integrity_guard',
  'item_error',
] as const);
export type HaltReason = (typeof HALT_REASONS)[number];
/** The read-side bucket for halts no reason was recorded for; never written. */
export const UNKNOWN_HALT_REASON = 'unknown';

/** The provider error classes a phase's global LLM halt tracker reports, as halt reasons. */
export function providerHaltReason(cls: 'auth' | 'billing' | 'rate_limit' | 'model_not_found' | null | undefined): HaltReason | null {
  switch (cls) {
    case 'auth': return 'provider_auth';
    case 'billing': return 'provider_billing';
    case 'rate_limit': return 'provider_rate_limit';
    case 'model_not_found': return 'provider_model_not_found';
    default: return null;
  }
}

/** Reasons recorded on 7-day rows plus the read-side `unknown` bucket for the halts no reason covers. */
export function haltReasonsWithUnknown(haltCount: number, recorded: Record<string, number | string>): Record<string, number> {
  const reasons: Record<string, number> = {};
  let classified = 0;
  for (const [reason, n] of Object.entries(recorded)) {
    const count = Number(n) || 0;
    if (count <= 0) continue;
    reasons[reason] = count;
    classified += count;
  }
  const unknown = haltCount - classified;
  if (unknown > 0) reasons[UNKNOWN_HALT_REASON] = unknown;
  return reasons;
}

/**
 * The halt reasons recorded over the last 7 days, summed per kind. A brain
 * whose schema is behind v239 has no column: every halt then reads as
 * `unknown` (a backfill never runs; `unknown` is computed on read).
 */
export async function readRecordedHaltReasons7d(engine: Pick<BrainEngine, 'executeRaw'>): Promise<Map<string, Record<string, number>>> {
  const recorded = new Map<string, Record<string, number>>();
  try {
    const rows = await engine.executeRaw<{ kind: string; reason: string; n: number | string }>(
      `SELECT r.kind, e.key AS reason, SUM(e.value::int) AS n
         FROM extract_rollup_7d r, jsonb_each_text(r.halt_reasons) e
        WHERE r.day >= CURRENT_DATE - 7
        GROUP BY r.kind, e.key`, []);
    for (const row of rows) {
      const perKind = recorded.get(row.kind) ?? {};
      perKind[row.reason] = Number(row.n) || 0;
      recorded.set(row.kind, perKind);
    }
  } catch (err) {
    if (!/halt_reasons/i.test((err as Error).message || String(err))) throw err;
  }
  return recorded;
}

/** The most frequent halt reason, `unknown` included, or null without halts. */
export function topHaltReason(reasons: Record<string, number>): { reason: string; count: number } | null {
  let top: { reason: string; count: number } | null = null;
  for (const [reason, count] of Object.entries(reasons)) {
    if (!top || count > top.count || (count === top.count && reason < top.reason)) top = { reason, count };
  }
  return top;
}

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
  /** #4482: EXPECTED-limit stop (per-source budget / walltime cap working as
   * designed — partial progress banked, more on the next run). Orthogonal to
   * halt_delta so doctor's failure rate can exclude self-imposed capacity
   * limits. Column added by migration v141. */
  expected_limit_delta?: number;
  /** Increment rollup_write_failures inside the table (used by the
   * self-healing path that records its own write failures forensically). */
  failure_delta?: number;
  /** #5495: the reason `halt_delta` halts are counted under in `halt_reasons`; omitted halts read as `unknown`. */
  halt_reason?: HaltReason;
}

/**
 * #4482: shared classification of how an extract run stopped, so every
 * extractor records the same three-way split instead of hand-folding its
 * flags into one `halted` boolean:
 *   - error (provider/auth/global abort, per-page failures) → halt_delta=1 —
 *     the failure-oriented signal doctor warns on, unchanged from today;
 *   - expected cap only (budget/deadline, no error) → expected_limit_delta=1
 *     — a capacity signal, observable but NOT a failure;
 *   - clean completion → round_completed_delta=1.
 * An error present alongside a cap counts as an error (the cap didn't cause
 * the failed work).
 */
export function classifyRunStop(stop: {
  budget_exhausted?: boolean;
  deadline_hit?: boolean;
  /** `true` for an unclassified error halt (reads as `unknown`); a HaltReason names it (#5495). A cap is never a halt reason. */
  error?: boolean | HaltReason;
}): { round_completed_delta: number; halt_delta: number; expected_limit_delta: number; halt_reason?: HaltReason } {
  if (stop.error === true || (typeof stop.error === 'string' && (HALT_REASONS as readonly string[]).includes(stop.error))) {
    return { round_completed_delta: 0, halt_delta: 1, expected_limit_delta: 0, ...(typeof stop.error === 'string' ? { halt_reason: stop.error } : {}) };
  }
  if (stop.budget_exhausted === true || stop.deadline_hit === true) {
    return { round_completed_delta: 0, halt_delta: 0, expected_limit_delta: 1 };
  }
  return { round_completed_delta: 1, halt_delta: 0, expected_limit_delta: 0 };
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
  const expectedLimits = input.expected_limit_delta ?? 0;
  const failures = input.failure_delta ?? 0;
  // #5495: the reason bucket this event's halts land in (null: unclassified,
  // read back as `unknown`). Bound as text and keyed in SQL: never JSON text
  // cast to jsonb (the #2339 class), and only vocabulary words reach the table.
  const reason = halts > 0 && input.halt_reason && (HALT_REASONS as readonly string[]).includes(input.halt_reason) ? input.halt_reason : null;

  try {
    await engine.executeRaw(
      `INSERT INTO extract_rollup_7d (
         kind, source_id, day,
         cost_usd, halt_count, eval_fail_count, eval_pass_count,
         round_completed_count, expected_limit_count, rollup_write_failures, halt_reasons, updated_at
       )
       VALUES ($1, $2, $3::date, $4, $5, $6, $7, $8, $9, $10,
         CASE WHEN $11::text IS NULL THEN '{}'::jsonb ELSE jsonb_build_object($11::text, $5::int) END, now())
       ON CONFLICT (kind, source_id, day) DO UPDATE SET
         cost_usd               = extract_rollup_7d.cost_usd               + EXCLUDED.cost_usd,
         halt_count             = extract_rollup_7d.halt_count             + EXCLUDED.halt_count,
         eval_fail_count        = extract_rollup_7d.eval_fail_count        + EXCLUDED.eval_fail_count,
         eval_pass_count        = extract_rollup_7d.eval_pass_count        + EXCLUDED.eval_pass_count,
         round_completed_count  = extract_rollup_7d.round_completed_count  + EXCLUDED.round_completed_count,
         expected_limit_count   = extract_rollup_7d.expected_limit_count   + EXCLUDED.expected_limit_count,
         rollup_write_failures  = extract_rollup_7d.rollup_write_failures  + EXCLUDED.rollup_write_failures,
         halt_reasons           = CASE WHEN $11::text IS NULL THEN extract_rollup_7d.halt_reasons
           ELSE jsonb_set(extract_rollup_7d.halt_reasons, ARRAY[$11::text],
             to_jsonb(COALESCE((extract_rollup_7d.halt_reasons->>$11::text)::int, 0) + $5::int)) END,
         updated_at             = now()`,
      [input.kind, input.source_id, day, cost, halts, evalFails, evalPasses, completed, expectedLimits, failures, reason],
    );
    return { ok: true };
  } catch (err) {
    const msg = (err as Error).message || String(err);
    // #5495 (no fallback by design): a brain whose schema is behind v239 has no
    // halt_reasons column. The rollup is a best-effort cache, so the row is
    // lost until the migration runs; say which fix restores it.
    if (/halt_reasons/i.test(msg)) {
      rollupErrorLogOnce(input.kind, day, `${msg} (the schema is behind: doctor reports migrations_pending; run gbrain apply-migrations --yes --no-autopilot-install)`);
      return { ok: false, error: msg };
    }
    // #4482 back-compat: a brain that hasn't applied migration v141 yet has
    // no expected_limit_count column. Rather than losing the WHOLE rollup
    // write (best-effort would swallow it), retry the pre-v141 statement —
    // the cap stop degrades to the old conflated halt accounting until the
    // migration runs.
    if (/expected_limit_count/i.test(msg)) {
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
          [input.kind, input.source_id, day, cost, halts + expectedLimits, evalFails, evalPasses, completed, failures],
        );
        return { ok: true };
      } catch { /* fall through to the normal failure record */ }
    }
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
