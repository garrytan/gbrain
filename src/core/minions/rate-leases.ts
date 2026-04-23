/**
 * Lease-based rate limiter for outbound providers (e.g. anthropic:messages).
 *
 * Counter-based limiters leak capacity when a worker crashes mid-call
 * (counter never decrements). Leases are owner-tagged rows with an expires_at
 * timestamp — crash recovery is free: any row past expires_at is considered
 * dead on the next acquire and pruned before the active-count check.
 *
 * Two-phase acquire:
 *   1. Pre-prune: DELETE expired leases for this key (same txn).
 *   2. Check-then-insert under a txn-scoped advisory lock so two concurrent
 *      acquires can't both see "one slot left".
 *
 * The owner is always a Minion job id; the lease is CASCADE-tied to
 * minion_jobs so an out-of-band row DELETE (prune, cancel) doesn't leave
 * stale leases. Mid-call renewal bumps expires_at in-place.
 */

import type { BrainEngine } from '../engine.ts';

/**
 * Acquisition result. If `acquired=false`, the caller should back off and
 * retry — we don't queue, we just reject.
 */
export interface LeaseAcquireResult {
  acquired: boolean;
  /** The lease row id, present only when acquired=true. */
  leaseId?: number;
  /** Active count seen at acquire time (for diagnostics). */
  activeCount: number;
  /** max_concurrent that was checked against. */
  maxConcurrent: number;
}

/**
 * Convert a key string to a stable int64 for pg_advisory_xact_lock. Simple
 * FNV-1a is fine — the lock space is per-transaction and we only need
 * different keys to (usually) hash to different locks.
 */
function hashKey(key: string): bigint {
  // FNV-1a 64-bit
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  for (let i = 0; i < key.length; i++) {
    h ^= BigInt(key.charCodeAt(i));
    h = (h * prime) & 0xffffffffffffffffn;
  }
  // Fit into signed int64 for PG bigint. The high bit gets clipped in the
  // arithmetic above already, but be explicit.
  const signBit = 0x8000000000000000n;
  return h & (signBit - 1n);
}

const DEFAULT_TTL_MS = 120_000;

export interface AcquireOpts {
  ttlMs?: number;
}

/**
 * Attempt to acquire a lease on `key`. Returns `{acquired: false}` when the
 * active count (after pre-pruning stale rows) would exceed maxConcurrent.
 *
 * The call MUST run inside a transaction for the advisory lock + insert to
 * be atomic. Pass in the engine — the helper wraps the txn internally.
 */
export async function acquireLease(
  engine: BrainEngine,
  key: string,
  ownerJobId: number,
  maxConcurrent: number,
  opts: AcquireOpts = {},
): Promise<LeaseAcquireResult> {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  const lockKey = hashKey(key);

  return engine.transaction(async (tx) => {
    // txn-scoped advisory lock keyed on the rate-lease key name. Released
    // automatically when the txn commits/rolls back.
    await tx.executeRaw(`SELECT pg_advisory_xact_lock($1::bigint)`, [lockKey.toString()]);

    // Pre-prune stale leases for this key.
    await tx.executeRaw(
      `DELETE FROM subagent_rate_leases WHERE key = $1 AND expires_at <= now()`,
      [key],
    );

    const countRows = await tx.executeRaw<{ count: string | number }>(
      `SELECT count(*)::text AS count FROM subagent_rate_leases WHERE key = $1`,
      [key],
    );
    const activeCount = parseInt(String(countRows[0]?.count ?? '0'), 10);

    if (activeCount >= maxConcurrent) {
      return { acquired: false, activeCount, maxConcurrent };
    }

    const rows = await tx.executeRaw<{ id: number }>(
      `INSERT INTO subagent_rate_leases (key, owner_job_id, expires_at)
       VALUES ($1, $2, now() + ($3::double precision * interval '1 millisecond'))
       RETURNING id`,
      [key, ownerJobId, ttlMs],
    );
    const leaseId = rows[0]!.id;
    return { acquired: true, leaseId, activeCount: activeCount + 1, maxConcurrent };
  });
}

/**
 * Renew a lease's expires_at (mid-call). Returns true if the lease still
 * exists (was renewed), false if it was pruned (caller must re-acquire or
 * abort).
 */
export async function renewLease(engine: BrainEngine, leaseId: number, ttlMs = DEFAULT_TTL_MS): Promise<boolean> {
  const rows = await engine.executeRaw<{ id: number }>(
    `UPDATE subagent_rate_leases
     SET expires_at = now() + ($2::double precision * interval '1 millisecond')
     WHERE id = $1
     RETURNING id`,
    [leaseId, ttlMs],
  );
  return rows.length > 0;
}

/**
 * Release a lease explicitly. Idempotent — a missing lease returns silently
 * (it was pruned or the owning job row cascade-deleted it).
 */
export async function releaseLease(engine: BrainEngine, leaseId: number): Promise<void> {
  await engine.executeRaw(`DELETE FROM subagent_rate_leases WHERE id = $1`, [leaseId]);
}

/**
 * Attempt to renew with 3x exponential backoff (250ms / 500ms / 1s). Used
 * mid-LLM-call when the first renewal attempt hits a DB blip. On all-three
 * failure the caller must abort with a renewable error so the worker
 * re-claims the job.
 */
export async function renewLeaseWithBackoff(engine: BrainEngine, leaseId: number, ttlMs = DEFAULT_TTL_MS): Promise<boolean> {
  const delays = [0, 250, 500, 1000]; // first attempt immediate, then 250/500/1000
  for (const delay of delays) {
    if (delay > 0) await new Promise(r => setTimeout(r, delay));
    try {
      if (await renewLease(engine, leaseId, ttlMs)) return true;
      // Lease is gone (pruned). No point retrying — caller must abort.
      return false;
    } catch {
      // DB blip; fall through to next delay.
    }
  }
  return false;
}
