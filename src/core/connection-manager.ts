/**
 * Connection Manager — route Postgres queries by query type (v0.30.1, Fix 1).
 *
 * Three pools, one decision: read() goes to the pooler (port 6543, fast,
 * many connections); ddl() and bulk() go to a direct connection (port 5432,
 * 30min statement_timeout, capped at 3 conns) so DDL doesn't time out on
 * the Supabase pooler's 2-min statement_timeout.
 *
 * The connection-manager is the URL-routing layer. It layers on top of
 * postgres.js's existing pool primitives + PostgresEngine.withReservedConnection.
 *
 *   ┌─────────────────────────────┐
 *   │ GBRAIN_DATABASE_URL         │   GBRAIN_DIRECT_DATABASE_URL (override)
 *   │ (pooler, port 6543)         │
 *   └────────┬────────────────────┘
 *            │
 *            ▼ auto-detect Supabase
 *   ┌──────────────┐    ┌──────────────┐
 *   │  read pool   │    │ direct pool  │
 *   │  size 10     │    │ size 3       │
 *   │  prepare:no  │    │ stmt 30min   │
 *   │  stmt 5min   │    │ idle 5min    │
 *   └──────────────┘    │ mwm 256MB    │
 *                       └──────────────┘
 *
 * Architectural notes:
 *  - INSTANCE-owned (T5 / X1 amendment): each PostgresEngine constructs its
 *    own ConnectionManager. Worker engines (cycle, sync) inherit the parent's
 *    via constructor option `parent`. transaction() clones share the parent's.
 *  - Lazy direct pool init via cached Promise<Sql> (A1): concurrent first
 *    callers await the same Promise, so no double-init.
 *  - Kill-switch (F1): GBRAIN_DISABLE_DIRECT_POOL=1 falls back to single-pool
 *    legacy path. With parent set, inherit parent's kill-switch state (A2).
 *  - Audit (F8): every acquire/release/error logs to connection-events.jsonl.
 *  - Non-Supabase passthrough: if URL isn't a Supabase pooler and no
 *    GBRAIN_DIRECT_DATABASE_URL override, ddl()/bulk() share the read pool.
 */

import postgres from 'postgres';
import { resolvePrepare, resolveSessionTimeouts, resolvePoolSize } from './db.ts';
import { redactPgUrl } from './url-redact.ts';
import { logConnectionEvent } from './connection-audit.ts';

export type Sql = ReturnType<typeof postgres>;

export interface ConnectionManagerOpts {
  /** Primary URL — usually the pooler (port 6543) on Supabase. */
  url: string;
  /**
   * Override for the direct URL. When set, takes precedence over auto-derivation.
   * Sourced from GBRAIN_DIRECT_DATABASE_URL or explicit caller config.
   */
  directUrl?: string | null;
  /**
   * Inherit pools + kill-switch state from a parent manager (worker engines,
   * transaction clones). When set, this manager is a thin reference holder
   * and does NOT open its own pools.
   */
  parent?: ConnectionManager;
  /**
   * Read pool size override (defaults to resolvePoolSize() — 10 normally).
   */
  readPoolSize?: number;
  /**
   * Direct pool size override (defaults to GBRAIN_DIRECT_POOL_SIZE env or 3).
   */
  directPoolSize?: number;
  /**
   * When true, the read pool is owned by some other code (e.g. db.ts:connect's
   * module singleton). The connection manager will USE it via getReadPool but
   * not call .end() on disconnect(). Default false (we own both pools).
   */
  readPoolOwnedExternally?: boolean;
}

/** Default direct-pool size (P1 raised from 2 to 3). Override via env. */
export const DEFAULT_DIRECT_POOL_SIZE = 3;

/** Search statement timeout (F5 consolidation) — was 8s scattered. */
export const SEARCH_STMT_TIMEOUT_MS = 8000;

/** DDL pool default statement_timeout (Fix 1). */
const DDL_STMT_TIMEOUT_MS = 30 * 60 * 1000; // 30min

/** DDL pool default idle-in-transaction timeout (Fix 1). */
const DDL_IDLE_TX_TIMEOUT_MS = 5 * 60 * 1000; // 5min

/** Bulk pool default maintenance_work_mem (P1). 256MB safe on Supabase. */
const BULK_MAINTENANCE_WORK_MEM = '256MB';

/**
 * Hostname patterns that indicate a Supabase pooler. Used for auto-detection
 * of the dual-pool topology. Adding more patterns is safe; mis-detection
 * just means we open a "direct" pool against the same URL — wasteful but
 * not broken (the kill-switch is the operator's escape hatch).
 */
const SUPABASE_POOLER_HOSTNAME_PATTERNS = [
  /\.pooler\.supabase\.com$/i,
  /^pooler\.supabase\.com$/i,
];

const SUPABASE_POOLER_PORTS = new Set(['6543']);

/**
 * True if the URL looks like a Supabase pooler endpoint. Used for kill-switch
 * activation and dual-pool routing.
 */
export function isSupabasePoolerUrl(url: string): boolean {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    if (SUPABASE_POOLER_PORTS.has(parsed.port)) return true;
    if (SUPABASE_POOLER_HOSTNAME_PATTERNS.some(re => re.test(parsed.hostname))) return true;
    return false;
  } catch {
    return false;
  }
}

/**
 * Derive a direct (non-pooler) URL from a Supabase pooler URL. Two known shapes:
 *
 *   Pooler hostname: aws-N-region.pooler.supabase.com on port 6543
 *      → swap to db.<project-ref>.supabase.co on port 5432
 *      (project-ref encoded in the user component as postgres.<ref>)
 *   Direct hostname: db.<ref>.supabase.co already on port 5432 → returned as-is
 *
 * For the modern shape, we try to extract project-ref from the user component.
 * If we cannot, we fall back to swapping port-only and the caller may warn.
 *
 * Returns null when the URL isn't a recognized Supabase pooler.
 */
export function deriveDirectUrl(url: string): string | null {
  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    const port = parsed.port;
    const hostname = parsed.hostname;
    const isPoolerHost = SUPABASE_POOLER_HOSTNAME_PATTERNS.some(re => re.test(hostname));
    if (port !== '6543' && !isPoolerHost) return null;
    // User part on Supabase pooler is typically `postgres.<project-ref>`.
    // Extract <project-ref> for the direct hostname.
    const user = parsed.username || '';
    const decodedUser = decodeURIComponent(user);
    const refMatch = decodedUser.match(/^postgres\.([a-z0-9]+)$/i);
    let directHost = hostname;
    let directUser = parsed.username;
    if (refMatch && refMatch[1] && isPoolerHost) {
      directHost = `db.${refMatch[1]}.supabase.co`;
      // Supabase direct connections use bare `postgres`; the `postgres.<ref>`
      // form is pooler-only (Supavisor uses the suffix for tenant routing).
      // Without this strip, direct auth fails with `password authentication
      // failed for user "postgres.<ref>"` even though the password is correct.
      directUser = 'postgres';
    }
    // Compose direct URL by swapping host + port. Preserve auth, db, query.
    parsed.hostname = directHost;
    parsed.port = '5432';
    // Reconstruct with the original scheme.
    const scheme = url.match(/^postgres(?:ql)?:\/\//i)?.[0] ?? 'postgres://';
    const auth = directUser
      ? `${directUser}${parsed.password ? `:${parsed.password}` : ''}@`
      : '';
    const search = parsed.search ?? '';
    const path = parsed.pathname ?? '';
    return `${scheme}${auth}${directHost}:5432${path}${search}`;
  } catch {
    return null;
  }
}

/**
 * Read kill-switch state from env. Subordinate to parent manager's state
 * when present (A2 inheritance).
 */
export function readKillSwitchEnv(): boolean {
  return process.env.GBRAIN_DISABLE_DIRECT_POOL === '1' ||
    process.env.GBRAIN_DISABLE_DIRECT_POOL === 'true';
}

/**
 * Resolve direct pool size: explicit > env > default.
 */
export function resolveDirectPoolSize(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const raw = process.env.GBRAIN_DIRECT_POOL_SIZE;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0 && parsed <= 20) return parsed;
  }
  return DEFAULT_DIRECT_POOL_SIZE;
}

export class ConnectionManager {
  private readonly opts: ConnectionManagerOpts;
  private _readPool: Sql | null = null;
  private _readPoolOwnedExternally: boolean;
  private _directInit: Promise<Sql | null> | null = null;
  private _directPool: Sql | null = null;
  private _killSwitch: boolean;
  private _directUrl: string | null;
  private _isSupabase: boolean;

  constructor(opts: ConnectionManagerOpts) {
    this.opts = opts;
    this._readPoolOwnedExternally = opts.readPoolOwnedExternally === true;

    // A2: kill-switch resolution. Parent overrides env when present.
    if (opts.parent) {
      this._killSwitch = opts.parent.isKillSwitchActive();
      this._isSupabase = opts.parent.isSupabase();
      this._directUrl = opts.parent.resolveDirectUrl();
      this._readPool = opts.parent.peekReadPool();
      this._readPoolOwnedExternally = true; // never end the parent's pool
    } else {
      this._killSwitch = readKillSwitchEnv();
      this._isSupabase = isSupabasePoolerUrl(opts.url);
      // Direct URL: explicit override > env > derive > null
      const envOverride = process.env.GBRAIN_DIRECT_DATABASE_URL;
      this._directUrl = opts.directUrl ?? envOverride ?? deriveDirectUrl(opts.url);
    }
  }

  /** Whether dual-pool routing is active (false on non-Supabase or kill-switch). */
  isDualPoolActive(): boolean {
    return this._isSupabase && !this._killSwitch && !!this._directUrl;
  }

  isSupabase(): boolean { return this._isSupabase; }
  isKillSwitchActive(): boolean { return this._killSwitch; }
  resolveDirectUrl(): string | null { return this._directUrl; }

  /**
   * Internal: peek at the read pool without forcing init. Used by parent
   * inheritance to share the same instance.
   */
  peekReadPool(): Sql | null { return this._readPool; }

  /**
   * Set the read pool. Used by db.ts:connect or PostgresEngine.connect when
   * they own the pool externally (and connection-manager is just routing).
   */
  setReadPool(sql: Sql): void {
    this._readPool = sql;
    this._readPoolOwnedExternally = true;
  }

  /**
   * Get or lazily create the read pool. Honors `readPoolOwnedExternally` so
   * we don't double-create when db.ts:connect already owns the singleton.
   */
  async getReadPool(): Promise<Sql> {
    if (this._readPool) return this._readPool;
    if (this._readPoolOwnedExternally) {
      throw new Error('connection-manager: read pool marked as externally-owned but not provided');
    }
    const opts: Record<string, unknown> = {
      max: resolvePoolSize(this.opts.readPoolSize),
      idle_timeout: 20,
      connect_timeout: 10,
      types: { bigint: postgres.BigInt },
    };
    const timeouts = resolveSessionTimeouts();
    if (Object.keys(timeouts).length > 0) opts.connection = timeouts;
    const prepare = resolvePrepare(this.opts.url);
    if (typeof prepare === 'boolean') opts.prepare = prepare;
    this._readPool = postgres(this.opts.url, opts);
    logConnectionEvent({ pool: 'read', op: 'init' });
    return this._readPool;
  }

  /**
   * Acquire the read connection. Synchronous accessor — assumes read pool
   * is already initialized (matches existing engine.sql semantics).
   * Throws if pool not ready.
   */
  read(): Sql {
    if (!this._readPool) {
      throw new Error('connection-manager: read pool not initialized; call getReadPool() first or set externally');
    }
    return this._readPool;
  }

  /**
   * Acquire (and lazy-init) the direct DDL pool. When kill-switch is active
   * or non-Supabase, returns the read pool (single-pool fallback).
   *
   * A1: lazy init wraps in a cached Promise<Sql> so concurrent first-callers
   * await the same init instead of racing two pool constructions.
   */
  async ddl(): Promise<Sql> {
    if (!this.isDualPoolActive()) {
      return this.getReadPool();
    }
    return this.getDirectPool();
  }

  /**
   * Acquire the direct pool for a long-running BULK operation. Caller can
   * override the per-op timeout via SET LOCAL inside a sql.begin block.
   * Same pool as ddl(); the distinction is callsite intent (used by audit
   * + caller-side timeout SET LOCAL).
   */
  async bulk(_timeoutSeconds?: number): Promise<Sql> {
    if (!this.isDualPoolActive()) {
      return this.getReadPool();
    }
    return this.getDirectPool();
  }

  private async getDirectPool(): Promise<Sql> {
    if (this._directPool) return this._directPool;
    // A1: cache the Promise so concurrent first callers await the same init.
    if (!this._directInit) {
      this._directInit = this.initDirectPool().then(pool => {
        this._directPool = pool;
        return pool;
      }).catch(err => {
        // Reset cache on failure so next caller can retry.
        this._directInit = null;
        throw err;
      });
    }
    const pool = await this._directInit;
    if (!pool) {
      // Defensive — initDirectPool should have thrown.
      throw new Error('connection-manager: direct pool init returned null');
    }
    return pool;
  }

  private async initDirectPool(): Promise<Sql> {
    if (!this._directUrl) {
      throw new Error('connection-manager: cannot init direct pool — no direct URL');
    }
    const size = resolveDirectPoolSize(this.opts.directPoolSize);
    const opts: Record<string, unknown> = {
      max: size,
      idle_timeout: 20,
      connect_timeout: 10,
      types: { bigint: postgres.BigInt },
      // Always use prepared statements on the direct pool — no PgBouncer
      // here, so the prepare-cache invalidation issue doesn't apply.
      prepare: true,
      // Apply DDL session GUCs as connection startup parameters (durable
      // through any intermediary pooling layer, same trick as
      // resolveSessionTimeouts).
      connection: {
        statement_timeout: String(DDL_STMT_TIMEOUT_MS),
        idle_in_transaction_session_timeout: String(DDL_IDLE_TX_TIMEOUT_MS),
        maintenance_work_mem: BULK_MAINTENANCE_WORK_MEM,
      },
    };
    const t0 = Date.now();
    try {
      const pool = postgres(this._directUrl, opts);
      // Probe to validate connectivity early.
      await pool`SELECT 1`;
      logConnectionEvent({
        pool: 'ddl',
        op: 'init',
        duration_ms: Date.now() - t0,
        host: this._directUrl ? this.hostOnly(this._directUrl) : undefined,
      });
      return pool;
    } catch (err) {
      logConnectionEvent({
        pool: 'ddl',
        op: 'error',
        duration_ms: Date.now() - t0,
        error: { message: err instanceof Error ? err.message : String(err) },
      });
      throw err;
    }
  }

  /**
   * SELECT 1 latency probe on each pool. Used by doctor's connection_routing
   * check + healthCheck() in the gateway.
   */
  async healthCheck(): Promise<{ read: number | null; direct: number | null }> {
    const result: { read: number | null; direct: number | null } = { read: null, direct: null };
    try {
      const t0 = Date.now();
      const pool = await this.getReadPool();
      await pool`SELECT 1`;
      result.read = Date.now() - t0;
    } catch { /* leave null */ }
    if (this.isDualPoolActive()) {
      try {
        const t0 = Date.now();
        const pool = await this.getDirectPool();
        await pool`SELECT 1`;
        result.direct = Date.now() - t0;
      } catch { /* leave null */ }
    }
    return result;
  }

  /**
   * Disconnect pools we own. Read pool stays alive if marked externally owned
   * (db.ts singleton path). Direct pool is always ours.
   */
  async disconnect(): Promise<void> {
    if (this._directPool) {
      try { await this._directPool.end(); } catch { /* idempotent */ }
      this._directPool = null;
      this._directInit = null;
    }
    if (this._readPool && !this._readPoolOwnedExternally) {
      try { await this._readPool.end(); } catch { /* idempotent */ }
      this._readPool = null;
    }
  }

  /**
   * Diagnostic snapshot for doctor / get_health surfaces.
   */
  describeMode(): {
    mode: 'split' | 'single (kill-switch)' | 'single (non-supabase)' | 'single (no-direct-url)';
    direct_host?: string;
    kill_switch_active: boolean;
    direct_pool_size: number;
  } {
    let mode: 'split' | 'single (kill-switch)' | 'single (non-supabase)' | 'single (no-direct-url)';
    if (!this._isSupabase) mode = 'single (non-supabase)';
    else if (this._killSwitch) mode = 'single (kill-switch)';
    else if (!this._directUrl) mode = 'single (no-direct-url)';
    else mode = 'split';
    return {
      mode,
      direct_host: this._directUrl ? this.hostOnly(this._directUrl) : undefined,
      kill_switch_active: this._killSwitch,
      direct_pool_size: resolveDirectPoolSize(this.opts.directPoolSize),
    };
  }

  private hostOnly(url: string): string {
    // Redact creds first, then strip everything except host:port for doctor display.
    const redacted = redactPgUrl(url);
    try {
      const parsed = new URL(redacted.replace(/^postgres(ql)?:\/\//, 'http://'));
      return `${parsed.hostname}${parsed.port ? `:${parsed.port}` : ''}`;
    } catch {
      return redacted;
    }
  }
}
