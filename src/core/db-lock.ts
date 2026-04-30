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
