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
 * v0.42 (#1780 Gap 3): grace window before a same-host dead-pid lock is
 * eligible for automatic takeover. Matches `runBreakLock`'s `age >= 60_000`
 * gate so the two paths agree. Defends against PID reuse: the OS can recycle
 * a crashed holder's PID, so we refuse takeover until the lock is older than
 * this window.
 */
export const HOLDER_TAKEOVER_GRACE_MS = 60_000;

/**
 * v0.42.x (#1794): heartbeat-aware steal grace. A holder whose
 * `last_refreshed_at` is within this window is treated as ALIVE and is NOT
 * stolen even if its `ttl_expires_at` has lapsed — defending a live, actively
 * refreshing holder whose refresh tick was briefly starved (the #1794 thrash,
 * where a CPU-bound import let the TTL expire and a competing launch stole the
 * live lock). A genuinely dead holder stops refreshing, ages past the grace,
 * and becomes stealable again (TTL stays the ultimate backstop). Derived from
 * the TTL so it scales with the refresh cadence; override with
 * GBRAIN_LOCK_STEAL_GRACE_SECONDS.
 */
export const DEFAULT_STEAL_GRACE_SECONDS = 600;

export function resolveStealGraceSeconds(ttlMinutes: number): number {
  const raw = process.env.GBRAIN_LOCK_STEAL_GRACE_SECONDS;
  if (raw) {
    const n = Number(raw);
    if (Number.isInteger(n) && n > 0) return n;
  }
  // Refresh fires ~ttl/6; protect a holder that refreshed within ~2 ticks.
  const refreshSec = Math.max(15, (ttlMinutes * 60) / 6);
  return Math.max(Math.floor(refreshSec * 2), 60);
}

/**
 * Liveness classification of a lock holder, from the perspective of the
 * current host. Shared by `isHolderDeadLocally` (auto-takeover in
 * `tryAcquireDbLock`) and `gbrain sync --break-lock`'s safe path so the two
 * never drift.
 *
 *   - `cross_host`     — holder is on a different host; `process.kill` is
 *                        meaningless remotely, never take over.
 *   - `alive`          — the PID exists (probe succeeded) OR the probe got
 *                        EPERM (the PID exists but isn't ours). EPERM-as-ALIVE
 *                        is load-bearing: stealing a live lock is the worst case.
 *   - `too_young`      — PID is provably dead (ESRCH) but the lock is younger
 *                        than the grace window (possible PID reuse).
 *   - `dead_eligible`  — PID is provably dead AND the lock is old enough.
 *   - `unknown`        — the probe threw something other than ESRCH/EPERM;
 *                        conservative, treat as NOT eligible.
 */
export type HolderLiveness = 'cross_host' | 'alive' | 'too_young' | 'dead_eligible' | 'unknown';

export interface HolderLivenessOpts {
  /** Grace window in ms (default HOLDER_TAKEOVER_GRACE_MS). */
  graceMs?: number;
  /** Override the local hostname (test seam; default `os.hostname()`). */
  localHost?: string;
  /** Override the liveness probe (test seam; default `process.kill`). */
  processKill?: (pid: number, signal: number) => void;
}

export function classifyHolderLiveness(
  holderPid: number,
  holderHost: string,
  ageMs: number,
  opts: HolderLivenessOpts = {},
): HolderLiveness {
  const localHost = opts.localHost ?? hostname();
  if (holderHost !== localHost) return 'cross_host';

  const probe = opts.processKill ?? ((p: number, s: number) => process.kill(p, s));
  let probeResult: 'alive' | 'dead' | 'eperm' | 'unknown';
  try {
    probe(holderPid, 0);
    probeResult = 'alive';
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code;
    probeResult = code === 'ESRCH' ? 'dead' : code === 'EPERM' ? 'eperm' : 'unknown';
  }

  // EPERM → the PID exists but isn't ours: treat as ALIVE, never steal.
  if (probeResult === 'alive' || probeResult === 'eperm') return 'alive';
  if (probeResult === 'unknown') return 'unknown';

  // Provably dead (ESRCH). Gate on the grace window to defend against PID reuse.
  const grace = opts.graceMs ?? HOLDER_TAKEOVER_GRACE_MS;
  return ageMs < grace ? 'too_young' : 'dead_eligible';
}

/** Convenience boolean: is the holder provably dead, same-host, and past the grace window? */
export function isHolderDeadLocally(
  holderPid: number,
  holderHost: string,
  ageMs: number,
  opts: HolderLivenessOpts = {},
): boolean {
  return classifyHolderLiveness(holderPid, holderHost, ageMs, opts) === 'dead_eligible';
}

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
  // v0.42.x (#1794): a holder that refreshed within this window is protected
  // from the ON CONFLICT steal even if its TTL lapsed (starved-but-alive).
  const stealGraceSeconds = resolveStealGraceSeconds(ttlMinutes);

  // Engine-agnostic: prefer the engine's raw escape hatch (`sql` for postgres-js,
  // `db.query` for PGLite). Mirrors cycle.ts's pattern so behavior stays identical.
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };

  // v0.41.6.0 D5: auto-register cleanup so abnormal termination (SIGTERM/
  // SIGHUP/SIGPIPE/uncaughtException/EPIPE-on-stdout) releases the lock.
  // The returned handle's release() deregisters before deleting — atomic
  // in single-threaded JS so no double-DELETE on normal exit path.
  // withRefreshingLock just calls tryAcquireDbLock and gets the same
  // registration for free (single ownership site per outside-voice F11).
  const { registerCleanup } = await import('./process-cleanup.ts');

  const acquireOnce = async (): Promise<DbLockHandle | null> => {
  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const ttl = `${ttlMinutes} minutes`;
    // v0.41.13.0 (D-V3-4 / migration v98): write last_refreshed_at on INSERT
    // AND on takeover. last_refreshed_at = acquired_at on initial INSERT;
    // every refresh() tick bumps both ttl_expires_at AND last_refreshed_at.
    // `gbrain sync --break-lock --max-age <s>` uses last_refreshed_at (not
    // acquired_at) to identify wedged-but-alive holders without stealing
    // healthy long-running holders that are actively refreshing.
    const rows: Array<{ id: string }> = await sql`
      INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
      VALUES (${lockId}, ${pid}, ${host}, NOW(), NOW() + ${ttl}::interval, NOW())
      ON CONFLICT (id) DO UPDATE
        SET holder_pid = ${pid},
            holder_host = ${host},
            acquired_at = NOW(),
            ttl_expires_at = NOW() + ${ttl}::interval,
            last_refreshed_at = NOW()
        WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
          AND (gbrain_cycle_locks.last_refreshed_at IS NULL
               OR gbrain_cycle_locks.last_refreshed_at < NOW() - ${stealGraceSeconds} * INTERVAL '1 second')
      RETURNING id
    `;
    if (rows.length === 0) return null;
    const deregister = registerCleanup(`db-lock:${lockId}`, async () => {
      await sql`
        DELETE FROM gbrain_cycle_locks
        WHERE id = ${lockId} AND holder_pid = ${pid}
      `;
    });
    return {
      id: lockId,
      refresh: async () => {
        // v0.41.13.0: bump BOTH ttl_expires_at AND last_refreshed_at.
        // v0.42.x (#1794): route through the DIRECT session pool, not the
        // transaction pool, so a Supavisor pooler exhaustion (EMAXCONNSESSION)
        // can't kill the heartbeat and let the live lock get stolen.
        await engine.executeRawDirect(
          `UPDATE gbrain_cycle_locks
              SET ttl_expires_at = NOW() + ($1)::interval,
                  last_refreshed_at = NOW()
            WHERE id = $2 AND holder_pid = $3`,
          [ttl, lockId, pid],
        );
      },
      release: async () => {
        deregister();
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
      `INSERT INTO gbrain_cycle_locks (id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at)
       VALUES ($1, $2, $3, NOW(), NOW() + $4::interval, NOW())
       ON CONFLICT (id) DO UPDATE
         SET holder_pid = $2,
             holder_host = $3,
             acquired_at = NOW(),
             ttl_expires_at = NOW() + $4::interval,
             last_refreshed_at = NOW()
         WHERE gbrain_cycle_locks.ttl_expires_at < NOW()
           AND (gbrain_cycle_locks.last_refreshed_at IS NULL
                OR gbrain_cycle_locks.last_refreshed_at < NOW() - $5 * INTERVAL '1 second')
       RETURNING id`,
      [lockId, pid, host, ttl, stealGraceSeconds],
    );
    if (rows.length === 0) return null;
    const deregister = registerCleanup(`db-lock:${lockId}`, async () => {
      await db.query(
        `DELETE FROM gbrain_cycle_locks WHERE id = $1 AND holder_pid = $2`,
        [lockId, pid],
      );
    });
    return {
      id: lockId,
      refresh: async () => {
        await db.query(
          `UPDATE gbrain_cycle_locks
              SET ttl_expires_at = NOW() + $1::interval,
                  last_refreshed_at = NOW()
            WHERE id = $2 AND holder_pid = $3`,
          [ttl, lockId, pid],
        );
      },
      release: async () => {
        deregister();
        await db.query(
          `DELETE FROM gbrain_cycle_locks WHERE id = $1 AND holder_pid = $2`,
          [lockId, pid],
        );
      },
    };
  }

  throw new Error(`Unknown engine kind for db-lock: ${engine.kind}`);
  };

  const first = await acquireOnce();
  if (first) return first;

  // v0.42 (#1780 Gap 3): the lock is held and its TTL hasn't expired (the
  // upsert's ON CONFLICT ... WHERE ttl_expires_at < NOW() returned no row).
  // If the holder is on THIS host, provably dead, and past the grace window,
  // reclaim it: guarded DELETE then retry the normal upsert ONCE. The retry
  // returns the normal DbLockHandle (refresh/release intact) — no hand-rolled
  // handle. TTL-expired holders are NOT handled here (the upsert already takes
  // them); cross-host holders stay TTL-only. Best-effort: any error falls
  // through to `return null` (busy), exactly as the pre-takeover behavior.
  try {
    const snap = await inspectLock(engine, lockId);
    if (snap && !snap.ttl_expired && isHolderDeadLocally(snap.holder_pid, snap.holder_host, snap.age_ms)) {
      const { deleted } = await deleteLockRow(engine, lockId, snap.holder_pid);
      if (deleted) {
        const second = await acquireOnce();
        if (second) return second;
      }
    }
  } catch {
    // Auto-takeover is best-effort; never throw from the acquire path.
  }
  return null;
}

/**
 * v0.41.6.0 D3: inspect the current holder of a named lock.
 *
 * Returns a snapshot of the lock row + computed age, or null when no row
 * exists for `lockId`. Used by:
 *   - performSync's lock-busy error path to surface holder PID + hostname
 *     + age in the user-facing "Another sync is in progress" message.
 *   - gbrain doctor's `stale_locks` check (queries all rows where
 *     ttl_expires_at < NOW()).
 *   - gbrain sync --break-lock to verify holder state before clearing.
 *
 * Pure read; no side effects, no lock acquire.
 */
export interface LockSnapshot {
  id: string;
  holder_pid: number;
  holder_host: string;
  acquired_at: Date;
  ttl_expires_at: Date;
  age_ms: number;
  /** TTL has already expired — lock is structurally available for next acquire. */
  ttl_expired: boolean;
  /**
   * v0.41.13.0 (D-V3-4 / migration v98): timestamp of the most recent
   * refresh() tick (or NULL on pre-v98 brains where the column was just
   * added but no acquire has happened since). For lock holders using
   * withRefreshingLock, this is the heartbeat signal: a healthy holder
   * has last_refreshed_at within the refresh interval (~5 min for default
   * 30-min TTL). A wedged-but-alive holder (JS interval stopped firing)
   * has stale last_refreshed_at.
   */
  last_refreshed_at: Date | null;
  /** ms since the most recent refresh, or null when last_refreshed_at is null. */
  ms_since_last_refresh: number | null;
}

/**
 * Raw row shape returned by every `gbrain_cycle_locks` SELECT. Lives here so
 * `selectLockRows` (the single canonical reader) and its mapper share one type.
 */
interface RawLockRow {
  id?: string;
  holder_pid?: number;
  holder_host?: string;
  acquired_at?: Date | string;
  ttl_expires_at?: Date | string;
  last_refreshed_at?: Date | string | null;
}

/** Canonical column list for every lock SELECT — keep in lockstep with `RawLockRow`. */
const LOCK_SELECT_COLS = 'id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at';

/**
 * Row → `LockSnapshot` mapper. Coerces postgres.js Date|string columns to Date
 * and computes the derived fields (age_ms, ttl_expired, ms_since_last_refresh).
 * Returns null for a structurally-incomplete row (missing pid / acquired_at /
 * ttl). v0.41.13.0: last_refreshed_at may be NULL on pre-v98 brains.
 */
function rowToLockSnapshot(row: RawLockRow, now: number): LockSnapshot | null {
  if (row.holder_pid === undefined || !row.acquired_at || !row.ttl_expires_at) return null;
  const acquired = row.acquired_at instanceof Date ? row.acquired_at : new Date(row.acquired_at);
  const ttlExpires = row.ttl_expires_at instanceof Date ? row.ttl_expires_at : new Date(row.ttl_expires_at);
  const lastRefreshed = row.last_refreshed_at == null
    ? null
    : (row.last_refreshed_at instanceof Date ? row.last_refreshed_at : new Date(row.last_refreshed_at));
  return {
    id: String(row.id ?? ''),
    holder_pid: Number(row.holder_pid),
    holder_host: String(row.holder_host ?? ''),
    acquired_at: acquired,
    ttl_expires_at: ttlExpires,
    age_ms: now - acquired.getTime(),
    ttl_expired: ttlExpires.getTime() < now,
    last_refreshed_at: lastRefreshed,
    ms_since_last_refresh: lastRefreshed ? now - lastRefreshed.getTime() : null,
  };
}

interface SelectLockRowsOpts {
  /** Return only the row for this exact lock id (the `inspectLock` case). */
  lockId?: string;
  /** Return only rows whose ttl_expires_at < NOW() (the `listStaleLocks` case). */
  staleOnly?: boolean;
}

/**
 * The single canonical reader for `gbrain_cycle_locks`. Engine-branches once
 * (postgres / pglite) so `inspectLock`, `listStaleLocks`, and the reaper don't
 * each re-roll the SELECT + Date-coercion (previously triplicated). Returns
 * fully-mapped `LockSnapshot[]`; callers filter in JS (the table holds 0-2 rows
 * in practice, so a no-WHERE full read is cheap and keeps the SQL trivial).
 */
async function selectLockRows(engine: BrainEngine, opts: SelectLockRowsOpts = {}): Promise<LockSnapshot[]> {
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };

  let rows: RawLockRow[];
  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    if (opts.lockId !== undefined) {
      rows = await sql`SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at FROM gbrain_cycle_locks WHERE id = ${opts.lockId}`;
    } else if (opts.staleOnly) {
      rows = await sql`SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at FROM gbrain_cycle_locks WHERE ttl_expires_at < NOW() ORDER BY acquired_at`;
    } else {
      rows = await sql`SELECT id, holder_pid, holder_host, acquired_at, ttl_expires_at, last_refreshed_at FROM gbrain_cycle_locks ORDER BY acquired_at`;
    }
  } else if (engine.kind === 'pglite' && maybePGLite.db) {
    if (opts.lockId !== undefined) {
      rows = (await maybePGLite.db.query(`SELECT ${LOCK_SELECT_COLS} FROM gbrain_cycle_locks WHERE id = $1`, [opts.lockId])).rows as RawLockRow[];
    } else if (opts.staleOnly) {
      rows = (await maybePGLite.db.query(`SELECT ${LOCK_SELECT_COLS} FROM gbrain_cycle_locks WHERE ttl_expires_at < NOW() ORDER BY acquired_at`)).rows as RawLockRow[];
    } else {
      rows = (await maybePGLite.db.query(`SELECT ${LOCK_SELECT_COLS} FROM gbrain_cycle_locks ORDER BY acquired_at`)).rows as RawLockRow[];
    }
  } else {
    throw new Error(`Unknown engine kind for selectLockRows: ${engine.kind}`);
  }

  const now = Date.now();
  return rows
    .map((r) => rowToLockSnapshot(r, now))
    .filter((s): s is LockSnapshot => s !== null);
}

export async function inspectLock(engine: BrainEngine, lockId: string): Promise<LockSnapshot | null> {
  const rows = await selectLockRows(engine, { lockId });
  return rows[0] ?? null;
}

/**
 * v0.41.6.0 D3: list every lock whose TTL has expired. Used by gbrain
 * doctor's `stale_locks` check. The query reuses the same canonical
 * staleness signal (ttl_expires_at < NOW()) that tryAcquireDbLock's
 * UPDATE-on-conflict already trusts — no parallel heuristic.
 */
export async function listStaleLocks(engine: BrainEngine): Promise<LockSnapshot[]> {
  return selectLockRows(engine, { staleOnly: true });
}

/**
 * v0.41.6.0 D3: atomic verify-and-delete for `gbrain sync --break-lock`.
 *
 * Runs `DELETE ... WHERE id = $1 AND holder_pid = $2 RETURNING id`.
 * RETURNING shape:
 *   - row returned  → we cleared the lock atomically.
 *   - empty array   → row was already cleared by another process (idempotent;
 *                     caller proceeds to acquire normally).
 *
 * Single round-trip; no TOCTOU window between liveness check and DELETE.
 * The caller is responsible for the liveness check (PID-dead OR TTL-expired
 * for safe mode; skipped entirely for --force-break-lock).
 */
export async function deleteLockRow(
  engine: BrainEngine,
  lockId: string,
  holderPid: number,
): Promise<{ deleted: boolean }> {
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };

  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const rows: Array<{ id: string }> = await sql`
      DELETE FROM gbrain_cycle_locks
       WHERE id = ${lockId} AND holder_pid = ${holderPid}
      RETURNING id
    `;
    return { deleted: rows.length > 0 };
  }
  if (engine.kind === 'pglite' && maybePGLite.db) {
    const { rows } = await maybePGLite.db.query(
      `DELETE FROM gbrain_cycle_locks
        WHERE id = $1 AND holder_pid = $2
       RETURNING id`,
      [lockId, holderPid],
    );
    return { deleted: rows.length > 0 };
  }
  throw new Error(`Unknown engine kind for deleteLockRow: ${engine.kind}`);
}

/**
 * v0.41.13.0 (D-V3-4 + D-V4-mech-4 + D-V4-mech-5) — atomic age-gated
 * verify-and-delete for `gbrain sync --break-lock --max-age <seconds>`.
 *
 * Runs:
 *   DELETE FROM gbrain_cycle_locks
 *    WHERE id = $1
 *      AND holder_pid = $2
 *      AND last_refreshed_at < NOW() - $3 * INTERVAL '1 second'
 *   RETURNING id, last_refreshed_at
 *
 * Three matching conditions in one SQL statement (no TOCTOU window):
 *   - id matches the per-source lock key
 *   - holder_pid matches the inspected snapshot (defeats PID-reuse races)
 *   - last_refreshed_at is older than maxAgeSeconds ago — the "wedged but
 *     alive" signal. A healthy holder using withRefreshingLock refreshes
 *     every (ttl/6) ms (~5 min for default 30-min TTL), so
 *     last_refreshed_at is always recent. Only holders whose JS interval
 *     stopped firing (Postgres query timeout, event-loop wedge, etc.)
 *     show a stale value.
 *
 * Why $3 * INTERVAL '1 second' instead of $3::interval: Postgres does NOT
 * cast a bare integer to interval via ::interval (that's a string-only
 * cast). The multiplicative form is the canonical idiom and works on both
 * Postgres + PGLite.
 *
 * Why RETURNING last_refreshed_at: callers print the actual stale age in
 * the per-source verdict so the operator can see "broke lock for source-X
 * (last refresh was 47 min ago)." If we only RETURN id, the caller can't
 * distinguish "broke" from "no-op" without a follow-up query, and we lose
 * the auditable stale-age signal that motivated the break.
 *
 * Returns:
 *   { deleted: true,  lastRefreshedAt: Date } — broke the lock; reports the actual age.
 *   { deleted: false, lastRefreshedAt: null } — refused (lock not stale enough,
 *                                                or holder_pid mismatched,
 *                                                or row absent).
 */
export async function deleteLockRowIfStale(
  engine: BrainEngine,
  lockId: string,
  holderPid: number,
  maxAgeSeconds: number,
): Promise<{ deleted: boolean; lastRefreshedAt: Date | null }> {
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };

  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const rows: Array<{ id: string; last_refreshed_at: Date | string | null }> = await sql`
      DELETE FROM gbrain_cycle_locks
       WHERE id = ${lockId}
         AND holder_pid = ${holderPid}
         AND last_refreshed_at IS NOT NULL
         AND last_refreshed_at < NOW() - ${maxAgeSeconds} * INTERVAL '1 second'
      RETURNING id, last_refreshed_at
    `;
    if (rows.length === 0) return { deleted: false, lastRefreshedAt: null };
    const lr = rows[0].last_refreshed_at;
    const lastRefreshed = lr == null ? null : (lr instanceof Date ? lr : new Date(lr));
    return { deleted: true, lastRefreshedAt: lastRefreshed };
  }
  if (engine.kind === 'pglite' && maybePGLite.db) {
    const { rows } = await maybePGLite.db.query(
      `DELETE FROM gbrain_cycle_locks
        WHERE id = $1
          AND holder_pid = $2
          AND last_refreshed_at IS NOT NULL
          AND last_refreshed_at < NOW() - $3 * INTERVAL '1 second'
       RETURNING id, last_refreshed_at`,
      [lockId, holderPid, maxAgeSeconds],
    );
    if (rows.length === 0) return { deleted: false, lastRefreshedAt: null };
    const r = rows[0] as { id: string; last_refreshed_at: Date | string | null };
    const lr = r.last_refreshed_at;
    const lastRefreshed = lr == null ? null : (lr instanceof Date ? lr : new Date(lr));
    return { deleted: true, lastRefreshedAt: lastRefreshed };
  }
  throw new Error(`Unknown engine kind for deleteLockRowIfStale: ${engine.kind}`);
}

/**
 * #1972 — snapshot-matched verify-and-delete for the background reaper.
 *
 * Unlike `deleteLockRow` (id + holder_pid only), this ALSO pins the observed
 * `acquired_at`, closing the TOCTOU window the reaper opens by reading rows
 * before deleting them: between the SELECT and the DELETE, the dead holder's
 * row could be replaced by a NEW holder that reused the same numeric PID
 * (PID-space wraps). That new row carries a newer `acquired_at`, so the match
 * fails and the DELETE is a safe no-op.
 *
 * Why `date_trunc('milliseconds', acquired_at) = $3` and not bare equality:
 * postgres.js parses timestamptz into a JS Date (millisecond precision), so the
 * snapshot we hold has already lost the microseconds that `acquired_at DEFAULT
 * NOW()` writes. A bare `acquired_at = $3` would therefore NEVER match in
 * production (microsecond stored value ≠ ms-truncated param) — the reaper would
 * silently delete nothing. Truncating both sides to ms makes the comparison
 * round-trip-safe on Postgres + PGLite, while a real takeover (seconds later)
 * still differs by far more than a millisecond.
 */
export async function deleteLockRowExact(
  engine: BrainEngine,
  lockId: string,
  holderPid: number,
  acquiredAt: Date,
): Promise<{ deleted: boolean }> {
  const maybePG = engine as unknown as { sql?: (...args: unknown[]) => Promise<unknown> };
  const maybePGLite = engine as unknown as {
    db?: { query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[] }> };
  };

  if (engine.kind === 'postgres' && maybePG.sql) {
    const sql = maybePG.sql as any;
    const rows: Array<{ id: string }> = await sql`
      DELETE FROM gbrain_cycle_locks
       WHERE id = ${lockId}
         AND holder_pid = ${holderPid}
         AND date_trunc('milliseconds', acquired_at) = ${acquiredAt}
      RETURNING id
    `;
    return { deleted: rows.length > 0 };
  }
  if (engine.kind === 'pglite' && maybePGLite.db) {
    const { rows } = await maybePGLite.db.query(
      `DELETE FROM gbrain_cycle_locks
        WHERE id = $1
          AND holder_pid = $2
          AND date_trunc('milliseconds', acquired_at) = $3
       RETURNING id`,
      [lockId, holderPid, acquiredAt],
    );
    return { deleted: rows.length > 0 };
  }
  throw new Error(`Unknown engine kind for deleteLockRowExact: ${engine.kind}`);
}

/**
 * #1972 — host-scoped reaper for dead-holder locks. Closes the gap where a sync
 * (or cycle) that crashed (OOM, recycle, SIGKILL) strands its lock row until
 * something contends for it — a low-traffic source could look "syncing" for
 * hours. `tryAcquireDbLock` only reclaims on contention; this is the background
 * sweep. Intended to run at cycle start (and under `gbrain doctor --fix` for
 * no-autopilot brains).
 *
 * Scoped to the `gbrain-sync:*` and `gbrain-cycle`/`gbrain-cycle:*` namespaces
 * ONLY. `gbrain_cycle_locks` is shared by enrich, the minion supervisor,
 * reindex, schema-pack, and elections (`tryWithDbElection`) — a blanket sweep
 * would change their TTL-failover timing. Those keep their existing
 * on-contention + TTL behavior.
 *
 *   reapDeadHolderLocks (host-scoped, sync/cycle namespaces only)
 *     selectLockRows → for each row:
 *     ├─ id not in sync/cycle namespace ───────→ KEEP (blast-radius scope)
 *     ├─ holder_host != thisHost ──────────────→ KEEP (cross_host; can't probe)
 *     ├─ kill(pid,0) == alive / EPERM ─────────→ KEEP (live or not-ours)
 *     ├─ ESRCH && age < 60s grace ─────────────→ KEEP (PID-reuse defense)
 *     └─ ESRCH && age ≥ 60s grace ─────────────→ deleteLockRowExact(id, pid, acquired_at)
 *                                                  (snapshot-matched: reused-PID
 *                                                   fresh row has newer acquired_at → no-op)
 */
function isReapableNamespace(lockId: string): boolean {
  return (
    lockId === 'gbrain-cycle' ||
    lockId.startsWith('gbrain-cycle:') ||
    lockId.startsWith('gbrain-sync:')
  );
}

export async function reapDeadHolderLocks(
  engine: BrainEngine,
  opts: HolderLivenessOpts = {},
): Promise<{ reaped: number; reapedIds: string[] }> {
  const rows = await selectLockRows(engine);
  const reapedIds: string[] = [];
  for (const s of rows) {
    if (!isReapableNamespace(s.id)) continue;
    // isHolderDeadLocally combines same-host + ESRCH + the 60s reuse grace,
    // so pure-PID-liveness (which PID-space wrap defeats) is never used alone.
    if (!isHolderDeadLocally(s.holder_pid, s.holder_host, s.age_ms, opts)) continue;
    const { deleted } = await deleteLockRowExact(engine, s.id, s.holder_pid, s.acquired_at);
    if (deleted) reapedIds.push(s.id);
  }
  return { reaped: reapedIds.length, reapedIds };
}

/**
 * v0.40 (Federated Sync v2): per-source sync lock helper.
 *
 * Before v0.40: SYNC_LOCK_ID was a bare 'gbrain-sync' constant, taken by
 * performSync's writer window. That meant only ONE sync could run at a time
 * across the whole brain — even when two sources are completely independent
 * (different git repos, different last_commit, different DB row anchors).
 *
 * v0.40 namespaces the lock key by sourceId so cross-source sync runs in
 * parallel. The cycle's broader `gbrain-cycle` lock still serializes inside
 * a single cycle invocation. Two-source layered semantics:
 *
 *   cycle              acquires `gbrain-cycle`
 *     → performSync(A) acquires `gbrain-sync:A`
 *     → performSync(B) acquires `gbrain-sync:B`  (in a different process, fine)
 *
 * Audit: `SYNC_LOCK_ID` (back-compat alias) resolves to `syncLockId('default')`.
 * Every consumer in src/ MUST namespace by source. Tracked consumers:
 *   - src/commands/sync.ts:performSync (per-source)
 *   - src/core/cycle/phantom-redirect.ts (per-source, D16)
 */
export function syncLockId(sourceId: string): string {
  return `gbrain-sync:${sourceId}`;
}

/**
 * Back-compat alias. Resolves to `syncLockId('default')`. New code should call
 * `syncLockId(sourceId)` directly.
 */
export const SYNC_LOCK_ID = syncLockId('default');

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
        // v0.42.x (#1794, V1): the refresh IS the heartbeat. handle.refresh()
        // routes through the DIRECT session pool (postgres), so it survives a
        // transaction-pool exhaustion (EMAXCONNSESSION) that would otherwise
        // kill renewal and let the live lock be stolen. The pre-v0.42 code first
        // probed `SELECT 1` on the READ pool and clearInterval'd on probe
        // failure — that's exactly how an exhausted read pool stopped renewal
        // even though the lock was alive. We no longer gate renewal on read-pool
        // health, and we do NOT clearInterval on a transient failure: a blip
        // self-heals on the next tick; the TTL is the backstop if the pool stays
        // genuinely dead (at which point a steal is correct).
        const timeout = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('refresh_timeout')), heartbeatTimeoutMs)
        );
        await Promise.race([handle.refresh(), timeout]);
        healthOk = true;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[lock-refresh] ${lockId}: ${msg}; will retry next tick\n`);
        healthOk = false;
      }
    })();
  }, refreshIntervalMs);
  // #1633: don't let the refresh timer keep the process alive on its own. The
  // finally clearInterval is the primary cleanup; unref is belt-and-suspenders
  // so a missed clear can't pin the event loop open past real work completion.
  (interval as unknown as { unref?: () => void }).unref?.();

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

/**
 * v0.41 Eng D9 (codex pass-2 #7 + #8) — per-tick election convenience.
 *
 * Thin wrapper over `tryAcquireDbLock` for the E5 lease-cap controller
 * use case: each worker ticks every 30s and tries to acquire the
 * controller lock; the winner runs `fn` (read fleet signal, write new
 * lease cap), then releases. Losers no-op for this tick; next tick
 * re-elects.
 *
 * The codex pass-3 #8 + #9 audit confirmed this should reuse the
 * existing `gbrain_cycle_locks` table (which `tryAcquireDbLock` already
 * wraps for both engines) rather than build a parallel new primitive.
 *
 * Semantics:
 *   - Returns the result of `fn` on lock acquisition.
 *   - Returns `null` when another worker holds the lock (not an error;
 *     just "not my tick").
 *   - `fn` throws → release lock cleanly + rethrow.
 *
 * For long-running work that needs mid-flight TTL refresh, use
 * `withRefreshingLock` instead. This helper is for sub-second / single-
 * statement work where the initial TTL covers the whole call.
 */
export async function tryWithDbElection<T>(
  engine: BrainEngine,
  lockId: string,
  ttlMinutes: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const handle = await tryAcquireDbLock(engine, lockId, ttlMinutes);
  if (!handle) return null;
  try {
    return await fn();
  } finally {
    try {
      await handle.release();
    } catch {
      /* idempotent — lock will auto-expire under TTL */
    }
  }
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
