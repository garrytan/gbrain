import path from 'node:path';
import os from 'node:os';
import postgres from 'postgres';
import { GBrainError, type EngineConfig } from './types.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';

let sql: any = null;
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

export function getConnection(): any {
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
    if (config.database_url && connectedUrl && config.database_url !== connectedUrl) {
      console.warn('[gbrain] connect() called with a different database_url but a connection already exists. Using existing connection.');
    }
    return;
  }

  let url = config.database_url;
  
  // If no URL provided, default to local PGLite in the home directory.
  // This ensures a real OS filesystem path is used, bypassing Bun's $bunfs virtual filesystem.
  if (!url) {
    url = `pglite://${path.join(os.homedir(), '.gbrain', 'data')}`;
  }

  try {
    if (url.startsWith('pglite://')) {
      let dataDir = url.slice(9);
      
      // Detect if we are running in a Bun single-file executable ($bunfs://)
      const isBunCompiled = import.meta.url.startsWith('bunfs:');
      
      // Resolve relative paths against the current working directory to avoid $bunfs resolution errors
      if (dataDir !== 'memory' && dataDir !== ':memory:') {
        if (dataDir.startsWith('.') || (isBunCompiled && !dataDir.startsWith('/'))) {
          dataDir = path.resolve(process.cwd(), dataDir);
        }
      }

      const { PGLite } = await import('@electric-sql/pglite');
      const pg = new PGLite(dataDir);

      // Wrapper to make PGLite compatible with the postgres.js interface used elsewhere
      const wrap = (client: any): any => {
        const queryFn = (async (strings: TemplateStringsArray, ...values: any[]) => {
          const query = strings.reduce((acc, str, i) => acc + str + (i < values.length ? `\$${i + 1}` : ''), '');
          const res = await client.query(query, values);
          return res.rows;
        }) as any;

        queryFn.unsafe = async (query: string) => {
          const res = await client.exec(query);
          const last = Array.isArray(res) ? res[res.length - 1] : res;
          return last?.rows || [];
        };

        queryFn.begin = async (fn: any) => {
          return await client.transaction(async (tx: any) => {
            return await fn(wrap(tx));
          });
        };

        queryFn.end = () => client.close();
        return queryFn;
      };

      sql = wrap(pg);
      await sql`SELECT 1`;
      connectedUrl = url;
    } else {
      sql = postgres(url, {
        max: resolvePoolSize(),
        idle_timeout: 20,
        connect_timeout: 10,
        types: {
          bigint: postgres.BigInt,
        },
      });

      await sql`SELECT 1`;
      connectedUrl = url;
    }
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
    if (typeof sql.end === 'function') await sql.end();
    sql = null;
    connectedUrl = null;
  }
}

export async function initSchema(): Promise<void> {
  const conn = getConnection();
  // Advisory locks only supported on network Postgres, skip for PGLite
  const isPGLite = connectedUrl?.startsWith('pglite://');
  
  if (!isPGLite) await conn`SELECT pg_advisory_lock(42)`;
  try {
    await conn.unsafe(SCHEMA_SQL);
  } finally {
    if (!isPGLite) await conn`SELECT pg_advisory_unlock(42)`;
  }
}

export async function withTransaction<T>(fn: (tx: any) => Promise<T>): Promise<T> {
  const conn = getConnection();
  return conn.begin(async (tx: any) => {
    return fn(tx);
  });
}