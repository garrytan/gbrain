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
 * The lock key is hashed from client_id. Stale reservations (worker
 * crashed before settle) expire after `RESERVATION_TTL_MS` and the
 * sweeper reclaims them on the next reserve call.
 *
 * Mirror of the rate-leases.ts pattern (the v0.15 rate-lease helper does
 * the same shape for outbound provider concurrency caps).
 */

import { randomUUIDv7 } from 'bun';
import type { BrainEngine } from '../engine.ts';
import { sqlQueryForEngine } from '../sql-query.ts';
import { BudgetExceededError } from '../spend-log.ts';

/** Reservation TTL — 10 minutes. Long enough for a normal provider call;
 *  short enough that crashed callers don't strand capacity for long. */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Generate an int hash of client_id for pg_advisory_xact_lock. */
function clientLockKey(clientId: string): number {
  // FNV-1a 32-bit hash (deterministic, no deps, fits in INT32 / BIGINT).
  let h = 0x811c9dc5;
  for (let i = 0; i < clientId.length; i++) {
    h ^= clientId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // pg_advisory_xact_lock(BIGINT) — unsigned 32-bit value fits in BIGINT.
  return h >>> 0;
}

export interface ReserveOpts {
  clientId: string;
  estimatedCents: number;
  capCents: number;
  model: string;
  provider: string;
  jobId?: number;
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
 *   2. SUM today's settled spend from mcp_spend_log + pending estimated
 *      from mcp_spend_reservations.
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
  assertFiniteNonNegative('capCents', opts.capCents);
  assertNonEmpty('model', opts.model);
  assertNonEmpty('provider', opts.provider);
  if (opts.jobId !== undefined && (!Number.isSafeInteger(opts.jobId) || opts.jobId <= 0)) {
    throw new TypeError('jobId must be a positive safe integer when provided');
  }

  const reservationId = randomUUIDv7();
  const lockKey = clientLockKey(opts.clientId);
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
  const todayStart = todayStartIso();

  await engine.transaction(async (tx) => {
    const sql = sqlQueryForEngine(tx);

    // Postgres can run several MCP requests for one client concurrently.
    // Hold a transaction-scoped lock across sweep + read + insert so two
    // callers cannot both observe the same headroom. PGLite serializes its
    // single connection and does not implement advisory locks.
    if (tx.kind === 'postgres') {
      await sql`SELECT pg_advisory_xact_lock(${BigInt(lockKey)})`;
    }

    // Step 1: sweep expired reservations for this client.
    await sql`
      UPDATE mcp_spend_reservations
         SET status = 'expired', actual_cents = 0
       WHERE client_id = ${opts.clientId}
         AND status = 'pending'
         AND expires_at < now()
    `;

    // Step 2 + 3: SUM committed + pending, refuse if over cap.
    const rows = await sql`
      SELECT
        COALESCE((
          SELECT SUM(spend_cents)::text
            FROM mcp_spend_log
           WHERE client_id = ${opts.clientId}
             AND created_at >= ${todayStart}
        ), '0') AS committed_text,
        COALESCE((
          SELECT SUM(estimated_cents)::text
            FROM mcp_spend_reservations
           WHERE client_id = ${opts.clientId}
             AND status = 'pending'
             AND created_at >= ${todayStart}
        ), '0') AS pending_text
    `;
    const committedCents = requiredFiniteTotal(rows[0]?.committed_text, 'committed spend');
    const pendingCents = requiredFiniteTotal(rows[0]?.pending_text, 'pending spend');
    const totalProjected = committedCents + pendingCents + opts.estimatedCents;
    if (totalProjected > opts.capCents) {
      throw new BudgetExceededError(
        `budget exceeded for client ${opts.clientId}: ` +
        `committed=${committedCents.toFixed(2)}¢, pending=${pendingCents.toFixed(2)}¢, ` +
        `estimated=${opts.estimatedCents.toFixed(2)}¢, cap=${opts.capCents.toFixed(2)}¢`,
        committedCents + pendingCents,
        opts.capCents,
      );
    }

    // Step 4: INSERT reservation before releasing the client lock.
    await sql`
      INSERT INTO mcp_spend_reservations
        (reservation_id, client_id, job_id, estimated_cents, model, provider, status, expires_at)
      VALUES
        (${reservationId}, ${opts.clientId}, ${opts.jobId ?? null},
         ${opts.estimatedCents}, ${opts.model}, ${opts.provider}, 'pending', ${expiresAt})
    `;
  });

  return {
    reservationId,
    estimatedCents: opts.estimatedCents,
    ttlMs: RESERVATION_TTL_MS,
  };
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

  await engine.transaction(async (tx) => {
    const sql = sqlQueryForEngine(tx);
    // A late result may arrive after the TTL sweeper marked the hold expired.
    // Settle that paid work too: truthfully recording a late overage is safer
    // than dropping it. WHERE excludes 'settled', preserving idempotency. The
    // log insert is in the same transaction, so accounting failure rolls the
    // state transition back.
    const updated = await sql`
      UPDATE mcp_spend_reservations
         SET status = 'settled',
             actual_cents = ${actualCents},
             settled_at = now()
       WHERE reservation_id = ${reservationId}
         AND status IN ('pending', 'expired')
      RETURNING client_id, model, provider
    `;
    if (updated.length === 0) {
      const existing = await sql`
        SELECT status
          FROM mcp_spend_reservations
         WHERE reservation_id = ${reservationId}
      `;
      if (existing[0]?.status === 'settled') return;
      throw new Error(`spend reservation not found: ${reservationId}`);
    }
    const row = updated[0];
    // Mirror into mcp_spend_log so getTodaySpendCents/reserve sees it.
    await sql`
      INSERT INTO mcp_spend_log
        (client_id, token_name, operation, spend_cents, provider, model)
      VALUES
        (${String(row.client_id)}, ${tokenName}, ${operation}, ${actualCents},
         ${String(row.provider)}, ${String(row.model)})
    `;
  });
}

/**
 * Sweeper called by tests + the worker startup hook. Marks any
 * pending reservation past its TTL as 'expired' with actual_cents=0.
 *
 * Returns the number of rows expired.
 */
export async function sweepExpiredReservations(engine: BrainEngine): Promise<number> {
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`
    UPDATE mcp_spend_reservations
       SET status = 'expired', actual_cents = 0
     WHERE status = 'pending'
       AND expires_at < now()
    RETURNING reservation_id
  `;
  return rows.length;
}

/** Read the per-client cap from oauth_clients.budget_usd_per_day. Returns
 *  `null` when no cap is set (legacy clients pre-v83). */
export async function getClientDailyCapCents(
  engine: BrainEngine,
  clientId: string,
): Promise<number | null> {
  assertNonEmpty('clientId', clientId);
  const sql = sqlQueryForEngine(engine);
  const rows = await sql`
    SELECT budget_usd_per_day::text AS cap
      FROM oauth_clients
     WHERE client_id = ${clientId}
  `;
  if (rows.length === 0) return null;
  const raw = rows[0]?.cap;
  if (raw === null || raw === undefined) return null;
  const usd = Number(raw);
  if (!Number.isFinite(usd) || usd < 0) {
    throw new Error(`invalid budget_usd_per_day for OAuth client ${clientId}`);
  }
  // oauth_clients stores NUMERIC(..., 2) USD, so its public cents view is
  // integral. Round to avoid binary floating-point artifacts (e.g. 0.29).
  return Math.round(usd * 100);
}

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
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

/** Use the lockKey helper in case future callers want it (e.g. integration tests). */
export { clientLockKey };

/** Re-export BudgetExceededError for one-stop import. */
export { BudgetExceededError };
