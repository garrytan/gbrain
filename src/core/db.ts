import postgres from 'postgres';
import { GBrainError, type EngineConfig } from './types.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';

let sql: ReturnType<typeof postgres> | null = null;
let connectedUrl: string | null = null;

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

export async function connect(config: EngineConfig): Promise<void> {
  if (sql) {
    // Warn if a different URL is passed — the old connection is still in use
    if (config.database_url && connectedUrl && config.database_url !== connectedUrl) {
      console.warn('[gbrain] connect() called with a different database_url but a connection already exists. Using existing connection.');
    }
    return;
  }

  const url = config.database_url;
  if (!url) {
    throw new GBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run gbrain init --supabase or gbrain init --url <connection_string>',
    );
  }

  try {
    const prepare = resolvePrepare(url);
    const opts: Record<string, unknown> = {
      max: resolvePoolSize(),
      idle_timeout: 20,
      connect_timeout: 10,
      types: {
        // Register pgvector type
        bigint: postgres.BigInt,
      },
    };
    if (typeof prepare === 'boolean') {
      opts.prepare = prepare;
      if (!prepare) {
        console.warn(
          '[gbrain] Prepared statements disabled (PgBouncer transaction-mode convention on port 6543). Override with GBRAIN_PREPARE=true if your pooler runs in session mode.',
        );
      }
    }
    sql = postgres(url, opts);

    // Test connection
    await sql`SELECT 1`;
    connectedUrl = url;
  } catch (e: unknown) {
    sql = null;
    connectedUrl = null;
    const msg = e instanceof Error ? e.message : String(e);
    throw new GBrainError(
      'Cannot connect to database',
      msg,
      'Check your connection URL in ~/.gbrain/config.json',
    );
  }
}

export async function disconnect(): Promise<void> {
  if (sql) {
    await sql.end();
    sql = null;
    connectedUrl = null;
  }
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

export async function withTransaction<T>(fn: (tx: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx) => {
    return fn(tx as unknown as ReturnType<typeof postgres>);
  }) as Promise<T>;
}
