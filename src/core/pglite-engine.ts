import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { BrainEngine } from './engine.ts';
import { PgEngineBase, type PgQueryable } from './pg-engine-base.ts';
import { freshSchemaMigrationSql, LATEST_VERSION, runMigrations, shouldSilenceMigrationLogs } from './migrate.ts';
import { PGLITE_SCHEMA_SQL } from './pglite-schema.ts';
import { acquireLock, releaseLock, type LockHandle } from './pglite-lock.ts';
import { assertPgVectorEmbeddingDimensions } from './pgvector-dimensions.ts';
import { buildPageCentroid } from './services/page-embedding.ts';
import type {
  EngineConfig,
} from './types.ts';

type PGLiteDB = PGlite;
const PGLITE_EMBEDDED_SCHEMA_VERSION = 12;

export class PGLiteEngine extends PgEngineBase implements BrainEngine {
  private _db: PGLiteDB | null = null;
  private _lock: LockHandle | null = null;

  get db(): PGLiteDB {
    if (!this._db) throw new Error('PGLite not connected. Call connect() first.');
    return this._db;
  }

  protected get queryable(): PgQueryable {
    const db = this.db;
    return {
      query: async (text, params) => {
        const result = await db.query<Record<string, unknown>>(text, params);
        return { rows: result.rows };
      },
    };
  }

  protected async withSearchTimeout<T>(fn: (q: PgQueryable) => Promise<T>): Promise<T> {
    return fn(this.queryable);
  }

  protected async execRaw(sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  protected override async onChunksChanged(pageId: number): Promise<void> {
    await this.refreshPageEmbeddingFromChunks(pageId);
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    const dataDir = config.database_path || undefined; // undefined = in-memory
    this._lock = await acquireLock(dataDir);
    this._db = await PGlite.create({
      dataDir,
      extensions: { vector, pg_trgm },
    });
  }

  async disconnect(): Promise<void> {
    let closeError: unknown = null;
    try {
      if (this._db) {
        await this._db.close();
      }
    } catch (error) {
      closeError = error;
    } finally {
      this._db = null;
      if (this._lock?.acquired) {
        await releaseLock(this._lock);
      }
      this._lock = null;
    }

    if (closeError) throw closeError;
  }

  async initSchema(): Promise<void> {
    const hasExistingConfig = await this.hasConfigTable();
    await this.db.exec(PGLITE_SCHEMA_SQL);
    if (!hasExistingConfig) {
      await this.db.exec(freshSchemaMigrationSql(PGLITE_EMBEDDED_SCHEMA_VERSION));
      await this.setConfig('version', String(LATEST_VERSION));
    }

    const { applied } = await runMigrations(this);
    if (applied > 0 && !shouldSilenceMigrationLogs()) {
      console.log(`  ${applied} migration(s) applied`);
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const db = this.db as PGLiteDB & { transaction?: PGLiteDB['transaction'] };
    if (typeof db.transaction !== 'function') {
      const savepoint = `mbrain_nested_${crypto.randomUUID().replace(/-/g, '')}`;
      await db.query(`SAVEPOINT ${savepoint}`);
      try {
        const result = await fn(this);
        await db.query(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        try {
          await db.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          await db.query(`RELEASE SAVEPOINT ${savepoint}`);
        } catch {
          // Best effort nested rollback.
        }
        throw error;
      }
    }

    return db.transaction(async (tx) => {
      const txEngine = Object.create(this) as PGLiteEngine;
      Object.defineProperty(txEngine, 'db', { get: () => tx });
      return fn(txEngine);
    });
  }

  private async hasConfigTable(): Promise<boolean> {
    try {
      await this.db.query(`SELECT value FROM config WHERE key = 'version' LIMIT 1`);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (/config/i.test(message) && /does not exist|not exist|no such table|undefined table/i.test(message)) {
        return false;
      }
      throw error;
    }
  }

  private async refreshPageEmbeddingFromChunks(pageId: number): Promise<void> {
    const { rows } = await this.db.query(
      `SELECT embedding
       FROM content_chunks
       WHERE page_id = $1 AND embedding IS NOT NULL
       ORDER BY chunk_index`,
      [pageId],
    );
    const centroid = buildPageCentroid(
      (rows as Record<string, unknown>[]).map((row) => vectorValueToFloat32(row.embedding)),
    );

    if (centroid) {
      assertPgVectorEmbeddingDimensions(centroid, `Page centroid for ${pageId}`);
      await this.db.query(
        `UPDATE pages
         SET page_embedding = $1::vector(1024)
         WHERE id = $2`,
        [vectorLiteral(centroid), pageId],
      );
      return;
    }

    await this.db.query(
      `UPDATE pages
       SET page_embedding = NULL
       WHERE id = $1`,
      [pageId],
    );
  }
}

function vectorLiteral(embedding: Float32Array): string {
  return `[${Array.from(embedding).join(',')}]`;
}

function vectorValueToFloat32(value: unknown): Float32Array | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return new Float32Array(value.map((entry) => Number(entry)));

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const body = trimmed.startsWith('[') && trimmed.endsWith(']')
      ? trimmed.slice(1, -1)
      : trimmed;
    if (body.length === 0) return new Float32Array(0);

    const parts = body.split(',').map((entry) => Number(entry.trim()));
    if (parts.some((entry) => Number.isNaN(entry))) return null;
    return new Float32Array(parts);
  }

  return null;
}
