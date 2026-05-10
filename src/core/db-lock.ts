/**
 * Generic DB-backed lock primitive.
 *
 * Reuses the gbrain_cycle_locks table (id PK + holder_pid + ttl_expires_at)
 * with a parameterized lock id. Both `gbrain-cycle` (the broad cycle lock)
 * and `gbrain-sync` (performSync's writer lock) live here.
 *
 * Why not pg_advisory_xact_lock: it is session-scoped, and PgBouncer
 * transaction pooling drops session state between calls. This row-based
 * lock survives PgBouncer because it's plain INSERT/UPDATE/DELETE with
 * a TTL fallback (a crashed holder's row times out).
 *
 * Why a separate table-row per lock id rather than reusing the cycle lock:
 * the cycle lock is broader (covers every phase). performSync's write-window
 * is narrower. If performSync reused the cycle lock and the cycle handler
 * called performSync, the inner acquire would deadlock against itself. Two
 * lock ids let callers nest cleanly: cycle holds gbrain-cycle for its run;
 * performSync (called from anywhere — cycle, jobs handler, CLI) takes
 * gbrain-sync just for the write window.
 *
 * v0.22.13 — added in PR #490 to fix CODEX-2 (no cross-process lock for
 * direct sync paths). The cycle path was already protected.
 */
import { hostname } from 'os';
import type { BrainEngine } from './engine.ts';

export interface DbLockHandle {
  id: string;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

/** Default TTL: 30 minutes, same as cycle lock. */
const DEFAULT_TTL_MINUTES = 30;

/**
 * Try to acquire a named DB lock.
 *
 * Returns a handle on success. Returns `null` if another live holder has
 * the lock (its row exists and ttl_expires_at is in the future).
 *
 * The acquire is upsert-style:
 *   INSERT ... ON CONFLICT (id) DO UPDATE
 *     ... WHERE existing.ttl_expires_at < NOW()
 *   RETURNING id
 *
 * Empty RETURNING means the existing row is still live. An expired holder
 * (worker crashed without releasing) is auto-superseded by the UPDATE
 * branch.
 */
export async function tryAcquireDbLock(
  engine: BrainEngine,
  lockId: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<DbLockHandle | null> {
  const pid = process.pid;
  const host = hostname();

  // Engine-agnostic: prefer the engine's raw escape hatch (`sql` for postgres-js,
  // `db.query` for PGLite). Mirrors cycle.ts's pattern so behavior stays identical.
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };

  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const ttl = `${ttlMinutes} minutes`;
    const rows: Array<{ id: string }> = await sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
      VALUES (${lockId}, ${pid}, ${host}, NOW(), NOW() + ${ttl}::interval)
      ON CONFLICT (id) DO UPDATE
        SET holder_pid = ${pid},
            holder_host = ${host},
            acquired_at = NOW(),
            ttl_expires_at = NOW() + ${ttl}::interval
        WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
      RETURNING id
    `;
    if (rows.length === 0) return null;
    return {
      id: lockId,
      refresh: async () => {
        await sql`
          UPDATE gbrain_cycle_locks
            SET ttl_expires_at = NOW() + ${ttl}::interval
          WHERE id = ${lockId} AND holder_pid = ${pid}
        `;
      },
      release: async () => {
        await sql`
          DELETE FROM gbrain_cycle_locks
          WHERE id = ${lockId} AND holder_pid = ${pid}
        `;
      },
    };
  }

  if (engine.kind === 'pglite' && maybePGLite.db) {
    const db = maybePGLite.db;
    const ttl = `${ttlMinutes} minutes`;
    const { rows } = await db.query(
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at)
       VALUES ($1, $2, $3, NOW(), NOW() + $4::interval)
       ON CONFLICT (id) DO UPDATE
         SET holder_pid = $2,
             holder_host = $3,
             acquired_at = NOW(),
             ttl_expires_at = NOW() + $4::interval
         WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
       RETURNING id`,
      [lockId, pid, host, ttl],
    );
    if (rows.length === 0) return null;
    return {
      id: lockId,
      refresh: async () => {
        await db.query(
          `UPDATE gbrain_cycle_locks
              SET ttl_expires_at = NOW() + $1::interval
            WHERE id = $2 AND holder_pid = $3`,
          [ttl, lockId, pid],
        );
      },
      release: async () => {
        await db.query(
          `DELETE FROM gbrain_cycle_locks WHERE id = $1 AND holder_pid = $2`,
          [lockId, pid],
        );
      },
    };
  }

  throw new Error(`Unknown engine kind for db-lock: ${engine.kind}`);
}

/** Lock id for performSync's writer window. Distinct from gbrain-cycle so the
 * cycle handler can hold gbrain-cycle while performSync (called from inside
 * the cycle) acquires gbrain-sync. */
export const SYNC_LOCK_ID = 'gbrain-sync';

/**
 * v0.30.1 (T4 + A4): wrap long-running work in a refreshing TTL lock.
 *
 * Problem: tryAcquireDbLock has a TTL but only stays exclusive if someone
 * calls refresh(). For 30min+ migrations and hour-long HNSW builds, the TTL
 * expires mid-operation and a second worker could enter while the first is
 * still alive (codex finding C5 / T4).
 *
 * Solution: wrap the work in a setInterval refresh that bumps the TTL every
 * (TTL/6) ms while the operation runs. On every refresh tick, ALSO fire a
 * SELECT 1 backend-alive heartbeat (codex A4 / X1 part 3) to prove the
 * lock-holding backend is still responsive — if heartbeat hangs past
 * HEARTBEAT_TIMEOUT_MS, abort the operation and release the lock.
 *
 * Lock-id naming convention: `<scope>:<dbname>` (e.g. `gbrain-migrate:postgres`)
 * for multi-tenant safety per cherry D4. Caller composes the dbname.
 *
 * Failure paths:
 *  - lock unavailable → throws LockUnavailableError (caller decides retry)
 *  - work() throws → release lock cleanly + re-throw original
 *  - heartbeat fails → log + clear interval; lock TTL will auto-expire,
 *    work() continues but next refresh would see the lock invalidated
 */
export class LockUnavailableError extends Error {
  constructor(public readonly lockId: string) {
    super(`Lock '${lockId}' is held by another process and not yet expired`);
    this.name = 'LockUnavailableError';
  }
}

export interface WithRefreshingLockOpts {
  /** TTL in minutes for the lock row. Default 30. */
  ttlMinutes?: number;
  /** Heartbeat-fail threshold in ms — abort if SELECT 1 takes longer. Default 30000. */
  heartbeatTimeoutMs?: number;
}

/**
 * Acquire `lockId`, run `work`, release lock. Auto-refreshes TTL on a
 * setInterval timer; aborts on backend-hang (SELECT 1 heartbeat fails).
 *
 * If acquire fails (existing live holder), throws LockUnavailableError.
 */
export async function withRefreshingLock<T>(
  engine: BrainEngine,
  lockId: string,
  work: () => Promise<T>,
  opts: WithRefreshingLockOpts = {},
): Promise<T> {
  const ttlMinutes = opts.ttlMinutes ?? DEFAULT_TTL_MINUTES;
  const heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? 30000;
  // Refresh 6x per TTL window so a missed tick doesn't expire the lock.
  const refreshIntervalMs = Math.max(15000, (ttlMinutes * 60 * 1000) / 6);

  const handle = await tryAcquireDbLock(engine, lockId, ttlMinutes);
  if (!handle) throw new LockUnavailableError(lockId);

  let healthOk = true;

  const interval = setInterval(() => {
    void (async () => {
      try {
        // A4 heartbeat: SELECT 1 against the engine's connection pool.
        // Honest limit: this checks a connection is responsive in general,
        // not the SPECIFIC backend running `work()`. The full X1 fix
        // (lock-refresh on the work-pinned connection via withReservedConnection)
        // is layered in by callers that pass the work backend's sql in.
        // For migrate.ts (transactional DDL), the engine.transaction() path
        // pins the backend; the heartbeat against engine.sql is a useful
        // proxy for "Postgres is reachable" even if it can race the actual
        // backend's wedge state. Lane B's primary win is the auto-refresh
        // itself; the precise-backend-bind heartbeat is a Lane B follow-up.
        const probe = engineSelectOne(engine);
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('heartbeat_timeout')), heartbeatTimeoutMs)
        );
        await Promise.race([probe, timeout]);
        await handle.refresh();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[lock-refresh] ${lockId}: ${msg}; lock will auto-expire\n`);
        healthOk = false;
        clearInterval(interval);
      }
    })();
  }, refreshIntervalMs);

  try {
    return await work();
  } finally {
    clearInterval(interval);
    try { await handle.release(); } catch { /* idempotent */ }
    if (!healthOk) {
      // Surface that the heartbeat detected backend trouble — caller can
      // log to the connection-events audit if desired.
      process.stderr.write(`[lock-refresh] ${lockId}: completed with degraded heartbeat\n`);
    }
  }
}

/** Internal: SELECT 1 on the engine's connection. */
async function engineSelectOne(engine: BrainEngine): Promise<void> {
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string) => Promise<{ rows: unknown[] }> };
  };
  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    await sql`SELECT 1`;
    return;
  }
  if (engine.kind === 'pglite' && maybePGLite.db) {
    await maybePGLite.db.query('SELECT 1');
    return;
  }
  throw new Error(`Unknown engine kind for heartbeat: ${engine.kind}`);
}

/**
 * Compose a multi-tenant-safe lock id (cherry D4). Suffixes the lock id
 * with the database name so two gbrain installs sharing a Postgres cluster
 * (different databases on the same Supabase project) don't contend.
 *
 * Async: queries `current_database()` on the engine. PGLite returns a
 * stable single-database name.
 */
export async function buildTenantLockId(engine: BrainEngine, scope: string): Promise<string> {
  try {
    if (engine.kind === 'postgres') {
      const rows = await engine.executeRaw<{ db: string }>('SELECT current_database() AS db');
      const dbname = rows[0]?.db || 'unknown';
      return `${scope}:${dbname}`;
    }
    // PGLite is single-tenant by construction; suffix is cosmetic.
    return `${scope}:pglite`;
  } catch {
    return `${scope}:unknown`;
  }
}
