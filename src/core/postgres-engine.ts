import postgres from 'postgres';
import type { BrainEngine } from './engine.ts';
import { PgEngineBase, type PgQueryable } from './pg-engine-base.ts';
import { freshSchemaMigrationSql, LATEST_VERSION, runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';
import type {
  EngineConfig,
} from './types.ts';
import { MBrainError } from './types.ts';
import { connectionFailureDetail } from './connection-failure.ts';
import { clearConnectionOwner } from './db.ts';

type PostgresConnectConfig = EngineConfig & {
  poolSize?: number;
  onnotice?: (notice: postgres.Notice) => void;
  schemaLogger?: (message: string) => void;
};

const defaultSchemaLogger = (message: string) => console.log(message);

type PostgresConnection = ReturnType<typeof postgres>;
type PostgresNestedConnection = PostgresConnection & {
  begin?: unknown;
  savepoint?: unknown;
};


type PostgresParam = string | number | boolean | null | Date | Uint8Array | string[];

export class PostgresEngine extends PgEngineBase implements BrainEngine {
  private _sql: ReturnType<typeof postgres> | null = null;
  private schemaLogger = defaultSchemaLogger;

  get sql(): ReturnType<typeof postgres> {
    if (!this._sql) {
      throw new MBrainError(
        'No database connection',
        'connect() has not been called',
        'Create a connected engine first.',
      );
    }
    return this._sql;
  }

  protected get queryable(): PgQueryable {
    return this.scopedQueryable(this.sql);
  }

  private scopedQueryable(sql: ReturnType<typeof postgres>): PgQueryable {
    return {
      query: async (text, params) => {
        const rows = await sql.unsafe(text, (params ?? []) as PostgresParam[] as never[]);
        return { rows: rows as unknown as Record<string, unknown>[] };
      },
    };
  }

  protected async execRaw(sqlText: string): Promise<void> {
    await this.sql.unsafe(sqlText);
  }

  // Lifecycle
  async connect(config: PostgresConnectConfig): Promise<void> {
    if (this._sql) return;

    this.schemaLogger = config.schemaLogger ?? defaultSchemaLogger;
    const url = config.database_url;
    if (!url) {
      throw new MBrainError(
        'No database URL',
        'database_url is missing from config',
        'Run mbrain init --supabase or mbrain init --url <connection_string>',
      );
    }

    let sql: ReturnType<typeof postgres> | null = null;
    try {
      sql = postgres(url, {
        max: config.poolSize ?? 10,
        idle_timeout: 20,
        connect_timeout: 10,
        onnotice: config.onnotice,
        types: {
          bigint: postgres.BigInt,
          // PgEngineBase pre-stringifies json/jsonb params and casts them in
          // SQL. postgres.js applies its json serializer (JSON.stringify) to
          // params the server describes as json/jsonb, which would re-encode
          // those strings into jsonb string scalars. Strings pass through;
          // objects (e.g. via sql.json) still stringify once.
          json: {
            to: 114,
            from: [114, 3802],
            serialize: (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value)),
            parse: (text: string) => JSON.parse(text),
          },
        },
      });
      await sql`SELECT 1`;
      this._sql = sql;
    } catch (e: unknown) {
      if (sql) {
        await sql.end({ timeout: 0 }).catch(() => undefined);
      }
      throw new MBrainError(
        'Cannot connect to database',
        connectionFailureDetail(e),
        'Check your connection URL in ~/.mbrain/config.json',
      );
    }
  }

  async disconnect(): Promise<void> {
    const sql = this._sql;
    if (!sql) return;

    this._sql = null;
    clearConnectionOwner(this);
    await sql.end();
  }

  async initSchema(): Promise<void> {
    const conn = this.sql;
    // Advisory lock prevents concurrent initSchema() calls from deadlocking
    // on DDL statements (DROP TRIGGER + CREATE TRIGGER acquire AccessExclusiveLock)
    await conn`SELECT pg_advisory_lock(42)`;
    try {
      const configTable = await conn<{ exists: string | null }[]>`
        SELECT to_regclass('public.config')::text AS exists
      `;
      const hasExistingConfig = configTable[0]?.exists != null;
      await conn.unsafe(SCHEMA_SQL);
      if (!hasExistingConfig) {
        await conn.unsafe(freshSchemaMigrationSql(1));
        await this.setConfig('version', String(LATEST_VERSION));
      }

      // Run any pending migrations automatically
      const { applied } = await runMigrations(this, { log: this.schemaLogger });
      if (applied > 0) {
        this.schemaLogger(`  ${applied} migration(s) applied`);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(42)`;
    }
  }

  async prepareMcpHttpSurfaceSchema(): Promise<void> {
    await this.sql`
      DO $$
      BEGIN
        IF to_regclass('access_tokens') IS NOT NULL THEN
          ALTER TABLE access_tokens
            ADD COLUMN IF NOT EXISTS scopes TEXT[] DEFAULT ARRAY['mcp']::TEXT[];
          ALTER TABLE access_tokens
            ALTER COLUMN scopes SET DEFAULT ARRAY['mcp']::TEXT[];
          UPDATE access_tokens SET scopes = ARRAY['mcp']::TEXT[] WHERE scopes IS NULL;
        END IF;

        IF to_regclass('mcp_request_log') IS NOT NULL THEN
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_code TEXT;
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS error_reason TEXT;
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS surface_profile TEXT;
          ALTER TABLE mcp_request_log ADD COLUMN IF NOT EXISTS auth_principal_json TEXT;
        END IF;
      END $$;
    `;
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const conn = this.sql as PostgresNestedConnection;
    const runInConnection = (tx: unknown) => {
      const txEngine = Object.create(this) as PostgresEngine;
      const txConn = tx as PostgresConnection;
      Object.defineProperty(txEngine, 'sql', { get: () => txConn });
      Object.defineProperty(txEngine, '_sql', { value: txConn, writable: false });
      return fn(txEngine);
    };

    if (typeof conn.begin === 'function') {
      const begin = conn.begin as <Result>(
        callback: (tx: unknown) => Promise<Result>,
      ) => Promise<Result>;
      return begin((tx) => runInConnection(tx));
    }
    if (typeof conn.savepoint === 'function') {
      const savepointFn = conn.savepoint as <Result>(
        callback: (tx: unknown) => Promise<Result>,
      ) => Promise<Result>;
      return savepointFn((tx) => runInConnection(tx));
    }

    const savepoint = `mbrain_nested_${crypto.randomUUID().replace(/-/g, '')}`;
    await conn.unsafe(`SAVEPOINT ${savepoint}`);
    try {
      const result = await fn(this);
      await conn.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await conn.unsafe(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await conn.unsafe(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Best effort nested rollback.
      }
      throw error;
    }
  }

  protected async withSearchTimeout<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    const sql = this.sql as ReturnType<typeof postgres> & {
      reserve?: () => Promise<ReturnType<typeof postgres> & { release?: () => Promise<void> }>;
      release?: () => Promise<void>;
      savepoint?: unknown;
    };

    if (typeof sql.savepoint === 'function') {
      await sql`SELECT set_config('statement_timeout', '8s', true)`;
      return fn(this.scopedQueryable(sql));
    }

    const reserved = typeof sql.reserve === 'function' ? await sql.reserve() : null;
    const scopedSql = (reserved || sql) as ReturnType<typeof postgres> & { release?: () => Promise<void> };
    const previous = await scopedSql<{ statement_timeout: string }[]>`
      SELECT current_setting('statement_timeout') AS statement_timeout
    `;

    try {
      await scopedSql`SELECT set_config('statement_timeout', '8s', false)`;
      return await fn(this.scopedQueryable(scopedSql));
    } finally {
      try {
        await scopedSql`SELECT set_config('statement_timeout', ${previous[0]?.statement_timeout || '0'}, false)`;
      } finally {
        if (reserved && typeof reserved.release === 'function') {
          await reserved.release();
        }
      }
    }
  }

}
