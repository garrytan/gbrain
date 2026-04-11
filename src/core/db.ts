import postgres from 'postgres';
import { GBrainError, type EngineConfig } from './types.ts';
import { getSchemaSQL } from './schema-embedded.ts';

let sql: ReturnType<typeof postgres> | null = null;

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
  if (sql) return;

  const url = config.database_url;
  if (!url) {
    throw new GBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run gbrain init --supabase or gbrain init --url <connection_string>',
    );
  }

  try {
    sql = postgres(url, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      types: {
        // Register pgvector type
        bigint: postgres.BigInt,
      },
    });

    // Test connection
    await sql`SELECT 1`;
  } catch (e: unknown) {
    sql = null;
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
  }
}

export async function initSchema(dimensions: number, model: string): Promise<void> {
  const conn = getConnection();
  // Advisory lock prevents concurrent initSchema() calls from deadlocking
  await conn`SELECT pg_advisory_lock(42)`;
  try {
    await conn.unsafe(getSchemaSQL(dimensions, model));
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
