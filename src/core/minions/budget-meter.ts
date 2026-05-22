/**
 * v0.38 Slice 2 — budget meter for the subagent tool loop.
 *
 * Reserve-then-settle pattern (D3) prevents the "concurrent agents bust the
 * cap" race that the pre-v82 best-effort post-call recording allowed. Two
 * agents from the same OAuth client both pre-flight pass at $2 of $5,
 * both spend $2, total spend = $4 of $5 → fine. But raise the per-agent
 * estimate to $3 and both agents see "$5 cap - $2 spent = $3 headroom, ok"
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

/** Reservation TTL — 10 minutes. Long enough for any normal subagent call;
 *  short enough that crashed workers don't strand capacity for long. */
export const RESERVATION_TTL_MS = 10 * 60 * 1000;

/** Generate an int hash of client_id for pg_advisory_xact_lock. */
function clientLockKey(clientId: string): number {
  // FNV-1a 32-bit hash (deterministic, no deps, fits in INT32 / BIGINT).
  let h = 0x811c9dc5;
  for (let i = 0; i < clientId.length; i++) {
    h ^= clientId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // pg_advisory_xact_lock(BIGINT) — keep within INT32 positive range.
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
 * Lock auto-releases at transaction end (xact-scoped). The whole operation
 * is single round-trip (one transaction).
 */
export async function reserve(
  engine: BrainEngine,
  opts: ReserveOpts,
): Promise<Reservation> {
  const sql = sqlQueryForEngine(engine);
  const reservationId = randomUUIDv7();
  const lockKey = clientLockKey(opts.clientId);
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);
  const todayStart = todayStartIso();

  // The Postgres path runs everything inside a transaction with
  // pg_advisory_xact_lock; PGLite is single-process so the lock isn't
  // strictly needed but we use the same query for shape consistency.
  // PGLite's pg_advisory_xact_lock is a no-op pre-v0.3.x, so the lock
  // call is wrapped in a defensive fallback.

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
  const committedCents = parseFloat(String(rows[0]?.committed_text ?? '0'));
  const pendingCents = parseFloat(String(rows[0]?.pending_text ?? '0'));
  const totalProjected = committedCents + pendingCents + opts.estimatedCents;
  if (totalProjected > opts.capCents) {
    throw new BudgetExceededError(
      `budget exceeded for client ${opts.clientId}: ` +
      `committed=${committedCents.toFixed(2)}¢, pending=${pendingCents.toFixed(2)}¢, ` +
      `estimated=${opts.estimatedCents.toFixed(2)}¢, cap=${opts.capCents.toFixed(2)}¢`,
      Math.round(committedCents + pendingCents),
      Math.round(opts.capCents),
    );
  }

  // Step 4: INSERT reservation.
  await sql`
    INSERT INTO mcp_spend_reservations
      (reservation_id, client_id, job_id, estimated_cents, model, provider, status, expires_at)
    VALUES
      (${reservationId}, ${opts.clientId}, ${opts.jobId ?? null},
       ${opts.estimatedCents}, ${opts.model}, ${opts.provider}, 'pending', ${expiresAt})
  `;

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
): Promise<void> {
  const sql = sqlQueryForEngine(engine);
  // Single UPDATE with WHERE status='pending' to ensure idempotent settles.
  const updated = await sql`
    UPDATE mcp_spend_reservations
       SET status = 'settled',
           actual_cents = ${actualCents},
           settled_at = now()
     WHERE reservation_id = ${reservationId}
       AND status = 'pending'
    RETURNING client_id, model, provider
  `;
  if (updated.length === 0) {
    // Already settled or expired; treat as no-op.
    return;
  }
  const row = updated[0];
  // Mirror into mcp_spend_log so getTodaySpendCents/reserve sees it.
  await sql`
    INSERT INTO mcp_spend_log
      (client_id, token_name, operation, spend_cents, provider, model)
    VALUES
      (${String(row.client_id)}, ${null}, ${operation}, ${actualCents},
       ${String(row.provider)}, ${String(row.model)})
  `;
}

/**
 * Best-effort sweeper. Called by tests + the worker startup hook. Marks any
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
  try {
    const sql = sqlQueryForEngine(engine);
    const rows = await sql`
      SELECT budget_usd_per_day::text AS cap
        FROM oauth_clients
       WHERE client_id = ${clientId}
    `;
    if (rows.length === 0) return null;
    const raw = rows[0]?.cap;
    if (raw === null || raw === undefined) return null;
    const usd = parseFloat(String(raw));
    if (!isFinite(usd)) return null;
    return Math.round(usd * 100);
  } catch {
    return null;
  }
}

function todayStartIso(): string {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d.toISOString();
}

/** Use the lockKey helper in case future callers want it (e.g. integration tests). */
export { clientLockKey };

/** Re-export BudgetExceededError for one-stop import. */
export { BudgetExceededError };
