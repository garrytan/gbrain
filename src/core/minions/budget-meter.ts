/**
 * Durable reserve-then-settle meter for paid OAuth/MCP operations.
 *
 * Reserve-then-settle pattern (D3) prevents the "concurrent requests bust the
 * cap" race that the pre-v82 best-effort post-call recording allowed. Two
 * calls from the same OAuth client both pre-flight pass at $2 of $5,
 * both spend $2, total spend = $4 of $5 → fine. But raise the per-call
 * estimate to $3 and both calls see "$5 cap - $2 spent = $3 headroom, ok"
 * and both proceed, total spend = $8. That's the bug. The fix is atomic
 * check-and-reserve under pg_advisory_xact_lock.
 *
 * The lock key is hashed from client_id (or the group budget key). Stale reservations (worker
 * crashed before settle) become overdue after `RESERVATION_TTL_MS`.
 * Their liability remains reserved until actual usage is reconciled: a
 * timeout or UTC day change is not evidence that a provider did no work.
 *
 * Mirror of the rate-leases.ts pattern (the v0.15 rate-lease helper does
 * the same shape for outbound provider concurrency caps).
 */

import { randomUUIDv7 } from 'bun';
import type { BrainEngine } from '../engine.ts';
import { clientLockKey } from '../engine-sql/spend-log.ts';
import { BudgetExceededError } from '../spend-log.ts';

/** Reservation TTL — 10 minutes. Long enough for a normal provider call;
 *  an overdue hold stays charged until its outcome is known. */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

export interface ReserveOpts {
  clientId: string;
  estimatedCents: number;
  capCents: number | null;
  estimateKnown?: boolean;
  model: string;
  provider: string;
  jobId?: number;
  /** Trusted runtime recheck, run under the client lock before admitting IO. */
  validateAdmission?: (tx: BrainEngine) => Promise<void>;
}

export interface Reservation {
  reservationId: string;
  estimatedCents: number;
  ttlMs: number;
}

/**
 * Atomic check-and-reserve. Under `pg_advisory_xact_lock(client_id_hash)`:
 *
 *   1. Sweep expired pending reservations for this client.
 *   2. SUM today's settled spend + all unresolved reservations, across dates.
 *   3. If `committed + pending + estimated > cap`, throw `BudgetExceededError`.
 *   4. INSERT pending reservation row with TTL.
 *   5. Return reservation id.
 *
 * Lock auto-releases at transaction end (xact-scoped). All statements commit
 * or roll back as one transaction.
 */
export async function reserve(
  engine: BrainEngine,
  opts: ReserveOpts,
): Promise<Reservation> {
  assertNonEmpty('clientId', opts.clientId);
  assertFiniteNonNegative('estimatedCents', opts.estimatedCents);
  if (opts.capCents !== null) assertFiniteNonNegative('capCents', opts.capCents);
  assertNonEmpty('model', opts.model);
  assertNonEmpty('provider', opts.provider);
  if (opts.jobId !== undefined && (!Number.isSafeInteger(opts.jobId) || opts.jobId <= 0)) {
    throw new TypeError('jobId must be a positive safe integer when provided');
  }

  const reservationId = randomUUIDv7();
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
  const dayStart = todayStart();

  await engine.transaction(async (tx) => {
    // The member takes the per-client lock (Postgres), reads the configured cap under a row lock, sweeps, sums and
    // inserts as one admission (engine-sql/spend-log.ts). The trusted recheck runs inside the same transaction, so a
    // refusal of it rolls the whole admission back.
    const admission = await tx.reserveClientSpend({
      reservation_id: reservationId, client_id: opts.clientId, estimated_cents: opts.estimatedCents, cap_cents: opts.capCents,
      estimate_known: opts.estimateKnown !== false, model: opts.model, provider: opts.provider, job_id: opts.jobId ?? null,
      expires_at: expiresAt, day_start: dayStart,
    });
    await opts.validateAdmission?.(tx);
    if (admission.outcome === 'invalid_cap') assertFiniteNonNegative('configured cap', admission.cap_cents);
    if (admission.outcome === 'invalid_total') throw new Error(`invalid ${admission.label} returned by spend ledger`);
    if (admission.outcome === 'refused') {
      const { committed_cents: committedCents, pending_cents: pendingCents, cap_cents: cap } = admission;
      throw new BudgetExceededError(
        `budget exceeded for client ${opts.clientId}: ` +
        `committed=${committedCents.toFixed(2)}¢, pending=${pendingCents.toFixed(2)}¢, ` +
        `estimated=${opts.estimatedCents.toFixed(2)}¢, cap=${cap.toFixed(2)}¢; unresolved unknown usage remains reserved`,
        committedCents + pendingCents,
        cap,
      );
    }
  });

  return {
    reservationId,
    estimatedCents: opts.estimatedCents,
    ttlMs: RESERVATION_TTL_MS,
  };
}

/**
 * Why a group reservation was refused. `exhausted`: settled spend plus
 * overdue holds leave no room, so the group is done. `pressure`: only live
 * holds of concurrent attempts are in the way; a retry after they settle can
 * be admitted.
 */
export class GroupBudgetRefusal extends BudgetExceededError {
  constructor(
    readonly kind: 'exhausted' | 'pressure',
    readonly budgetKey: string,
    readonly spend: GroupSpend,
    capCents: number,
  ) {
    super(
      `budget ${kind === 'exhausted' ? 'exhausted' : 'under pressure'} for ${budgetKey}: ` +
      `committed=${spend.committedCents.toFixed(2)}¢, overdue=${spend.overdueCents.toFixed(2)}¢, ` +
      `live=${spend.liveCents.toFixed(2)}¢, cap=${capCents.toFixed(2)}¢`,
      spend.committedCents + spend.overdueCents,
      capCents,
    );
    this.name = 'GroupBudgetRefusal';
  }
}

/** A group budget's lifetime totals in cents. Overdue holds count as spent until reconciled. */
export interface GroupSpend {
  committedCents: number;
  overdueCents: number;
  liveCents: number;
}

/** Read-only group totals; a pending hold past its deadline reads as overdue. */
export async function readGroupSpend(engine: BrainEngine, budgetKey: string): Promise<GroupSpend> {
  assertNonEmpty('budgetKey', budgetKey);
  const totals = await engine.readGroupSpendTotals(budgetKey);
  return {
    committedCents: requiredFiniteTotal(totals.committed_cents, 'committed spend'),
    overdueCents: requiredFiniteTotal(totals.overdue_cents, 'overdue spend'),
    liveCents: requiredFiniteTotal(totals.live_cents, 'pending spend'),
  };
}

/** A reservation against a command group's shared budget (`group:<group_id>`) instead of an OAuth client. */
export type GroupReserveOpts = Omit<ReserveOpts, 'clientId' | 'validateAdmission'> & { budgetKey: string };

/**
 * Group reservation: one approved total shared by every job of a command
 * group, summed over the group's lifetime (no daily window, no client row).
 * Under the same per-key advisory lock as client reservations:
 *
 *   1. Expire this key's pending holds past their deadline (overdue).
 *   2. Settled spend plus overdue holds at or over the cap → `exhausted`.
 *   3. The attempt reserves its maximum, bounded by the remaining headroom,
 *      so one attempt can always run while nothing else is in flight; its
 *      actual cost is charged at settle, and a settled total at the cap
 *      refuses the next reservation.
 *   4. Live holds of concurrent attempts that leave no room → `pressure`.
 *
 * A null cap reserves without a check (spend is still ledgered). Unknown
 * estimates are admitted at their stated amount: the caller decides whether
 * an unpriced attempt may run.
 */
export async function reserveGroup(engine: BrainEngine, opts: GroupReserveOpts): Promise<Reservation> {
  const key = opts.budgetKey;
  assertNonEmpty('budgetKey', key);
  assertFiniteNonNegative('estimatedCents', opts.estimatedCents);
  if (opts.capCents !== null) assertFiniteNonNegative('capCents', opts.capCents);
  assertNonEmpty('model', opts.model);
  assertNonEmpty('provider', opts.provider);
  if (opts.jobId !== undefined && (!Number.isSafeInteger(opts.jobId) || opts.jobId <= 0)) {
    throw new TypeError('jobId must be a positive safe integer when provided');
  }
  const reservationId = randomUUIDv7();
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
  // Inside one transaction, so a refusal rolls back the sweep the admission ran (as the lock-and-insert always did).
  const estimated = await engine.transaction(async (tx) => {
    const admission = await tx.reserveGroupSpend({
      reservation_id: reservationId, budget_key: key, estimated_cents: opts.estimatedCents, cap_cents: opts.capCents,
      estimate_known: opts.estimateKnown !== false, model: opts.model, provider: opts.provider, job_id: opts.jobId ?? null,
      expires_at: expiresAt,
    });
    if (admission.outcome === 'invalid_total') throw new Error(`invalid ${admission.label} returned by spend ledger`);
    if (admission.outcome === 'refused') {
      throw new GroupBudgetRefusal(admission.kind, key, {
        committedCents: admission.committed_cents, overdueCents: admission.overdue_cents, liveCents: admission.live_cents,
      }, opts.capCents as number);
    }
    return admission.estimated_cents;
  });
  return { reservationId, estimatedCents: estimated, ttlMs: RESERVATION_TTL_MS };
}

/**
 * Settle a reservation with the actual spend. Idempotent — second call
 * on the same reservation_id no-ops. Also writes a row to `mcp_spend_log`
 * so the rollup query in the next reserve sees the committed spend.
 */
export async function settle(
  engine: BrainEngine,
  reservationId: string,
  actualCents: number,
  operation: string = 'subagent_loop',
  tokenName: string | null = null,
): Promise<void> {
  assertNonEmpty('reservationId', reservationId);
  assertFiniteNonNegative('actualCents', actualCents);
  assertNonEmpty('operation', operation);

  // A late result may arrive after the TTL sweeper marked the hold expired. Settle that paid work too: truthfully
  // recording a late overage is safer than dropping it. The ledger row (so getTodaySpendCents/reserve see it) is
  // written with the state transition as one write, so an accounting failure rolls the transition back.
  const settled = await engine.settleSpendWithLog(reservationId, actualCents, operation, tokenName);
  if (settled.outcome === 'missing') throw new Error(`spend reservation not found: ${reservationId}`);
}

/**
 * Sweeper called by tests + the worker startup hook. Marks any
 * pending reservation past its TTL as 'expired'. This is an overdue marker,
 * not a release: unknown usage stays NULL and counts against future admission.
 *
 * Returns the number of rows expired.
 */
export async function sweepExpiredReservations(engine: BrainEngine): Promise<number> {
  return engine.expireSpendReservations();
}

/** Read the per-client cap from oauth_clients.budget_usd_per_day. Returns
 *  `null` when no cap is set (legacy clients pre-v83). */
export async function getClientDailyCapCents(
  engine: BrainEngine,
  clientId: string,
): Promise<number | null> {
  assertNonEmpty('clientId', clientId);
  const raw = await engine.readClientBudgetUsd(clientId);
  if (raw === null || raw === undefined) return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`invalid budget_usd_per_day for OAuth client ${clientId}`);
  }
  // oauth_clients stores NUMERIC(..., 2) USD, so its public cents view is
  // integral. Round to avoid binary floating-point artifacts (e.g. 0.29).
  return Math.round(usd * 100);
}

function todayStart(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function assertNonEmpty(name: string, value: string): void {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

function assertFiniteNonNegative(name: string, value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new TypeError(`${name} must be a finite non-negative number`);
  }
}

function requiredFiniteTotal(value: unknown, label: string): number {
  const total = Number(value ?? 0);
  if (!Number.isFinite(total) || total < 0) {
    throw new Error(`invalid ${label} returned by spend ledger`);
  }
  return total;
}

/** The lock-key helper moved to engine-sql/spend-log.ts; kept exported here for existing callers and tests. */
export { clientLockKey };

/** Re-export BudgetExceededError for one-stop import. */
export { BudgetExceededError };
