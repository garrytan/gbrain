import postgres from 'postgres';
import { GBrainError, type EngineConfig } from './types.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';
import type { BrainEngine } from './engine.ts';
import { verifySchema } from './schema-verify.ts';

let sql: ReturnType<typeof postgres> | null = null;
let connectedUrl: string | null = null;
// #1720: the in-flight create's probe promise. Concurrent connect() callers
// await THIS — not the not-yet-validated `sql` — so a latecomer never joins a
// client whose SELECT 1 probe is still pending or about to fail. Null when no
// create is in flight; resolves once `sql` is published (validated); rejects
// (with the GBrainError) when the probe fails.
let connecting: Promise<void> | null = null;
// #1720: bumped by disconnect() (and by a new connect's teardown) to invalidate
// an in-flight create. The creator captures this epoch before its probe and, if
// it changed by the time the probe resolves, aborts WITHOUT publishing `sql` —
// otherwise a disconnect() that raced the probe (saw `sql` still null, closed
// nothing) would be silently undone when the probe later publishes a singleton.
let connectEpoch = 0;

/**
 * Default pool size for Postgres connections. Users on the Supabase transaction
 * pooler (port 6543) or any multi-tenant pooler can lower this to avoid
 * MaxClients errors when `gbrain upgrade` spawns subprocesses that each open
 * their own pool. Set `GBRAIN_POOL_SIZE=2` (or similar) before the command.
 */
const DEFAULT_POOL_SIZE_FALLBACK = 10;

/**
 * Supabase PgBouncer transaction-mode convention: port 6543 routes through
 * PgBouncer, which recycles the backend connection between queries and
 * invalidates per-client prepared-statement caches. On that port postgres.js
 * defaults (prepare=true) surface as `prepared statement "..." does not exist`
 * under sustained load and silently drop rows during sync.
 *
 * This is a heuristic, not a protocol guarantee. A direct-Postgres server
 * deliberately bound to 6543 will also get `prepare: false`; the
 * `GBRAIN_PREPARE=true` env var (or `?prepare=true` on the URL) is the
 * documented escape hatch.
 */
const AUTO_DETECT_PORTS = new Set(['6543']);

/**
 * Decide whether to force `prepare: true`/`false` on the postgres.js client.
 *
 * Precedence:
 *   1. `GBRAIN_PREPARE` env var (`true`/`1` or `false`/`0`)
 *   2. `?prepare=true|false` query param on the URL
 *   3. Auto-detect: port 6543 → `false`
 *   4. Default: `undefined` (caller omits the option; postgres.js default stands)
 *
 * Returns `boolean | undefined`. `undefined` is meaningful — callers MUST
 * omit the `prepare` key entirely in that case rather than passing
 * `undefined` through to `postgres(url, {prepare: undefined})`.
 */
export function resolvePrepare(url: string): boolean | undefined {
  const envPrepare = process.env.GBRAIN_PREPARE;
  if (envPrepare === 'false' || envPrepare === '0') return false;
  if (envPrepare === 'true' || envPrepare === '1') return true;

  try {
    const parsed = new URL(url.replace(/^postgres(ql)?:\/\//, 'http://'));
    const urlPrepare = parsed.searchParams.get('prepare');
    if (urlPrepare === 'false') return false;
    if (urlPrepare === 'true') return true;

    if (AUTO_DETECT_PORTS.has(parsed.port)) {
      return false;
    }
  } catch {
    // URL parse failure — fall through to default
  }

  return undefined;
}

export function resolvePoolSize(explicit?: number): number {
  if (typeof explicit === 'number' && explicit > 0) return explicit;
  const raw = process.env.GBRAIN_POOL_SIZE;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_POOL_SIZE_FALLBACK;
}

/**
 * Session-level GUCs applied to every new backend connection. Prevents
 * orphan pgbouncer sessions from holding locks or running queries
 * indefinitely when the postgres.js client disconnects mid-transaction
 * (typical cause: autopilot SIGKILL'd by launchd, worker crash-loop,
 * or transient network drop).
 *
 * Observed failure mode these prevent: a single autopilot UPDATE on
 * `minion_jobs.lock_until` left a pooler backend in `state='active'`
 * / `wait_event='ClientRead'` for 24h+, holding a RowExclusiveLock
 * that blocked every subsequent `ALTER TABLE minion_jobs ...`.
 *
 * Defaults are conservative (chosen not to interfere with bulk work
 * like long-running embed passes or CREATE INDEX on large tables):
 *   - statement_timeout = '5min'
 *   - idle_in_transaction_session_timeout = '5min' (matches v0.18.0
 *     posture; #363's original 2min default was tightened to 5min on
 *     merge with v0.21.0's setSessionDefaults to avoid regressing
 *     long-running embed passes)
 *
 * Override per-GUC with env vars:
 *   - GBRAIN_STATEMENT_TIMEOUT
 *   - GBRAIN_IDLE_TX_TIMEOUT
 *   - GBRAIN_CLIENT_CHECK_INTERVAL (Postgres 14+; empty default - opt-in
 *     only since older self-hosted Postgres rejects this startup param)
 *
 * Set any env var to '0' or 'off' to disable that GUC entirely.
 *
 * Delivered via postgres.js's `connection` option, which sends these as
 * startup parameters in the initial connection packet. Works correctly
 * with PgBouncer session mode AND transaction mode: startup parameters
 * pass through to the backend on connection creation and persist for the
 * backend's lifetime (unlike `SET` commands which transaction-mode
 * PgBouncer strips between transactions).
 *
 * Supersedes the v0.21.0 `setSessionDefaults(sql)` helper, which used
 * a post-pool `SET` command. That approach is unreliable in PgBouncer
 * transaction mode (transaction-mode poolers strip session-state SETs
 * between transactions); startup parameters are durable.
 */
const DEFAULT_STATEMENT_TIMEOUT = '5min';
const DEFAULT_IDLE_TX_TIMEOUT = '5min';

export function resolveSessionTimeouts(): Record<string, string> {
  const out: Record<string, string> = {};
  const add = (envKey: string, gucKey: string, defaultVal: string) => {
    const raw = process.env[envKey];
    if (raw === '0' || raw === 'off') return; // explicitly disabled
    const val = raw ?? defaultVal;
    if (val) out[gucKey] = val;
  };
  add('GBRAIN_STATEMENT_TIMEOUT', 'statement_timeout', DEFAULT_STATEMENT_TIMEOUT);
  add('GBRAIN_IDLE_TX_TIMEOUT', 'idle_in_transaction_session_timeout', DEFAULT_IDLE_TX_TIMEOUT);
  // client_connection_check_interval is opt-in: Postgres 14+ only, and some
  // managed pooler tiers reject unknown startup parameters. Users can enable
  // it explicitly once they know their Postgres version supports it.
  add('GBRAIN_CLIENT_CHECK_INTERVAL', 'client_connection_check_interval', '');
  return out;
}

/**
 * Backward-compat shim for v0.21.0's `setSessionDefaults` callers.
 * The current implementation no-ops because session timeouts are now
 * applied at connection-startup time via `resolveSessionTimeouts()` +
 * postgres.js's `connection` option (more durable across PgBouncer
 * transaction mode).
 *
 * Kept as a callable function so existing call sites in `connect()` and
 * `PostgresEngine.connect()` don't need to be touched on the merge —
 * the work has already happened by the time this function would run.
 */
export async function setSessionDefaults(_sql: ReturnType<typeof postgres>): Promise<void> {
  // No-op: timeouts are now applied as startup parameters in resolveSessionTimeouts().
}

export function getConnection(): ReturnType<typeof postgres> {
  if (!sql) {
    throw new GBrainError(
      'No database connection',
      'connect() has not been called',
      'Run gbrain init --supabase or gbrain init --url <connection_string>',
    );
  }
  return sql;
}

/**
 * Connect the module-level singleton. Returns `true` iff THIS call created the
 * singleton, `false` if it joined an existing (or in-flight) one.
 *
 * #1471 + #1720 ownership/atomicity: the create-vs-join decision is made HERE,
 * atomically across THREE states — live (`sql`), in-flight (`connecting`), and
 * absent. The checks (`if (sql)`, `if (connecting)`) and the synchronous
 * `connecting = (...)()` assignment run with NO `await` between them, so two
 * concurrent module connects cannot both become the creator. The singleton
 * `sql` is published ONLY after its `SELECT 1` probe validates the client, so a
 * latecomer that arrives mid-probe awaits `connecting` instead of joining an
 * unvalidated client that may be about to fail (the join-the-dead-client race).
 * On probe failure every waiter throws and NO caller records ownership; on
 * success exactly one caller (the creator) gets `true` and waiters get `false`.
 * Callers store the return as their ownership token
 * (`PostgresEngine._ownsModuleSingleton`); only the creator may tear it down.
 *
 * Back-compat: callers that ignore the return value are unaffected.
 */
export async function connect(config: EngineConfig): Promise<boolean> {
  // Fast path: a validated, live singleton already exists → borrower.
  if (sql) {
    // Warn if a different URL is passed — the old connection is still in use
    if (config.database_url && connectedUrl && config.database_url !== connectedUrl) {
      console.warn('[gbrain] connect() called with a different database_url but a connection already exists. Using existing connection.');
    }
    return false; // joined an existing singleton — caller is a borrower
  }

  // A create is in flight but not yet probe-validated. Await ITS promise rather
  // than racing a second create: on success we are a borrower of the now-valid
  // singleton; on failure the rejection propagates and we throw too. Neither
  // outcome lets a waiter record ownership of an unvalidated client.
  if (connecting) {
    await connecting;
    return false;
  }

  const url = config.database_url;
  if (!url) {
    throw new GBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run gbrain init --supabase or gbrain init --url <connection_string>',
    );
  }

  // Become the creator. Publish the in-flight promise SYNCHRONOUSLY (no await
  // between the checks above and this assignment) so concurrent callers observe
  // it and await rather than racing a second create.
  connecting = (async () => {
    // Capture the epoch BEFORE the probe. A disconnect() (or another teardown)
    // that races us bumps it; we then refuse to publish a singleton that a
    // completed disconnect already tore down.
    const epoch = connectEpoch;
    let client: ReturnType<typeof postgres> | null = null;
    try {
      const prepare = resolvePrepare(url);
      const timeouts = resolveSessionTimeouts();
      const opts: Record<string, unknown> = {
        max: resolvePoolSize(),
        idle_timeout: 20,
        connect_timeout: 10,
        types: {
          // Register pgvector type
          bigint: postgres.BigInt,
        },
        // Silence postgres NOTICE-level messages by default ("relation already
        // exists, skipping" floods stdout under idempotent CREATE statements
        // during migrations + initSchema, and breaks stdout-parsing callers like
        // `gbrain jobs submit --json | ...`). Opt back in with GBRAIN_PG_NOTICES=1.
        onnotice: process.env.GBRAIN_PG_NOTICES === '1' ? undefined : () => {},
      };
      if (Object.keys(timeouts).length > 0) {
        opts.connection = timeouts;
      }
      if (typeof prepare === 'boolean') {
        opts.prepare = prepare;
        if (!prepare) {
          console.warn(
            '[gbrain] Prepared statements disabled (PgBouncer transaction-mode convention on port 6543). Override with GBRAIN_PREPARE=true if your pooler runs in session mode.',
          );
        }
      }
      client = postgres(url, opts);

      // Validate BEFORE publishing as the singleton.
      await client`SELECT 1`;
      await setSessionDefaults(client);

      // A disconnect() raced us during the probe — do NOT publish (it would undo
      // a completed teardown). Fall through to the catch, which ends this client
      // and rejects so waiters don't join a singleton that was torn down.
      if (epoch !== connectEpoch) {
        throw new GBrainError(
          'Connection aborted',
          'disconnect() ran while this connect() was still probing',
          'Retry connect() — the database was torn down mid-connect.',
        );
      }

      // Publish only now — a concurrent caller awaiting `connecting` becomes a
      // borrower of a client that is proven live.
      sql = client;
      connectedUrl = url;
    } catch (e: unknown) {
      // #1720: end the half-open client before dropping the reference; a thrown
      // probe (EMAXCONNSESSION at the session-mode pooler cap, ECONNREFUSED,
      // etc.) would otherwise orphan a postgres.js client that holds a pooler
      // client slot. `sql` was never published, so it stays null and a later
      // connect() can retry; every waiter on `connecting` rethrows this error.
      sql = null;
      connectedUrl = null;
      if (client) {
        try { await client.end({ timeout: 5 }); } catch { /* best-effort */ }
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new GBrainError(
        'Cannot connect to database',
        msg,
        'Check your connection URL in ~/.gbrain/config.json',
      );
    }
  })();

  try {
    await connecting;
    return true; // we created + validated the singleton — caller is the owner
  } finally {
    // Clear the in-flight marker once settled (success or failure). Waiters hold
    // their own reference to the promise, so nulling it here does not affect
    // them; new callers see either the live `sql` (borrow) or a clean slate
    // (retry).
    connecting = null;
  }
}

export async function disconnect(): Promise<void> {
  // v0.41.25.0 (#1570) — instrument every disconnect call site so v0.41.26
  // can identify the caller that's nulling the module singleton mid-cycle.
  // Best-effort: audit failure must never block the actual disconnect.
  // The audit module is lazy-imported to keep db.ts cold-path-free for
  // tools that import db without ever calling disconnect.
  try {
    const { logDbDisconnect } = await import('./audit/db-disconnect-audit.ts');
    // db.ts is always the module-singleton path by construction; no
    // instance-pool callers go through here.
    logDbDisconnect('postgres', 'module');
  } catch { /* best-effort; never block disconnect on audit failure */ }
  // #1720: invalidate any in-flight connect() probe so it refuses to publish a
  // singleton after this teardown completes (see connectEpoch). Bump BEFORE the
  // snapshot — it is synchronous, so an in-flight creator that resumes after us
  // observes the new epoch and aborts.
  connectEpoch += 1;
  // #1471 (codex #6): snapshot + null the singleton BEFORE awaiting end(), so a
  // concurrent module connect() can't observe a non-null `sql` mid-teardown and
  // join a pool that's already closing. Mirrors the v0.41.8.0 PGLite-disconnect
  // snapshot+early-null pattern.
  const s = sql;
  sql = null;
  connectedUrl = null;
  if (s) await s.end();
}

export async function initSchema(): Promise<void> {
  const conn = getConnection();
  // Advisory lock prevents concurrent initSchema() calls from deadlocking
  await conn`SELECT pg_advisory_lock(42)`;
  try {
    await conn.unsafe(SCHEMA_SQL);
  } finally {
    await conn`SELECT pg_advisory_unlock(42)`;
  }
}

export { verifySchema } from './schema-verify.ts';

export async function withTransaction<T>(fn: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx) => {
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}

const RETRYABLE_DB_CONNECT_PATTERNS = [
  /password authentication failed/i,
  /connection refused/i,
  /the database system is starting up/i,
  /Connection terminated unexpectedly/i,
  /ECONNRESET/i,
];

export function isRetryableDbConnectError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  if (!msg) return false;
  return RETRYABLE_DB_CONNECT_PATTERNS.some(p => p.test(msg));
}

export interface ConnectWithRetryOpts {
  attempts?: number;
  baseDelayMs?: number;
  noRetry?: boolean;
  log?: (line: string) => void;
}

export async function connectWithRetry(
  engine: BrainEngine,
  config: EngineConfig & { poolSize?: number },
  opts: ConnectWithRetryOpts = {},
): Promise<void> {
  const noRetry = opts.noRetry ?? (process.env.GBRAIN_NO_RETRY_CONNECT === '1');
  const attempts = noRetry ? 1 : (opts.attempts ?? 3);
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const log = opts.log ?? ((line) => console.warn(line));

  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      await engine.connect(config);
      return;
    } catch (e: unknown) {
      lastErr = e;
      const retryable = isRetryableDbConnectError(e);
      const isLast = i === attempts - 1;
      if (!retryable || isLast) {
        throw e;
      }
      const delay = baseDelayMs * Math.pow(2, i);
      const msg = e instanceof Error ? e.message : String(e);
      log(`[connect] attempt ${i + 1} failed (${msg.slice(0, 80)}), retrying in ${delay}ms`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  // Unreachable, but TS needs the throw.
  throw lastErr;
}
