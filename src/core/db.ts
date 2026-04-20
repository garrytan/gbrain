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

  // Transaction-mode poolers (Supabase pgbouncer on :6543, or
  // pooler.supabase.com) invalidate server-side prepared statements between
  // connection releases. postgres.js caches prepared statements by default,
  // so a later query on a different underlying connection that reuses the
  // same prepared-statement name trips `prepared statement "xyz" does not
  // exist`. Detect pooler URLs and disable prepared statements; direct
  // connections (port 5432, non-pooler hosts) keep prepare=true for perf.
  const isPooler = /pooler\.supabase\.com|:6543/i.test(url);

  try {
    sql = postgres(url, {
      max: resolvePoolSize(),
      idle_timeout: 20,
      connect_timeout: 10,
      prepare: !isPooler,
      types: {
        // Register pgvector type
        bigint: postgres.BigInt,
      },
    });

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
  });
}
