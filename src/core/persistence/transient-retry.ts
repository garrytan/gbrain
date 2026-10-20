/**
 * Large-pages hardening (b)/(c): the retry budget for a managed write's transient interruptions.
 *
 * A transient interruption ends a claim's work for a reason that is load or latency, not the write's content:
 *
 * - `statement_cancel`: the database ended one of the write's own statements with SQLSTATE 57014 (a statement timeout
 *   or cancel) while it stayed up, at preparation or inside the publication transaction;
 * - `publication_ceiling`: the publication ran past `persistence.publication_ceiling_ms` and its grace, and the owner
 *   cancelled it (publication-deadline.ts `boundPublication`), whatever error the cancelled publish then rejects with.
 *
 * Each one is counted in `transient_interruptions` (v261), never in `preparation_attempts` (the content-class budget
 * that preparations cut off at their deadline keep), and schedules the request's next claim at `next_attempt_at` with
 * a bounded exponential backoff: 1 s, 2 s, 4 s, 8 s, then 15 s. A claim never takes a queued row before it
 * (`BACKOFF_ELAPSED`), so the delay holds no claim, no root lock and no connection. The request is retried after up to
 * `persistence.max_transient_retries` interruptions (default 5); the next one ends it `failed`/`write_interrupted`.
 * The cap keeps every loop bounded: at most `max_transient_retries + 1` claims end this way.
 *
 * Contention with other transactions (a lock timeout, a serialization failure, a deadlock) and a lost connection or a
 * restarting database are not interruptions of the write's own work and are never counted (coordinator.ts
 * `transientDatabaseFailure` releases them as before). With `persistence.preparation_deadlines false` nothing is
 * counted and no backoff applies: the switch restores the uncounted release, as it does for the deadlines.
 */
import { OperationError } from '../ops/contract.ts';
import type { SqlEngine, WriteRequest } from './model.ts';
import { PERSISTENCE_PROTOCOL_PREDICATE } from './protocol.ts';
import { publicationDeadlinePassed } from './publication-deadline.ts';

export const TRANSIENT_BACKOFF_BASE_MS = 1_000;
/** The backoff's ceiling: under the managed sync drain's 30 s no-progress window (sync-drain.ts), so a backoff never reads as a stall. */
export const TRANSIENT_BACKOFF_MAX_MS = 15_000;

/** The delay before the claim after the `interruptions`-th transient interruption (1-based). */
export function transientBackoffMs(interruptions: number): number {
  return Math.min(TRANSIENT_BACKOFF_MAX_MS, TRANSIENT_BACKOFF_BASE_MS * 2 ** Math.min(30, Math.max(0, interruptions - 1)));
}

/** Whether a queued row's backoff has elapsed; every claim statement requires it. */
export const BACKOFF_ELAPSED = (alias: string) => `(${alias}.next_attempt_at IS NULL OR ${alias}.next_attempt_at<=now())`;

export type TransientCause = 'statement_cancel' | 'publication_ceiling';
export interface TransientInterruption { cause: TransientCause; sqlstate: string | null }

/**
 * The transient interruption `error` reports, else null. A publication the ceiling cancelled is read from the current
 * publication's signal (it is the cancellation, not the error it surfaces as: a discarded connection, an AbortError or a
 * 57014); a typed refusal (`OperationError`) that settles such a publication is the write's own outcome and is not one.
 */
export function transientInterruption(error: unknown): TransientInterruption | null {
  const code = (error as { code?: unknown } | null)?.code;
  const sqlstate = typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
  if (publicationDeadlinePassed() && !(error instanceof OperationError)) return { cause: 'publication_ceiling', sqlstate };
  return code === '57014' ? { cause: 'statement_cancel', sqlstate: '57014' } : null;
}

/**
 * Counts one transient interruption on a claim this owner still holds and schedules its next claim. Token-fenced; run it
 * in the transaction that releases or finishes the claim, so a crash never counts an interruption twice. Returns the count.
 */
export async function chargeTransientInterruption(engine: SqlEngine, row: WriteRequest): Promise<number> {
  const [charged] = await engine.executeRaw<{ transient_interruptions: number }>(`UPDATE persistence_requests SET transient_interruptions=transient_interruptions+1,
    next_attempt_at=now()+(LEAST($3::double precision*power(2::double precision,LEAST(transient_interruptions,30)),$4::double precision)*interval '1 millisecond'),
    updated_at=now() WHERE id=$1::uuid AND execution_token=$2::uuid AND state='running' AND ${PERSISTENCE_PROTOCOL_PREDICATE} RETURNING transient_interruptions`,
  [row.id, row.execution_token, TRANSIENT_BACKOFF_BASE_MS, TRANSIENT_BACKOFF_MAX_MS]);
  return charged?.transient_interruptions ?? (row.transient_interruptions ?? 0) + 1;
}
