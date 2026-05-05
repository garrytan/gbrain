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
 */
import { hostname } from 'os';
import type { BrainEngine } from './engine.ts';

export interface DbLockHandle {
  id: string;
  release: () => Promise<void>;
  refresh: () => Promise<void>;
}

export interface DbLockInfo {
  id: string;
  holder_pid: number | null;
  holder_host: string | null;
  acquired_at: string | null;
  ttl_expires_at: string | null;
}

/** Default TTL: 30 minutes, same as cycle lock. */
const DEFAULT_TTL_MINUTES = 30;

function rawAccess(engine: BrainEngine) {
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };
  return { maybePG, maybePGLite };
}

/**
 * Try to acquire a named DB lock.
 *
 * Returns a handle on success. Returns `null` if another live holder has
 * the lock (its row exists and ttl_expires_at is in the future).
 */
export async function tryAcquireDbLock(
  engine: BrainEngine,
  lockId: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<DbLockHandle | null> {
  const pid = process.pid;
  const host = hostname();
  const { maybePG, maybePGLite } = rawAccess(engine);

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

function isPidAlive(pid: number | null | undefined): boolean {
  if (!pid || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export async function getDbLockInfo(engine: BrainEngine, lockId: string): Promise<DbLockInfo | null> {
  const { maybePG, maybePGLite } = rawAccess(engine);
  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const rows = await sql`
      SELECT id, holder_pid, holder_host, acquired_at::text, ttl_expires_at::text
      FROM gbrain_cycle_locks WHERE id = ${lockId} LIMIT 1
    ` as DbLockInfo[];
    return rows[0] ?? null;
  }
  if (engine.kind === 'pglite' && maybePGLite.db) {
    const { rows } = await maybePGLite.db.query(
      `SELECT id, holder_pid, holder_host, acquired_at::text, ttl_expires_at::text
       FROM gbrain_cycle_locks WHERE id = $1 LIMIT 1`,
      [lockId],
    );
    return (rows[0] as DbLockInfo | undefined) ?? null;
  }
  return null;
}

async function clearDbLock(engine: BrainEngine, lockId: string): Promise<void> {
  const { maybePG, maybePGLite } = rawAccess(engine);
  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    await sql`DELETE FROM gbrain_cycle_locks WHERE id = ${lockId}`;
    return;
  }
  if (engine.kind === 'pglite' && maybePGLite.db) {
    await maybePGLite.db.query(`DELETE FROM gbrain_cycle_locks WHERE id = $1`, [lockId]);
  }
}

/**
 * Acquire a lock, auto-clearing the common interrupted-agent case: same-host
 * lock row whose holder PID is no longer alive. Returns lock info on failure
 * so callers can print actionable diagnostics.
 */
export async function acquireDbLockOrInfo(
  engine: BrainEngine,
  lockId: string,
  ttlMinutes: number = DEFAULT_TTL_MINUTES,
): Promise<{ handle: DbLockHandle; clearedStale?: DbLockInfo } | { handle: null; info: DbLockInfo | null }> {
  const first = await tryAcquireDbLock(engine, lockId, ttlMinutes);
  if (first) return { handle: first };

  const info = await getDbLockInfo(engine, lockId);
  const sameHost = info?.holder_host === hostname();
  if (sameHost && !isPidAlive(info?.holder_pid)) {
    await clearDbLock(engine, lockId);
    const second = await tryAcquireDbLock(engine, lockId, ttlMinutes);
    if (second) return { handle: second, clearedStale: info ?? undefined };
  }
  return { handle: null, info };
}

/** Lock id for performSync's writer window. Distinct from gbrain-cycle so the
 * cycle handler can hold gbrain-cycle while performSync (called from inside
 * the cycle) acquires gbrain-sync. */
export const SYNC_LOCK_ID = 'gbrain-sync';
