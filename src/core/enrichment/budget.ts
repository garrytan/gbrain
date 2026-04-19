/**
 * BudgetLedger — daily spend cap for resolver calls, scope + resolver granular.
 *
 * Every paid resolver (Perplexity, Mistral OCR, etc.) should call reserve()
 * before the API call and commit() or rollback() after. The ledger tracks
 * reserved_usd + committed_usd per {scope, resolver_id, local_date} row and
 * refuses reservations that would take committed + reserved over the cap.
 *
 * Midnight rollover: the primary key includes local_date derived from an
 * IANA timezone (default America/Los_Angeles, overridable via config key
 * `budget.tz`). A new calendar day means a new row — no race between the
 * rollover thread and concurrent reserves, because there's no rollover
 * thread. We just upsert into {scope, resolver_id, today}.
 *
 * Process-death protection: reservations carry a TTL. If the process
 * crashes between reserve() and commit(), the reserved dollars stay held
 * until TTL expiry, after which cleanupExpired() zeroes them out. Worst
 * case is a few minutes of over-reservation; never an over-spend.
 *
 * Concurrency: uses SELECT FOR UPDATE on the ledger row to serialize
 * concurrent reserves for the same (scope, resolver_id, date). 10 parallel
 * callers can't double-spend. PGLite supports FOR UPDATE in its Postgres
 * compat layer.
 */

import type { BrainEngine } from '../engine.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReserveInput {
  /** Partition for multi-tenant teams; single-user installs use 'default'. */
  scope?: string;
  resolverId: string;
  /** Pre-call cost estimate in USD. */
  estimateUsd: number;
  /** Daily cap in USD for (scope, resolverId). Null/undefined = no cap. */
  capUsd?: number;
  /** Reservation TTL in seconds. Default 60s. */
  ttlSeconds?: number;
}

export type ReservationResult =
  | { kind: 'held'; reservationId: string; scope: string; resolverId: string; date: string; estimateUsd: number; reservedAt: Date; expiresAt: Date }
  | { kind: 'exhausted'; reason: string; spent: number; pending: number; cap: number };

export interface BudgetStateRow {
  scope: string;
  resolverId: string;
  date: string;
  reservedUsd: number;
  committedUsd: number;
  capUsd: number | null;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type BudgetErrorCode = 'reservation_not_found' | 'already_finalized' | 'invalid_input';

export class BudgetError extends Error {
  constructor(public code: BudgetErrorCode, message: string, public reservationId?: string) {
    super(message);
    this.name = 'BudgetError';
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_SCOPE = 'default';
const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_TZ = 'America/Los_Angeles';

// ---------------------------------------------------------------------------
// BudgetLedger
// ---------------------------------------------------------------------------

export class BudgetLedger {
  /** IANA timezone for midnight-rollover. Settable per-instance for tests. */
  private tz: string;

  constructor(private engine: BrainEngine, opts: { tz?: string } = {}) {
    this.tz = opts.tz ?? DEFAULT_TZ;
  }

  /** Reserve spend against (scope, resolverId, today). Atomic via FOR UPDATE. */
  async reserve(input: ReserveInput): Promise<ReservationResult> {
    const estimate = Number(input.estimateUsd);
    if (!Number.isFinite(estimate) || estimate < 0) {
      throw new BudgetError('invalid_input', `reserve: estimateUsd must be non-negative, got ${input.estimateUsd}`);
    }
    const scope = input.scope ?? DEFAULT_SCOPE;
    const resolverId = input.resolverId;
    const date = todayInTz(this.tz);
    const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const cap = input.capUsd ?? null;

    // Reclaim any expired reservations opportunistically before reading.
    await this.reclaimExpiredRow(scope, resolverId, date);

    return await this.engine.transaction(async (tx) => {
      // Upsert the ledger row so FOR UPDATE has something to lock.
      await tx.executeRaw(
        `INSERT INTO budget_ledger (scope, resolver_id, local_date, reserved_usd, committed_usd, cap_usd)
         VALUES ($1, $2, $3, 0, 0, $4)
         ON CONFLICT (scope, resolver_id, local_date) DO NOTHING`,
        [scope, resolverId, date, cap],
      );

      const rows = await tx.executeRaw<{ reserved_usd: string | number; committed_usd: string | number; cap_usd: string | number | null }>(
        `SELECT reserved_usd, committed_usd, cap_usd
         FROM budget_ledger
         WHERE scope = $1 AND resolver_id = $2 AND local_date = $3
         FOR UPDATE`,
        [scope, resolverId, date],
      );
      const row = rows[0];
      const reserved = toNum(row.reserved_usd);
      const committed = toNum(row.committed_usd);
      const effectiveCap = cap ?? (row.cap_usd != null ? toNum(row.cap_usd) : null);

      if (effectiveCap != null && committed + reserved + estimate > effectiveCap + 1e-9) {
        return {
          kind: 'exhausted',
          reason: `${scope}/${resolverId}@${date}: committed ${committed.toFixed(4)} + reserved ${reserved.toFixed(4)} + estimate ${estimate.toFixed(4)} > cap ${effectiveCap.toFixed(4)}`,
          spent: committed,
          pending: reserved,
          cap: effectiveCap,
        } as ReservationResult;
      }

      const reservationId = makeReservationId(scope, resolverId, date);
      const reservedAt = new Date();
      const expiresAt = new Date(reservedAt.getTime() + ttl * 1000);

      await tx.executeRaw(
        `INSERT INTO budget_reservations (reservation_id, scope, resolver_id, local_date, estimate_usd, reserved_at, expires_at, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'held')`,
        [reservationId, scope, resolverId, date, estimate, reservedAt, expiresAt],
      );

      await tx.executeRaw(
        `UPDATE budget_ledger
         SET reserved_usd = reserved_usd + $1, cap_usd = COALESCE($2, cap_usd), updated_at = now()
         WHERE scope = $3 AND resolver_id = $4 AND local_date = $5`,
        [estimate, cap, scope, resolverId, date],
      );

      return {
        kind: 'held',
        reservationId,
        scope,
        resolverId,
        date,
        estimateUsd: estimate,
        reservedAt,
        expiresAt,
      };
    });
  }

  /**
   * Commit an actual spend. actualUsd may differ from the reservation's
   * estimate — the ledger adjusts reserved_usd down by the estimate and
   * committed_usd up by the actual.
   *
   * Re-checks the cap against the post-commit total: reserving $0.01 then
   * committing $100 against a $1 cap must not silently blow through. When
   * actualUsd would exceed the effective cap, the commit clamps to (cap -
   * other_committed - other_reserved) and throws. The reservation is still
   * marked committed (the API call already happened and we don't want
   * retry loops), but the excess is attributed as a cap-exhaustion error
   * the caller can log.
   *
   * Negative actuals are rejected — refunds should be a separate operation,
   * not a side-channel on commit().
   */
  async commit(reservationId: string, actualUsd: number): Promise<void> {
    if (!Number.isFinite(actualUsd)) {
      throw new BudgetError('invalid_input', `commit: actualUsd must be finite, got ${actualUsd}`);
    }
    if (actualUsd < 0) {
      throw new BudgetError('invalid_input', `commit: actualUsd must be non-negative (got ${actualUsd}). Use a dedicated refund API instead.`);
    }

    return await this.engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<{ scope: string; resolver_id: string; local_date: string; estimate_usd: string | number; status: string }>(
        `SELECT scope, resolver_id, local_date, estimate_usd, status
         FROM budget_reservations
         WHERE reservation_id = $1
         FOR UPDATE`,
        [reservationId],
      );
      const r = rows[0];
      if (!r) throw new BudgetError('reservation_not_found', `Reservation ${reservationId} not found`);
      if (r.status !== 'held') throw new BudgetError('already_finalized', `Reservation ${reservationId} is already ${r.status}`, reservationId);

      const estimate = toNum(r.estimate_usd);

      // Re-check the cap against what the post-commit total would be.
      // Lock the ledger row so a concurrent reserve cannot race us into overspend.
      const ledgerRows = await tx.executeRaw<{ reserved_usd: string | number; committed_usd: string | number; cap_usd: string | number | null }>(
        `SELECT reserved_usd, committed_usd, cap_usd
         FROM budget_ledger
         WHERE scope = $1 AND resolver_id = $2 AND local_date = $3
         FOR UPDATE`,
        [r.scope, r.resolver_id, r.local_date],
      );
      const ledger = ledgerRows[0];
      const cap = ledger?.cap_usd != null ? toNum(ledger.cap_usd) : null;
      const committedSoFar = ledger ? toNum(ledger.committed_usd) : 0;
      const reservedSoFar = ledger ? toNum(ledger.reserved_usd) : 0;

      let chargedAmount = actualUsd;
      let overage: number | null = null;
      if (cap != null) {
        // Available headroom = cap - already-committed (exclude this reservation
        // from reserved pool since we're about to finalize it).
        const otherReserved = Math.max(0, reservedSoFar - estimate);
        const available = Math.max(0, cap - committedSoFar - otherReserved);
        if (actualUsd > available + 1e-9) {
          chargedAmount = Math.max(0, available);
          overage = actualUsd - chargedAmount;
        }
      }

      await tx.executeRaw(
        `UPDATE budget_reservations SET status = 'committed' WHERE reservation_id = $1`,
        [reservationId],
      );

      await tx.executeRaw(
        `UPDATE budget_ledger
         SET reserved_usd  = GREATEST(0, reserved_usd - $1),
             committed_usd = committed_usd + $2,
             updated_at    = now()
         WHERE scope = $3 AND resolver_id = $4 AND local_date = $5`,
        [estimate, chargedAmount, r.scope, r.resolver_id, r.local_date],
      );

      if (overage !== null && overage > 0) {
        throw new BudgetError(
          'invalid_input',
          `commit: actualUsd ${actualUsd.toFixed(4)} exceeds cap. Charged ${chargedAmount.toFixed(4)}, overage ${overage.toFixed(4)} was NOT recorded. Cap enforcement prevented double-charge but the API call already happened.`,
          reservationId,
        );
      }
    });
  }

  /** Cancel a held reservation; reserved_usd drops back. Idempotent-ish. */
  async rollback(reservationId: string): Promise<void> {
    return await this.engine.transaction(async (tx) => {
      const rows = await tx.executeRaw<{ scope: string; resolver_id: string; local_date: string; estimate_usd: string | number; status: string }>(
        `SELECT scope, resolver_id, local_date, estimate_usd, status
         FROM budget_reservations
         WHERE reservation_id = $1
         FOR UPDATE`,
        [reservationId],
      );
      const r = rows[0];
      if (!r) throw new BudgetError('reservation_not_found', `Reservation ${reservationId} not found`);
      if (r.status !== 'held') {
        // Rollback-after-commit or rollback-after-rollback are no-ops, not errors —
        // callers shouldn't have to guard defensively.
        return;
      }

      const estimate = toNum(r.estimate_usd);
      await tx.executeRaw(
        `UPDATE budget_reservations SET status = 'rolled_back' WHERE reservation_id = $1`,
        [reservationId],
      );
      await tx.executeRaw(
        `UPDATE budget_ledger
         SET reserved_usd = GREATEST(0, reserved_usd - $1), updated_at = now()
         WHERE scope = $2 AND resolver_id = $3 AND local_date = $4`,
        [estimate, r.scope, r.resolver_id, r.local_date],
      );
    });
  }

  /** Read current state for (scope, resolverId, date=today). */
  async state(scope: string, resolverId: string): Promise<BudgetStateRow | null> {
    const date = todayInTz(this.tz);
    const rows = await this.engine.executeRaw<{ reserved_usd: string | number; committed_usd: string | number; cap_usd: string | number | null }>(
      `SELECT reserved_usd, committed_usd, cap_usd
       FROM budget_ledger
       WHERE scope = $1 AND resolver_id = $2 AND local_date = $3`,
      [scope, resolverId, date],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      scope,
      resolverId,
      date,
      reservedUsd: toNum(row.reserved_usd),
      committedUsd: toNum(row.committed_usd),
      capUsd: row.cap_usd == null ? null : toNum(row.cap_usd),
    };
  }

  /** Global sweep for TTL-expired held reservations. Safe to run anytime. */
  async cleanupExpired(): Promise<{ reclaimed: number }> {
    const expired = await this.engine.executeRaw<{ reservation_id: string; scope: string; resolver_id: string; local_date: string; estimate_usd: string | number }>(
      `SELECT reservation_id, scope, resolver_id, local_date, estimate_usd
       FROM budget_reservations
       WHERE status = 'held' AND expires_at < now()`,
    );
    let reclaimed = 0;
    for (const r of expired) {
      try {
        await this.rollback(r.reservation_id);
        reclaimed++;
      } catch (e: unknown) {
        if (e instanceof BudgetError && e.code === 'already_finalized') continue;
        throw e;
      }
    }
    return { reclaimed };
  }

  private async reclaimExpiredRow(scope: string, resolverId: string, date: string): Promise<void> {
    const expired = await this.engine.executeRaw<{ reservation_id: string }>(
      `SELECT reservation_id FROM budget_reservations
       WHERE scope = $1 AND resolver_id = $2 AND local_date = $3
         AND status = 'held' AND expires_at < now()`,
      [scope, resolverId, date],
    );
    for (const r of expired) {
      try { await this.rollback(r.reservation_id); } catch { /* non-fatal */ }
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function todayInTz(tz: string): string {
  // Intl.DateTimeFormat with the en-CA locale yields YYYY-MM-DD formatting.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return fmt.format(new Date());
}

function toNum(v: string | number | null): number {
  if (v == null) return 0;
  const n = typeof v === 'string' ? parseFloat(v) : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function makeReservationId(scope: string, resolverId: string, date: string): string {
  const rand = Math.floor(Math.random() * 1e12).toString(36);
  const ts = Date.now().toString(36);
  return `${scope}:${resolverId}:${date}:${ts}-${rand}`;
}
