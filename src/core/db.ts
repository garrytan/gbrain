import postgres from 'postgres';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { GBrainError, type EngineConfig } from './types.ts';
import { isPGliteConfig, startPGliteBridge, type PGliteBridgeHandle } from './pglite.ts';

let sql: ReturnType<typeof postgres> | null = null;
let pgliteBridge: PGliteBridgeHandle | null = null;

export function getConnection(): ReturnType<typeof postgres> {
  if (!sql) {
    throw new GBrainError(
      'No database connection',
      'connect() has not been called',
      'Run gbrain init --url <connection_string>, gbrain init --pglite <file_path>, or gbrain init --supabase',
    );
  }
  return sql;
}

export async function connect(config: EngineConfig): Promise<void> {
  if (sql) return;

  const url = isPGliteConfig(config)
    ? null
    : config.database_url;
  if (!url && !isPGliteConfig(config)) {
    throw new GBrainError(
      'No database URL',
      'database_url is missing from config',
      'Run gbrain init --url <connection_string>, gbrain init --pglite <file_path>, or gbrain init --supabase',
    );
  }

  if (isPGliteConfig(config) && !config.database_path) {
    throw new GBrainError(
      'No database path',
      'database_path is missing from config for pglite engine',
      'Run gbrain init --pglite <file_path>',
    );
  }

  try {
    const connectionUrl = isPGliteConfig(config)
      ? (pgliteBridge = await startPGliteBridge(config.database_path!)).connectionString
      : url!;
    sql = postgres(connectionUrl, {
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
    if (pgliteBridge) {
      await pgliteBridge.stop();
      pgliteBridge = null;
    }
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
  if (pgliteBridge) {
    await pgliteBridge.stop();
    pgliteBridge = null;
  }
}

export async function initSchema(): Promise<void> {
  const conn = getConnection();

  // Read schema SQL and execute as a single statement.
  // The postgres driver handles multi-statement SQL natively, including
  // PL/pgSQL functions with $$ delimiter blocks that contain semicolons.
  // The schema uses IF NOT EXISTS / CREATE OR REPLACE for idempotency.
  const schemaPath = join(dirname(new URL(import.meta.url).pathname), '..', 'schema.sql');
  const schemaSql = readFileSync(schemaPath, 'utf-8');

  await conn.unsafe(schemaSql);
}

export async function withTransaction<T>(fn: () => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx) => {
    // Temporarily swap global connection to transaction
    const prev = sql;
    sql = tx as unknown as ReturnType<typeof postgres>;
    try {
      return await fn();
    } finally {
      sql = prev;
    }
  });
}
