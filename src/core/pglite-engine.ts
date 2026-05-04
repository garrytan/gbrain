import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Transaction } from '@electric-sql/pglite';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput, ReservedConnection, DreamVerdict, DreamVerdictInput } from './engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { PGLITE_SCHEMA_SQL, getPGLiteSchema } from './pglite-schema.ts';
import { acquireLock, releaseLock, type LockHandle } from './pglite-lock.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput, StaleChunkRow,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  EvalCandidate, EvalCandidateInput,
  EvalCaptureFailure, EvalCaptureFailureReason,
} from './types.ts';
import { validateSlug, contentHash, rowToPage, rowToChunk, rowToSearchResult } from './utils.ts';
import { resolveBoostMap, resolveHardExcludes } from './search/source-boost.ts';
import { buildSourceFactorCase, buildHardExcludeClause, buildVisibilityClause } from './search/sql-ranking.ts';

type PGLiteDB = PGlite;

// Tier 3 snapshot fast-restore. Reads a tar dump produced by
// `bun run scripts/build-pglite-snapshot.ts`. Snapshot is matched against
// the current MIGRATIONS hash via a sidecar `.version` file; on mismatch we
// silently fall through to a normal initSchema (snapshot is just an
// optimization, never authoritative).
let _snapshotWarnLogged = false;
function tryLoadSnapshot(snapshotPath: string): Blob | null {
  try {
    // Lazy require so production builds without these imports don't crash.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const { MIGRATIONS } = require('./migrate.ts') as typeof import('./migrate.ts');
    const { PGLITE_SCHEMA_SQL } = require('./pglite-schema.ts') as typeof import('./pglite-schema.ts');

    if (!fs.existsSync(snapshotPath)) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] GBRAIN_PGLITE_SNAPSHOT set but file missing: ${snapshotPath} — using normal init.`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    const versionPath = snapshotPath.replace(/\.tar(?:\.gz)?$/, '.version');
    if (!fs.existsSync(versionPath)) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] snapshot version file missing: ${versionPath} — using normal init.`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    const expectedHash = computeSnapshotSchemaHash(MIGRATIONS, PGLITE_SCHEMA_SQL, crypto);
    const actualHash = fs.readFileSync(versionPath, 'utf8').trim();
    if (expectedHash !== actualHash) {
      if (!_snapshotWarnLogged) {
        // eslint-disable-next-line no-console
        console.warn(`[pglite] snapshot stale (schema hash mismatch) — using normal init. Rebuild with: bun run build:pglite-snapshot`);
        _snapshotWarnLogged = true;
      }
      return null;
    }
    const buf = fs.readFileSync(snapshotPath);
    return new Blob([buf]);
  } catch {
    // Any failure -> fall through to normal init. Never block tests.
    return null;
  }
}

export function computeSnapshotSchemaHash(
  migrations: Array<{ version: number; name: string; sql?: string; sqlFor?: { pglite?: string } }>,
  schemaSQL: string,
  crypto: typeof import('node:crypto'),
): string {
  const hash = crypto.createHash('sha256');
  hash.update('schema:');
  hash.update(schemaSQL);
  hash.update('\nmigrations:\n');
  for (const m of migrations) {
    hash.update(String(m.version));
    hash.update('\t');
    hash.update(m.name);
    hash.update('\t');
    hash.update(m.sql ?? '');
    hash.update('\t');
    hash.update(m.sqlFor?.pglite ?? '');
    hash.update('\n');
  }
  return hash.digest('hex');
}

export class PGLiteEngine implements BrainEngine {
  readonly kind = 'pglite' as const;
  private _db: PGLiteDB | null = null;
  private _lock: LockHandle | null = null;
  // Tier 3: when GBRAIN_PGLITE_SNAPSHOT loaded a post-initSchema state into
  // PGlite.create(loadDataDir), initSchema is a no-op (schema is already
  // present + migrations already applied). Saves ~1-3s per fresh test PGLite.
  private _snapshotLoaded = false;

  get db(): PGLiteDB {
    if (!this._db) throw new Error('PGLite not connected. Call connect() first.');
    return this._db;
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    const dataDir = config.database_path || undefined; // undefined = in-memory

    // Acquire file lock to prevent concurrent PGLite access (crashes with Aborted())
    this._lock = await acquireLock(dataDir);

    if (!this._lock.acquired) {
      throw new Error('Could not acquire PGLite lock. Another gbrain process is using the database.');
    }

    // Tier 3: optional snapshot fast-restore. Only applies to in-memory
    // engines (no persistent dataDir). The snapshot was built from a fresh
    // `initSchema()` run; if the version file matches the current MIGRATIONS
    // hash, load the dump and skip the schema replay. Mismatch or missing
    // file silently falls back to normal init.
    let loadDataDir: Blob | undefined;
    if (!dataDir && process.env.GBRAIN_PGLITE_SNAPSHOT) {
      const snapshotResult = tryLoadSnapshot(process.env.GBRAIN_PGLITE_SNAPSHOT);
      if (snapshotResult) {
        loadDataDir = snapshotResult;
        this._snapshotLoaded = true;
      }
    }

    try {
      this._db = await PGlite.create({
        dataDir,
        loadDataDir,
        extensions: { vector, pg_trgm },
      });
    } catch (err) {
      // v0.13.1: any PGLite.create() failure becomes actionable. Most commonly
      // this is the macOS 26.3 WASM bug (#223). We deliberately do NOT suggest
      // "missing migrations" as a cause — migrations run AFTER create(), so a
      // create-time abort has nothing to do with them. Nest the original error
      // message so debugging isn't erased.
      const original = err instanceof Error ? err.message : String(err);
      const wrapped = new Error(
        `PGLite failed to initialize its WASM runtime.\n` +
        `  This is most commonly the macOS 26.3 WASM bug: https://github.com/garrytan/gbrain/issues/223\n` +
        `  Run \`gbrain doctor\` for a full diagnosis.\n` +
        `  Original error: ${original}`
      );
      // Release the lock so a fresh process can try again; leaking the lock
      // here turns a recoverable init error into a stuck-brain state.
      if (this._lock?.acquired) {
        try { await releaseLock(this._lock); } catch { /* ignore cleanup error */ }
        this._lock = null;
      }
      throw wrapped;
    }
  }

  async disconnect(): Promise<void> {
    if (this._db) {
      await this._db.close();
      this._db = null;
    }
    if (this._lock?.acquired) {
      await releaseLock(this._lock);
      this._lock = null;
    }
  }

  async initSchema(): Promise<void> {
    // Tier 3: snapshot was loaded into PGlite — schema + migrations already
    // applied. Nothing to do. Returns immediately.
    if (this._snapshotLoaded) {
      return;
    }
    // Pre-schema bootstrap: add forward-referenced state the embedded schema
    // blob requires but that older brains don't have yet (issues #366/#375/
    // #378/#396 + #266/#357). Bootstrap is idempotent and a no-op on fresh
    // installs and modern brains.
    await this.applyForwardReferenceBootstrap();

    // Resolve embedding dim/model from gateway (v0.14+). Defaults preserve v0.13.
    let dims = 1536;
    let model = 'text-embedding-3-large';
    try {
      const gw = await import('./ai/gateway.ts');
      dims = gw.getEmbeddingDimensions();
      model = gw.getEmbeddingModel().split(':').slice(1).join(':') || model;
    } catch { /* gateway not configured — use defaults */ }

    await this.db.exec(getPGLiteSchema(dims, model));

    const { applied } = await runMigrations(this);
    if (applied > 0) {
      console.log(`  ${applied} migration(s) applied`);
    }
  }

  /**
   * Bootstrap state that PGLITE_SCHEMA_SQL forward-references but that older
   * brains don't have yet. Currently covers:
   *
   *   - `sources` table + default seed (FK target of pages.source_id) — v0.18
   *   - `pages.source_id` column (indexed by `idx_pages_source_id`) — v0.18
   *   - `links.link_source` column (indexed by `idx_links_source`) — v0.13
   *   - `links.origin_page_id` column (indexed by `idx_links_origin`) — v0.13
   *   - `content_chunks.symbol_name` column (indexed by `idx_chunks_symbol_name`) — v0.19
   *   - `content_chunks.language` column (indexed by `idx_chunks_language`) — v0.19
   *   - `pages.deleted_at` column (indexed by `pages_deleted_at_purge_idx`) — v0.26.5
   *
   * **Maintenance contract:** when a future migration adds a column-with-index
   * or new-table-with-FK referenced by PGLITE_SCHEMA_SQL, extend this method
   * AND `test/schema-bootstrap-coverage.test.ts`'s `REQUIRED_BOOTSTRAP_COVERAGE`.
   * The coverage test fails loudly if the bootstrap drifts behind the schema.
   */
  private async applyForwardReferenceBootstrap(): Promise<void> {
    // Single round-trip probe for every forward-reference target.
    const { rows } = await this.db.query(`
      SELECT
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='pages') AS pages_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='source_id') AS source_id_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='pages' AND column_name='deleted_at') AS deleted_at_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='links') AS links_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='links' AND column_name='link_source') AS link_source_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='links' AND column_name='origin_page_id') AS origin_page_id_exists,
        EXISTS (SELECT 1 FROM information_schema.tables
                WHERE table_schema='public' AND table_name='content_chunks') AS chunks_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='content_chunks' AND column_name='symbol_name') AS symbol_name_exists,
        EXISTS (SELECT 1 FROM information_schema.columns
                WHERE table_schema='public' AND table_name='content_chunks' AND column_name='language') AS language_exists
    `);
    const probe = rows[0] as {
      pages_exists: boolean;
      source_id_exists: boolean;
      deleted_at_exists: boolean;
      links_exists: boolean;
      link_source_exists: boolean;
      origin_page_id_exists: boolean;
      chunks_exists: boolean;
      symbol_name_exists: boolean;
      language_exists: boolean;
    };

    const needsPagesBootstrap = probe.pages_exists && !probe.source_id_exists;
    const needsLinksBootstrap = probe.links_exists
      && (!probe.link_source_exists || !probe.origin_page_id_exists);
    const needsChunksBootstrap = probe.chunks_exists
      && (!probe.symbol_name_exists || !probe.language_exists);
    const needsPagesDeletedAt = probe.pages_exists && !probe.deleted_at_exists;

    // Fresh installs (no tables yet) and modern brains both no-op.
    if (!needsPagesBootstrap && !needsLinksBootstrap && !needsChunksBootstrap && !needsPagesDeletedAt) return;

    console.log('  Pre-v0.21 brain detected, applying forward-reference bootstrap');

    if (needsPagesBootstrap) {
      // Mirror schema-embedded.ts shape for `sources` so the subsequent
      // PGLITE_SCHEMA_SQL CREATE TABLE IF NOT EXISTS is a true no-op.
      await this.db.exec(`
        CREATE TABLE IF NOT EXISTS sources (
          id            TEXT PRIMARY KEY,
          name          TEXT NOT NULL UNIQUE,
          local_path    TEXT,
          last_commit   TEXT,
          last_sync_at  TIMESTAMPTZ,
          config        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        );
        INSERT INTO sources (id, name, config)
          VALUES ('default', 'default', '{"federated": true}'::jsonb)
          ON CONFLICT (id) DO NOTHING;
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS source_id TEXT
          NOT NULL DEFAULT 'default' REFERENCES sources(id) ON DELETE CASCADE;
      `);
    }

    if (needsLinksBootstrap) {
      // v11 (links_provenance_columns) is responsible for the CHECK constraint
      // and backfill. The bootstrap only adds enough state for SCHEMA_SQL's
      // `CREATE INDEX idx_links_source/origin` not to crash. v11 runs later
      // via runMigrations and is idempotent (`IF NOT EXISTS` everywhere).
      await this.db.exec(`
        ALTER TABLE links ADD COLUMN IF NOT EXISTS link_source TEXT;
        ALTER TABLE links ADD COLUMN IF NOT EXISTS origin_page_id INTEGER
          REFERENCES pages(id) ON DELETE SET NULL;
      `);
    }

    if (needsChunksBootstrap) {
      // v26 (content_chunks_code_metadata) adds the full code-chunk metadata
      // surface (language, symbol_name, symbol_type, start_line, end_line).
      // The bootstrap only adds the two columns the schema blob's partial
      // indexes reference (idx_chunks_symbol_name, idx_chunks_language).
      // v26 runs later via runMigrations and adds the rest idempotently.
      await this.db.exec(`
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS language TEXT;
        ALTER TABLE content_chunks ADD COLUMN IF NOT EXISTS symbol_name TEXT;
      `);
    }

    if (needsPagesDeletedAt) {
      // v34 (destructive_guard_columns) adds the column + sources columns +
      // partial purge index. Bootstrap only adds enough for PGLITE_SCHEMA_SQL's
      // `CREATE INDEX pages_deleted_at_purge_idx ... WHERE deleted_at IS NOT NULL`
      // not to crash. v34 runs later via runMigrations and is idempotent.
      await this.db.exec(`
        ALTER TABLE pages ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ;
      `);
    }
  }

  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    // PGLite has no connection pool. The single backing connection is
    // always effectively reserved — pass it through.
    const db = this.db;
    const conn: ReservedConnection = {
      async executeRaw<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<R[]> {
        const { rows } = await db.query(sql, params);
        return rows as R[];
      },
    };
    return fn(conn);
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txEngine = Object.create(this) as PGLiteEngine;
      Object.defineProperty(txEngine, 'db', { get: () => tx });
      return fn(txEngine);
    });
  }

  // Pages CRUD
  async getPage(slug: string, opts?: { sourceId?: string; includeDeleted?: boolean }): Promise<Page | null> {
    // v0.26.5: hide soft-deleted by default; opt-in via opts.includeDeleted.
    const includeDeleted = opts?.includeDeleted === true;
    const sourceId = opts?.sourceId;
    const where: string[] = ['slug = $1'];
    const params: unknown[] = [slug];
    if (sourceId) {
      params.push(sourceId);
      where.push(`source_id = $${params.length}`);
    }
    if (!includeDeleted) {
      where.push('deleted_at IS NULL');
    }
    const { rows } = await this.db.query(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at, deleted_at
       FROM pages WHERE ${where.join(' AND ')} LIMIT 1`,
      params
    );
    if (rows.length === 0) return null;
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};

    // v0.18.0 Step 2: source_id relies on the schema DEFAULT 'default' so
    // existing callers still target the default source without threading
    // a parameter. ON CONFLICT target becomes (source_id, slug) since the
    // global UNIQUE(slug) was dropped in migration v17. Step 5+ will
    // surface an explicit sourceId param on putPage for multi-source sync.
    const pageKind = page.page_kind || 'markdown';
    const { rows } = await this.db.query(
      `INSERT INTO pages (slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
       ON CONFLICT (source_id, slug) DO UPDATE SET
         type = EXCLUDED.type,
         page_kind = EXCLUDED.page_kind,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         timeline = EXCLUDED.timeline,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         updated_at = now()
       RETURNING id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at`,
      [slug, page.type, pageKind, page.title, page.compiled_truth, page.timeline || '', JSON.stringify(frontmatter), hash]
    );
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async deletePage(slug: string): Promise<void> {
    await this.db.query('DELETE FROM pages WHERE slug = $1', [slug]);
  }

  async softDeletePage(slug: string, opts?: { sourceId?: string }): Promise<{ slug: string } | null> {
    // Idempotent-as-null: only flip rows currently active. Source filter is
    // optional; without it the first matching row across sources gets soft-deleted.
    const sourceId = opts?.sourceId;
    const where: string[] = ['slug = $1', 'deleted_at IS NULL'];
    const params: unknown[] = [slug];
    if (sourceId) {
      params.push(sourceId);
      where.push(`source_id = $${params.length}`);
    }
    const { rows } = await this.db.query(
      `UPDATE pages SET deleted_at = now() WHERE ${where.join(' AND ')} RETURNING slug`,
      params
    );
    if (rows.length === 0) return null;
    return { slug: (rows[0] as { slug: string }).slug };
  }

  async restorePage(slug: string, opts?: { sourceId?: string }): Promise<boolean> {
    const sourceId = opts?.sourceId;
    const where: string[] = ['slug = $1', 'deleted_at IS NOT NULL'];
    const params: unknown[] = [slug];
    if (sourceId) {
      params.push(sourceId);
      where.push(`source_id = $${params.length}`);
    }
    const { rows } = await this.db.query(
      `UPDATE pages SET deleted_at = NULL WHERE ${where.join(' AND ')} RETURNING slug`,
      params
    );
    return rows.length > 0;
  }

  async purgeDeletedPages(olderThanHours: number): Promise<{ slugs: string[]; count: number }> {
    // Clamp to non-negative integer; cascade through FKs (content_chunks,
    // page_links, chunk_relations) on DELETE.
    const hours = Math.max(0, Math.floor(olderThanHours));
    const { rows } = await this.db.query(
      `DELETE FROM pages
       WHERE deleted_at IS NOT NULL
         AND deleted_at < now() - ($1 || ' hours')::interval
       RETURNING slug`,
      [hours]
    );
    const slugs = (rows as { slug: string }[]).map((r) => r.slug);
    return { slugs, count: slugs.length };
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    const where: string[] = [];
    const params: unknown[] = [];
    const tagJoin = filters?.tag ? 'JOIN tags t ON t.page_id = p.id' : '';

    if (filters?.type) {
      params.push(filters.type);
      where.push(`p.type = $${params.length}`);
    }
    if (filters?.tag) {
      params.push(filters.tag);
      where.push(`t.tag = $${params.length}`);
    }
    if (filters?.updated_after) {
      params.push(filters.updated_after);
      where.push(`p.updated_at > $${params.length}::timestamptz`);
    }
    // slugPrefix uses the (source_id, slug) UNIQUE btree for index range scans.
    // Escape LIKE metacharacters so the user prefix is treated as a literal.
    if (filters?.slugPrefix) {
      const escaped = filters.slugPrefix.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      params.push(escaped);
      where.push(`p.slug LIKE $${params.length} ESCAPE '\\'`);
    }
    // v0.26.5: hide soft-deleted by default; opt in via filters.includeDeleted.
    if (filters?.includeDeleted !== true) {
      where.push('p.deleted_at IS NULL');
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit, offset);
    const limitSql = `LIMIT $${params.length - 1} OFFSET $${params.length}`;

    const { rows } = await this.db.query(
      `SELECT p.* FROM pages p ${tagJoin} ${whereSql}
       ORDER BY p.updated_at DESC ${limitSql}`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToPage);
  }

  async getAllSlugs(): Promise<Set<string>> {
    const { rows } = await this.db.query('SELECT slug FROM pages');
    return new Set((rows as { slug: string }[]).map(r => r.slug));
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    // Try exact match first
    const exact = await this.db.query('SELECT slug FROM pages WHERE slug = $1', [partial]);
    if (exact.rows.length > 0) return [(exact.rows[0] as { slug: string }).slug];

    // Fuzzy match via pg_trgm
    const { rows } = await this.db.query(
      `SELECT slug, similarity(title, $1) AS sim
       FROM pages
       WHERE title % $1 OR slug ILIKE $2
       ORDER BY sim DESC
       LIMIT 5`,
      [partial, '%' + partial + '%']
    );
    return (rows as { slug: string }[]).map(r => r.slug);
  }

  // Search
  //
  // v0.20.0 Cathedral II Layer 3 (1b): keyword search now ranks at
  // chunk-grain internally using content_chunks.search_vector, then dedups
  // to best-chunk-per-page on the way out. External shape (page-grain,
  // one row per matched page, best chunk selected) is identical to
  // v0.19.0 — backlinks, enrichment-service.countMentions, list_pages,
  // etc. all see the same contract. A2 two-pass (Layer 7) consumes
  // searchKeywordChunks for raw chunk-grain results without the dedup.
  //
  // The DISTINCT ON pattern is translated into a two-stage query because
  // PGLite's query planner handles CTEs-with-DISTINCT-ON less optimally
  // than direct window function + GROUP BY. Fetch more chunks than the
  // page limit (3x) to ensure N dedup'd pages survive; bounded and fast.
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Fetch 3x to give dedup headroom, then page-dedup + re-limit.
    const innerLimit = Math.min(limit * 3, MAX_SEARCH_LIMIT * 3);

    // Source-aware ranking (v0.22): see postgres-engine.ts for rationale.
    const boostMap = resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);

    // v0.20.0 Cathedral II Layer 10 C1/C2: language + symbol-kind filters.
    const params: unknown[] = [query, innerLimit, limit, offset];
    let extraFilter = '';
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }

    // v0.26.5: visibility filter (soft-deleted + archived-source).
    const visibilityClause = buildVisibilityClause('p', 's');

    const { rows } = await this.db.query(
      `WITH ranked AS (
         SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           ts_rank(cc.search_vector, websearch_to_tsquery('english', $1)) * ${sourceFactorCase} AS score,
           CASE WHEN p.updated_at < (
             SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
           ) THEN true ELSE false END AS stale
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE cc.search_vector @@ websearch_to_tsquery('english', $1) ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
         ORDER BY score DESC
         LIMIT $2
       ),
       best_per_page AS (
         SELECT DISTINCT ON (slug) *
         FROM ranked
         ORDER BY slug, score DESC
       )
       SELECT * FROM best_per_page
       ORDER BY score DESC
       LIMIT $3 OFFSET $4`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  /**
   * v0.20.0 Cathedral II Layer 3 (1b) chunk-grain keyword search.
   *
   * Ranks at chunk grain via content_chunks.search_vector WITHOUT the
   * dedup-to-page pass that searchKeyword applies on return. Used by
   * A2 two-pass retrieval (Layer 7) as the anchor-discovery primitive:
   * two-pass wants the top-N chunks (regardless of page), not the
   * best chunk per top-N pages.
   *
   * Most callers should prefer searchKeyword (external page-grain
   * contract). This method is intentionally a narrow internal knob.
   */
  async searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Source-aware ranking applied here too — searchKeywordChunks is the
    // chunk-grain anchor primitive that two-pass retrieval (Layer 7) uses.
    const boostMap = resolveBoostMap();
    const sourceFactorCase = buildSourceFactorCase('p.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);

    const params: unknown[] = [query, limit, offset];
    let extraFilter = '';
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }

    // v0.26.5: visibility filter for the chunk-grain anchor primitive.
    const visibilityClause = buildVisibilityClause('p', 's');

    const { rows } = await this.db.query(
      `SELECT
         p.slug, p.id as page_id, p.title, p.type, p.source_id,
         cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
         ts_rank(cc.search_vector, websearch_to_tsquery('english', $1)) * ${sourceFactorCase} AS score,
         CASE WHEN p.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
         ) THEN true ELSE false END AS stale
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       JOIN sources s ON s.id = p.source_id
       WHERE cc.search_vector @@ websearch_to_tsquery('english', $1) ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
       ORDER BY score DESC
       LIMIT $2 OFFSET $3`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const vecStr = '[' + Array.from(embedding).join(',') + ']';
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    // Two-stage CTE (v0.22): pure-distance ORDER BY in inner CTE preserves
    // HNSW; outer SELECT re-ranks by raw_score * source_factor over the
    // narrow candidate pool. innerLimit scales with offset to preserve the
    // pagination contract. See postgres-engine.ts searchVector for rationale.
    const boostMap = resolveBoostMap();
    // Outer SELECT references the aliased CTE column. Aliasing the CTE as `hc`
    // disambiguates the correlated subquery (`te.page_id = hc.page_id`) from
    // the inner column. Without the alias, an unqualified `page_id` in the
    // subquery's WHERE would lexically resolve back to `te.page_id` itself
    // and degrade to `te.page_id = te.page_id` (always true), making every
    // result stale=true. Codex caught this in adversarial review.
    const sourceFactorCaseOnSlug = buildSourceFactorCase('hc.slug', boostMap, opts?.detail);
    const hardExcludePrefixes = resolveHardExcludes(opts?.exclude_slug_prefixes, opts?.include_slug_prefixes);
    const hardExcludeClause = buildHardExcludeClause('p.slug', hardExcludePrefixes);
    const innerLimit = offset + Math.max(limit * 5, 100);

    const params: unknown[] = [vecStr, innerLimit, limit, offset];
    let extraFilter = '';
    if (opts?.language) {
      params.push(opts.language);
      extraFilter += ` AND cc.language = $${params.length}`;
    }
    if (opts?.symbolKind) {
      params.push(opts.symbolKind);
      extraFilter += ` AND cc.symbol_type = $${params.length}`;
    }

    // v0.26.5: visibility filter applied in the inner CTE so HNSW sees the
    // same candidate count it always did. See postgres-engine.ts for rationale.
    const visibilityClause = buildVisibilityClause('p', 's');

    const { rows } = await this.db.query(
      `WITH hnsw_candidates AS (
         SELECT
           p.slug, p.id as page_id, p.title, p.type, p.source_id, p.updated_at,
           cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
           1 - (cc.embedding <=> $1::vector) AS raw_score
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
         JOIN sources s ON s.id = p.source_id
         WHERE cc.embedding IS NOT NULL ${detailFilter}${extraFilter} ${hardExcludeClause} ${visibilityClause}
         ORDER BY cc.embedding <=> $1::vector
         LIMIT $2
       )
       SELECT
         hc.slug, hc.page_id, hc.title, hc.type, hc.source_id,
         hc.chunk_id, hc.chunk_index, hc.chunk_text, hc.chunk_source,
         hc.raw_score * ${sourceFactorCaseOnSlug} AS score,
         CASE WHEN hc.updated_at < (
           SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = hc.page_id
         ) THEN true ELSE false END AS stale
       FROM hnsw_candidates hc
       ORDER BY score DESC
       LIMIT $3
       OFFSET $4`,
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
  }

  async getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const { rows } = await this.db.query(
      `SELECT id, embedding FROM content_chunks WHERE id = ANY($1::int[]) AND embedding IS NOT NULL`,
      [ids]
    );
    const result = new Map<number, Float32Array>();
    for (const row of rows as Record<string, unknown>[]) {
      if (row.embedding) {
        const emb = typeof row.embedding === 'string'
          ? new Float32Array(JSON.parse(row.embedding))
          : row.embedding as Float32Array;
        result.set(row.id as number, emb);
      }
    }
    return result;
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    // Get page_id
    const pageResult = await this.db.query('SELECT id FROM pages WHERE slug = $1', [slug]);
    if (pageResult.rows.length === 0) throw new Error(`Page not found: ${slug}`);
    const pageId = (pageResult.rows[0] as { id: number }).id;

    // Remove chunks that no longer exist
    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      // PGLite doesn't auto-serialize arrays, so use ANY with explicit array cast
      await this.db.query(
        `DELETE FROM content_chunks WHERE page_id = $1 AND chunk_index != ALL($2::int[])`,
        [pageId, newIndices]
      );
    } else {
      await this.db.query('DELETE FROM content_chunks WHERE page_id = $1', [pageId]);
      return;
    }

    // Batch upsert: build dynamic multi-row INSERT.
    // v0.19.0: includes language/symbol_name/symbol_type/start_line/end_line
    // so code chunks carry their tree-sitter metadata into the DB. Markdown
    // chunks pass NULL for all five. Order must match the column list.
    // v0.20.0 Cathedral II Layer 6: adds parent_symbol_path / doc_comment /
    // symbol_name_qualified so nested-chunk emission (A3) and eventual A1
    // edge resolution can round-trip metadata through upserts.
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified)';
    const rowParts: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;
      const parentPath = chunk.parent_symbol_path && chunk.parent_symbol_path.length > 0
        ? chunk.parent_symbol_path
        : null;

      if (embeddingStr) {
        rowParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++}, $${paramIdx++}, now(), $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::text[], $${paramIdx++}, $${paramIdx++})`);
        params.push(
          pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
          embeddingStr, chunk.model || 'text-embedding-3-large', chunk.token_count || null,
          chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
          chunk.start_line ?? null, chunk.end_line ?? null,
          parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
        );
      } else {
        rowParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::text[], $${paramIdx++}, $${paramIdx++})`);
        params.push(
          pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
          chunk.model || 'text-embedding-3-large', chunk.token_count || null,
          chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
          chunk.start_line ?? null, chunk.end_line ?? null,
          parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
        );
      }
    }

    // CONSISTENCY: when chunk_text changes and no new embedding is supplied, BOTH embedding AND
    // embedded_at must reset to NULL so `embed --stale` correctly picks up the row for re-embedding.
    // See postgres-engine.ts upsertChunks for the full rationale — pglite mirrors it for parity.
    await this.db.query(
      `INSERT INTO content_chunks ${cols} VALUES ${rowParts.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedding ELSE COALESCE(EXCLUDED.embedding, content_chunks.embedding) END,
         model = COALESCE(EXCLUDED.model, content_chunks.model),
         token_count = EXCLUDED.token_count,
         embedded_at = CASE
           WHEN EXCLUDED.chunk_text != content_chunks.chunk_text AND EXCLUDED.embedding IS NULL THEN NULL
           ELSE COALESCE(EXCLUDED.embedded_at, content_chunks.embedded_at)
         END,
         language = EXCLUDED.language,
         symbol_name = EXCLUDED.symbol_name,
         symbol_type = EXCLUDED.symbol_type,
         start_line = EXCLUDED.start_line,
         end_line = EXCLUDED.end_line,
         parent_symbol_path = EXCLUDED.parent_symbol_path,
         doc_comment = EXCLUDED.doc_comment,
         symbol_name_qualified = EXCLUDED.symbol_name_qualified`,
      params
    );
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const { rows } = await this.db.query(
      `SELECT cc.* FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1
       ORDER BY cc.chunk_index`,
      [slug]
    );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r));
  }

  async countStaleChunks(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT count(*)::int AS count
         FROM content_chunks
        WHERE embedding IS NULL`,
    );
    const count = (rows[0] as { count: number } | undefined)?.count ?? 0;
    return Number(count);
  }

  async listStaleChunks(): Promise<StaleChunkRow[]> {
    const { rows } = await this.db.query(
      `SELECT p.slug, cc.chunk_index, cc.chunk_text, cc.chunk_source,
              cc.model, cc.token_count
         FROM content_chunks cc
         JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NULL
        ORDER BY p.id, cc.chunk_index
        LIMIT 100000`,
    );
    return rows as unknown as StaleChunkRow[];
  }

  async deleteChunks(slug: string): Promise<void> {
    await this.db.query(
      `DELETE FROM content_chunks
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`,
      [slug]
    );
  }

  // Links
  async addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
  ): Promise<void> {
    const src = linkSource ?? 'markdown';
    await this.db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
       SELECT f.id, t.id, $3, $4, $5,
              (SELECT id FROM pages WHERE slug = $6),
              $7
       FROM pages f, pages t
       WHERE f.slug = $1 AND t.slug = $2
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
         context = EXCLUDED.context,
         origin_field = EXCLUDED.origin_field`,
      [from, to, linkType || '', context || '', src, originSlug ?? null, originField ?? null]
    );
  }

  async addLinksBatch(links: LinkBatchInput[]): Promise<number> {
    if (links.length === 0) return 0;
    // unnest() pattern: 10 array-typed bound parameters regardless of batch
    // size. Same shape as PostgresEngine (v0.18). Avoids the 65535-parameter
    // cap.
    //
    // v0.18.0: every JOIN composite-keys on (slug, source_id) so the batch
    // can't fan out across sources when the same slug exists in multiple
    // sources. Origin JOIN uses LEFT JOIN on a composite key — NULL
    // origin_slug leaves origin_page_id NULL, same as pre-v0.18.
    const fromSlugs = links.map(l => l.from_slug);
    const toSlugs = links.map(l => l.to_slug);
    const linkTypes = links.map(l => l.link_type || '');
    const contexts = links.map(l => l.context || '');
    const linkSources = links.map(l => l.link_source || 'markdown');
    const originSlugs = links.map(l => l.origin_slug || null);
    const originFields = links.map(l => l.origin_field || null);
    const fromSourceIds = links.map(l => l.from_source_id || 'default');
    const toSourceIds = links.map(l => l.to_source_id || 'default');
    const originSourceIds = links.map(l => l.origin_source_id || 'default');
    const result = await this.db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
       SELECT f.id, t.id, v.link_type, v.context, v.link_source, o.id, v.origin_field
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[], $7::text[], $8::text[], $9::text[], $10::text[])
         AS v(from_slug, to_slug, link_type, context, link_source, origin_slug, origin_field, from_source_id, to_source_id, origin_source_id)
       JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
       JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
       LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
       ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO NOTHING
       RETURNING 1`,
      [fromSlugs, toSlugs, linkTypes, contexts, linkSources, originSlugs, originFields, fromSourceIds, toSourceIds, originSourceIds]
    );
    return result.rows.length;
  }

  async removeLink(from: string, to: string, linkType?: string, linkSource?: string): Promise<void> {
    if (linkType !== undefined && linkSource !== undefined) {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $2)
           AND link_type = $3
           AND link_source IS NOT DISTINCT FROM $4`,
        [from, to, linkType, linkSource]
      );
    } else if (linkType !== undefined) {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $2)
           AND link_type = $3`,
        [from, to, linkType]
      );
    } else if (linkSource !== undefined) {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $2)
           AND link_source IS NOT DISTINCT FROM $3`,
        [from, to, linkSource]
      );
    } else {
      await this.db.query(
        `DELETE FROM links
         WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)
           AND to_page_id = (SELECT id FROM pages WHERE slug = $2)`,
        [from, to]
      );
    }
  }

  async getLinks(slug: string): Promise<Link[]> {
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug,
              l.link_type, l.context, l.link_source,
              o.slug as origin_slug, l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE f.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug,
              l.link_type, l.context, l.link_source,
              o.slug as origin_slug, l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE t.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
  ): Promise<{ slug: string; similarity: number } | null> {
    // Inline threshold comparison instead of `SET LOCAL pg_trgm.similarity_threshold`.
    // The GUC only scopes to the current transaction and pglite auto-commits each
    // .query() call, so the SET LOCAL would be a no-op. Using similarity() >= $N
    // directly gives predictable behavior. Tie-breaker: sort by slug so re-runs
    // pick the same winner.
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const { rows } = await this.db.query(
      `SELECT slug, similarity(title, $1) AS sim
       FROM pages
       WHERE similarity(title, $1) >= $3
         AND slug LIKE $2
       ORDER BY sim DESC, slug ASC
       LIMIT 1`,
      [name, prefixPattern, minSimilarity]
    );
    if (rows.length === 0) return null;
    const row = rows[0] as { slug: string; sim: number };
    return { slug: row.slug, similarity: row.sim };
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    // Cycle prevention: visited array tracks page IDs already in the path.
    // Prevents exponential blowup on cyclic subgraphs (e.g., A->B->A).
    const { rows } = await this.db.query(
      `WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth, ARRAY[p.id] as visited
        FROM pages p WHERE p.slug = $1

        UNION ALL

        SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < $2
          AND NOT (p2.id = ANY(g.visited))
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        coalesce(
          -- jsonb_agg(DISTINCT ...) collapses duplicate (to_slug, link_type)
          -- edges that originate from different provenance (markdown body
          -- vs frontmatter vs auto-extracted). Presentation-only dedup;
          -- the links table still preserves every provenance row. See
          -- plan Bug 6/10.
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id),
          '[]'::jsonb
        ) as links
      FROM graph g
      ORDER BY g.depth, g.slug`,
      [slug, depth]
    );

    return (rows as Record<string, unknown>[]).map(r => ({
      slug: r.slug as string,
      title: r.title as string,
      type: r.type as PageType,
      depth: r.depth as number,
      links: (typeof r.links === 'string' ? JSON.parse(r.links) : r.links) as { to_slug: string; link_type: string }[],
    }));
  }

  async traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<GraphPath[]> {
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const linkTypeWhere = linkType !== null ? 'AND l.link_type = $3' : '';
    const params: unknown[] = [slug, depth];
    if (linkType !== null) params.push(linkType);

    let sql: string;
    if (direction === 'out') {
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.from_page_id = w.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            ${linkTypeWhere}
        )
        SELECT w.slug AS from_slug, p2.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < $2
          ${linkTypeWhere}
        ORDER BY depth, from_slug, to_slug
      `;
    } else if (direction === 'in') {
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.to_page_id = w.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            ${linkTypeWhere}
        )
        SELECT p2.slug AS from_slug, w.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < $2
          ${linkTypeWhere}
        ORDER BY depth, from_slug, to_slug
      `;
    } else {
      // both: walk in both directions, emit every traversed edge (preserving its
      // natural from->to direction from the links table).
      sql = `
        WITH RECURSIVE walk AS (
          SELECT p.id, 0::int AS depth, ARRAY[p.id] AS visited
          FROM pages p WHERE p.slug = $1
          UNION ALL
          SELECT p2.id, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth < $2
            AND NOT (p2.id = ANY(w.visited))
            ${linkTypeWhere}
        )
        SELECT pf.slug AS from_slug, pt.slug AS to_slug,
               l.link_type, l.context, w.depth + 1 AS depth
        FROM walk w
        JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
        JOIN pages pf ON pf.id = l.from_page_id
        JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < $2
          ${linkTypeWhere}
        ORDER BY depth, from_slug, to_slug
      `;
    }

    const { rows } = await this.db.query(sql, params);
    // Dedup edges (same from/to/type/depth can appear via multiple visited paths).
    const seen = new Set<string>();
    const result: GraphPath[] = [];
    for (const r of rows as Record<string, unknown>[]) {
      const key = `${r.from_slug}|${r.to_slug}|${r.link_type}|${r.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        from_slug: r.from_slug as string,
        to_slug: r.to_slug as string,
        link_type: r.link_type as string,
        context: (r.context as string) || '',
        depth: r.depth as number,
      });
    }
    return result;
  }

  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    // Initialize all slugs to 0 so callers get a consistent map.
    for (const s of slugs) result.set(s, 0);

    // PGLite needs explicit cast for array binding (does not auto-serialize JS arrays).
    const { rows } = await this.db.query(
      `SELECT p.slug AS slug, COUNT(l.id)::int AS cnt
       FROM pages p
       LEFT JOIN links l ON l.to_page_id = p.id
       WHERE p.slug = ANY($1::text[])
       GROUP BY p.slug`,
      [slugs]
    );
    for (const r of rows as { slug: string; cnt: number }[]) {
      result.set(r.slug, Number(r.cnt));
    }
    return result;
  }

  async findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>> {
    const { rows } = await this.db.query(
      `SELECT
         p.slug,
         COALESCE(p.title, p.slug) AS title,
         p.frontmatter->>'domain' AS domain
       FROM pages p
       WHERE NOT EXISTS (
         SELECT 1 FROM links l WHERE l.to_page_id = p.id
       )
       ORDER BY p.slug`
    );
    return rows as Array<{ slug: string; title: string; domain: string | null }>;
  }

  // Tags
  async addTag(slug: string, tag: string): Promise<void> {
    await this.db.query(
      `INSERT INTO tags (page_id, tag)
       SELECT id, $2 FROM pages WHERE slug = $1
       ON CONFLICT (page_id, tag) DO NOTHING`,
      [slug, tag]
    );
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    await this.db.query(
      `DELETE FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)
         AND tag = $2`,
      [slug, tag]
    );
  }

  async getTags(slug: string): Promise<string[]> {
    const { rows } = await this.db.query(
      `SELECT tag FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)
       ORDER BY tag`,
      [slug]
    );
    return (rows as { tag: string }[]).map(r => r.tag);
  }

  // Timeline
  async addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean },
  ): Promise<void> {
    if (!opts?.skipExistenceCheck) {
      const { rows } = await this.db.query('SELECT 1 FROM pages WHERE slug = $1', [slug]);
      if (rows.length === 0) {
        throw new Error(`Page not found: ${slug}`);
      }
    }
    // ON CONFLICT DO NOTHING via the (page_id, date, summary) unique index.
    // If insert is a no-op (duplicate), no row is returned; that's intentional.
    await this.db.query(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT id, $2::date, $3, $4, $5
       FROM pages WHERE slug = $1
       ON CONFLICT (page_id, date, summary) DO NOTHING`,
      [slug, entry.date, entry.source || '', entry.summary, entry.detail || '']
    );
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number> {
    if (entries.length === 0) return 0;
    const slugs = entries.map(e => e.slug);
    const dates = entries.map(e => e.date);
    const sources = entries.map(e => e.source || '');
    const summaries = entries.map(e => e.summary);
    const details = entries.map(e => e.detail || '');
    const sourceIds = entries.map(e => e.source_id || 'default');
    const result = await this.db.query(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT p.id, v.date::date, v.source, v.summary, v.detail
       FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::text[])
         AS v(slug, date, source, summary, detail, source_id)
       JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id
       ON CONFLICT (page_id, date, summary) DO NOTHING
       RETURNING 1`,
      [slugs, dates, sources, summaries, details, sourceIds]
    );
    return result.rows.length;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const limit = opts?.limit || 100;

    let result;
    if (opts?.after && opts?.before) {
      result = await this.db.query(
        `SELECT te.* FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
         WHERE p.slug = $1 AND te.date >= $2::date AND te.date <= $3::date
         ORDER BY te.date DESC LIMIT $4`,
        [slug, opts.after, opts.before, limit]
      );
    } else if (opts?.after) {
      result = await this.db.query(
        `SELECT te.* FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
         WHERE p.slug = $1 AND te.date >= $2::date
         ORDER BY te.date DESC LIMIT $3`,
        [slug, opts.after, limit]
      );
    } else {
      result = await this.db.query(
        `SELECT te.* FROM timeline_entries te
         JOIN pages p ON p.id = te.page_id
         WHERE p.slug = $1
         ORDER BY te.date DESC LIMIT $2`,
        [slug, limit]
      );
    }

    return result.rows as unknown as TimelineEntry[];
  }

  // Raw data
  async putRawData(slug: string, source: string, data: object): Promise<void> {
    await this.db.query(
      `INSERT INTO raw_data (page_id, source, data)
       SELECT id, $2, $3::jsonb
       FROM pages WHERE slug = $1
       ON CONFLICT (page_id, source) DO UPDATE SET
         data = EXCLUDED.data,
         fetched_at = now()`,
      [slug, source, JSON.stringify(data)]
    );
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    let result;
    if (source) {
      result = await this.db.query(
        `SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
         JOIN pages p ON p.id = rd.page_id
         WHERE p.slug = $1 AND rd.source = $2`,
        [slug, source]
      );
    } else {
      result = await this.db.query(
        `SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
         JOIN pages p ON p.id = rd.page_id
         WHERE p.slug = $1`,
        [slug]
      );
    }
    return result.rows as unknown as RawData[];
  }

  // Dream-cycle significance verdict cache (v0.23).
  async getDreamVerdict(filePath: string, contentHash: string): Promise<DreamVerdict | null> {
    const result = await this.db.query<{
      worth_processing: boolean;
      reasons: string[] | null;
      judged_at: Date | string;
    }>(
      `SELECT worth_processing, reasons, judged_at
       FROM dream_verdicts
       WHERE file_path = $1 AND content_hash = $2`,
      [filePath, contentHash]
    );
    if (result.rows.length === 0) return null;
    const r = result.rows[0];
    return {
      worth_processing: r.worth_processing,
      reasons: r.reasons ?? [],
      judged_at: r.judged_at instanceof Date ? r.judged_at.toISOString() : String(r.judged_at),
    };
  }

  async putDreamVerdict(filePath: string, contentHash: string, verdict: DreamVerdictInput): Promise<void> {
    await this.db.query(
      `INSERT INTO dream_verdicts (file_path, content_hash, worth_processing, reasons)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (file_path, content_hash) DO UPDATE SET
         worth_processing = EXCLUDED.worth_processing,
         reasons = EXCLUDED.reasons,
         judged_at = now()`,
      [filePath, contentHash, verdict.worth_processing, JSON.stringify(verdict.reasons)]
    );
  }

  // Versions
  async createVersion(slug: string): Promise<PageVersion> {
    const { rows } = await this.db.query(
      `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
       SELECT id, compiled_truth, frontmatter
       FROM pages WHERE slug = $1
       RETURNING *`,
      [slug]
    );
    return rows[0] as unknown as PageVersion;
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    const { rows } = await this.db.query(
      `SELECT pv.* FROM page_versions pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = $1
       ORDER BY pv.snapshot_at DESC`,
      [slug]
    );
    return rows as unknown as PageVersion[];
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    await this.db.query(
      `UPDATE pages SET
        compiled_truth = pv.compiled_truth,
        frontmatter = pv.frontmatter,
        updated_at = now()
      FROM page_versions pv
      WHERE pages.slug = $1 AND pv.id = $2 AND pv.page_id = pages.id`,
      [slug, versionId]
    );
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const { rows: [stats] } = await this.db.query(`
      SELECT
        -- v0.26.5: exclude soft-deleted from page_count (mirrors postgres-engine).
        (SELECT count(*) FROM pages WHERE deleted_at IS NULL) as page_count,
        (SELECT count(*) FROM content_chunks) as chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT tag) FROM tags) as tag_count,
        (SELECT count(*) FROM timeline_entries) as timeline_entry_count
    `);

    const { rows: types } = await this.db.query(
      `SELECT type, count(*)::int as count FROM pages GROUP BY type ORDER BY count DESC`
    );
    const pages_by_type: Record<string, number> = {};
    for (const t of types as { type: string; count: number }[]) {
      pages_by_type[t.type] = t.count;
    }

    const s = stats as Record<string, unknown>;
    return {
      page_count: Number(s.page_count),
      chunk_count: Number(s.chunk_count),
      embedded_count: Number(s.embedded_count),
      link_count: Number(s.link_count),
      tag_count: Number(s.tag_count),
      timeline_entry_count: Number(s.timeline_entry_count),
      pages_by_type,
    };
  }

  async getHealth(): Promise<BrainHealth> {
    // Combined metrics from master (brain_score components: dead_links, link_count,
    // pages_with_timeline) and v0.10.3 graph layer (link_coverage, timeline_coverage,
    // most_connected). Both coexist: master's brain_score is the composite
    // dashboard, v0.10.3 metrics give entity-page-level granularity.
    const { rows: [h] } = await this.db.query(`
      WITH entity_pages AS (
        SELECT id, slug FROM pages WHERE type IN ('person', 'company')
      )
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL)::float /
          GREATEST((SELECT count(*) FROM content_chunks), 1)::float as embed_coverage,
        (SELECT count(*) FROM pages p
         WHERE p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id)
        ) as stale_pages,
        -- Bug 11 — orphan = islanded (no inbound AND no outbound).
        -- See BrainHealth.orphan_pages docstring; docs updated to match this.
        (SELECT count(*) FROM pages p
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)
        ) as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
        ) as dead_links,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NULL) as missing_embeddings,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT page_id) FROM timeline_entries) as pages_with_timeline,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as link_coverage,
        (SELECT count(*) FROM entity_pages e
         WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id))::float /
          GREATEST((SELECT count(*) FROM entity_pages), 1)::float as timeline_coverage
    `);

    // Top 5 most connected entities by total link count (in + out).
    const { rows: connected } = await this.db.query(`
      SELECT p.slug,
             (SELECT count(*) FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id)::int as link_count
      FROM pages p
      WHERE p.type IN ('person', 'company')
      ORDER BY link_count DESC
      LIMIT 5
    `);

    const r = h as Record<string, unknown>;
    const pageCount = Number(r.page_count);
    const embedCoverage = Number(r.embed_coverage);
    const orphanPages = Number(r.orphan_pages);
    const deadLinks = Number(r.dead_links);
    const linkCount = Number(r.link_count);
    const pagesWithTimeline = Number(r.pages_with_timeline);

    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    const timelineCoverageDensity = pageCount > 0 ? Math.min(pagesWithTimeline / pageCount, 1) : 0;
    const noOrphans = pageCount > 0 ? 1 - (orphanPages / pageCount) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
    // Bug 11 — per-component points. Sum equals brainScore by construction
    // so `doctor` can render a breakdown that adds up to the total.
    const embedCoverageScore = pageCount === 0 ? 0 : Math.round(embedCoverage * 35);
    const linkDensityScore = pageCount === 0 ? 0 : Math.round(linkDensity * 25);
    const timelineCoverageScore = pageCount === 0 ? 0 : Math.round(timelineCoverageDensity * 15);
    const noOrphansScore = pageCount === 0 ? 0 : Math.round(noOrphans * 15);
    const noDeadLinksScore = pageCount === 0 ? 0 : Math.round(noDeadLinks * 10);
    const brainScore = embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore;

    return {
      page_count: pageCount,
      embed_coverage: embedCoverage,
      stale_pages: Number(r.stale_pages),
      orphan_pages: orphanPages,
      missing_embeddings: Number(r.missing_embeddings),
      brain_score: brainScore,
      dead_links: deadLinks,
      link_coverage: Number(r.link_coverage),
      timeline_coverage: Number(r.timeline_coverage),
      most_connected: (connected as { slug: string; link_count: number }[]).map(c => ({
        slug: c.slug,
        link_count: Number(c.link_count),
      })),
      embed_coverage_score: embedCoverageScore,
      link_density_score: linkDensityScore,
      timeline_coverage_score: timelineCoverageScore,
      no_orphans_score: noOrphansScore,
      no_dead_links_score: noDeadLinksScore,
    };
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    await this.db.query(
      `INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
       VALUES ($1, $2, $3::jsonb, $4)`,
      [entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary]
    );
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 50;
    const { rows } = await this.db.query(
      `SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT $1`,
      [limit]
    );
    return rows as unknown as IngestLogEntry[];
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    newSlug = validateSlug(newSlug);
    await this.db.query(
      `UPDATE pages SET slug = $1, updated_at = now() WHERE slug = $2`,
      [newSlug, oldSlug]
    );
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub: links use integer page_id FKs, already correct after updateSlug.
  }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const { rows } = await this.db.query('SELECT value FROM config WHERE key = $1', [key]);
    return rows.length > 0 ? (rows[0] as { value: string }).value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    await this.db.query(
      `INSERT INTO config (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
      [key, value]
    );
  }

  // Migration support
  async runMigration(_version: number, sql: string): Promise<void> {
    await this.db.exec(sql);
  }

  async getChunksWithEmbeddings(slug: string): Promise<Chunk[]> {
    const { rows } = await this.db.query(
      `SELECT cc.* FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = $1
       ORDER BY cc.chunk_index`,
      [slug]
    );
    return (rows as Record<string, unknown>[]).map(r => rowToChunk(r, true));
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const { rows } = await this.db.query(sql, params);
    return rows as T[];
  }

  // ============================================================
  // v0.20.0 Cathedral II: code edges (Layer 1 stubs — filled by Layer 5)
  // ============================================================
  // Declared here so the interface contract is satisfied and consumers can
  // import against them. Implementations throw until the edge extractor +
  // per-lang tree-sitter queries land in Layer 5/6.
  // ============================================================

  async addCodeEdges(edges: import('./types.ts').CodeEdgeInput[]): Promise<number> {
    if (edges.length === 0) return 0;
    let inserted = 0;
    // Split into resolved vs unresolved. Resolved rows carry to_chunk_id
    // (known target chunk); unresolved rows only know the qualified name.
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    if (resolved.length > 0) {
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of resolved) {
        rowParts.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.to_chunk_id, e.from_symbol_qualified,
          e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? null,
        );
      }
      const res = await this.db.query(
        `INSERT INTO code_edges_chunk
           (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_chunk_id, edge_type) DO NOTHING`,
        params,
      );
      inserted += res.affectedRows ?? 0;
    }
    if (unresolved.length > 0) {
      const rowParts: string[] = [];
      const params: unknown[] = [];
      let p = 1;
      for (const e of unresolved) {
        rowParts.push(`($${p++}, $${p++}, $${p++}, $${p++}, $${p++}::jsonb, $${p++})`);
        params.push(
          e.from_chunk_id, e.from_symbol_qualified, e.to_symbol_qualified, e.edge_type,
          JSON.stringify(e.edge_metadata ?? {}),
          e.source_id ?? null,
        );
      }
      const res = await this.db.query(
        `INSERT INTO code_edges_symbol
           (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
         VALUES ${rowParts.join(', ')}
         ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type) DO NOTHING`,
        params,
      );
      inserted += res.affectedRows ?? 0;
    }
    return inserted;
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    // Both directions on code_edges_chunk; from-only on code_edges_symbol
    // (unresolved edges don't have a to_chunk_id to match against).
    await this.db.query(
      `DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY($1::int[]) OR to_chunk_id = ANY($1::int[])`,
      [chunkIds],
    );
    await this.db.query(
      `DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY($1::int[])`,
      [chunkIds],
    );
  }

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId
      ? ''
      : `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`;
    const { rows } = await this.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         WHERE to_symbol_qualified = $1 ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, false as resolved
         FROM code_edges_symbol
         WHERE to_symbol_qualified = $1 ${sourceClause}
       LIMIT $2`,
      [qualifiedName, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const limit = Math.min(opts?.limit ?? 100, 500);
    const sourceClause = opts?.allSources || !opts?.sourceId
      ? ''
      : `AND source_id = '${opts.sourceId.replace(/'/g, "''")}'`;
    const { rows } = await this.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         WHERE from_symbol_qualified = $1 ${sourceClause}
       UNION ALL
       SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, false as resolved
         FROM code_edges_symbol
         WHERE from_symbol_qualified = $1 ${sourceClause}
       LIMIT $2`,
      [qualifiedName, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const edgeTypeClause = opts?.edgeType ? `AND edge_type = '${opts.edgeType.replace(/'/g, "''")}'` : '';
    // Build the chunk-table filter based on direction. Unresolved edges
    // (code_edges_symbol) only carry from_chunk_id — there's no inbound
    // direction into them from a chunk ID, so we include them only when
    // direction is 'out' or 'both'.
    let chunkFilter = '';
    if (direction === 'in') chunkFilter = `WHERE to_chunk_id = $1`;
    else if (direction === 'out') chunkFilter = `WHERE from_chunk_id = $1`;
    else chunkFilter = `WHERE from_chunk_id = $1 OR to_chunk_id = $1`;

    let symbolFilter = '';
    if (direction === 'out' || direction === 'both') {
      symbolFilter = `WHERE from_chunk_id = $1`;
    }

    const unionClause = symbolFilter ? `
      UNION ALL
      SELECT id, from_chunk_id, NULL as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        ${symbolFilter} ${edgeTypeClause}
    ` : '';

    const { rows } = await this.db.query(
      `SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
              edge_type, edge_metadata, source_id, true as resolved
         FROM code_edges_chunk
         ${chunkFilter} ${edgeTypeClause}
       ${unionClause}
       LIMIT $2`,
      [chunkId, limit],
    );
    return (rows as Record<string, unknown>[]).map(rowToCodeEdge);
  }

  // Eval capture (v0.25.0). See BrainEngine interface docs.
  async logEvalCandidate(input: EvalCandidateInput): Promise<number> {
    const { rows } = await this.db.query<{ id: number }>(
      `INSERT INTO eval_candidates (
         tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
         expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
         latency_ms, remote, job_id, subagent_id
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING id`,
      [
        input.tool_name,
        input.query,
        input.retrieved_slugs,
        input.retrieved_chunk_ids,
        input.source_ids,
        input.expand_enabled,
        input.detail,
        input.detail_resolved,
        input.vector_enabled,
        input.expansion_applied,
        input.latency_ms,
        input.remote,
        input.job_id,
        input.subagent_id,
      ]
    );
    return rows[0]!.id;
  }

  async listEvalCandidates(filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }): Promise<EvalCandidate[]> {
    const raw = filter?.limit;
    const limit = (raw === undefined || raw === null || !Number.isFinite(raw) || raw <= 0)
      ? 1000
      : Math.min(Math.floor(raw), 100000);
    const since = filter?.since ?? new Date(0);
    const tool = filter?.tool ?? null;
    // id DESC tiebreaker — see postgres-engine for rationale.
    const { rows } = tool
      ? await this.db.query(
          `SELECT * FROM eval_candidates
           WHERE created_at >= $1 AND tool_name = $2
           ORDER BY created_at DESC, id DESC LIMIT $3`,
          [since, tool, limit]
        )
      : await this.db.query(
          `SELECT * FROM eval_candidates
           WHERE created_at >= $1
           ORDER BY created_at DESC, id DESC LIMIT $2`,
          [since, limit]
        );
    return rows as unknown as EvalCandidate[];
  }

  async deleteEvalCandidatesBefore(date: Date): Promise<number> {
    const { rows } = await this.db.query(
      `DELETE FROM eval_candidates WHERE created_at < $1 RETURNING id`,
      [date]
    );
    return rows.length;
  }

  async logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void> {
    await this.db.query(
      `INSERT INTO eval_capture_failures (reason) VALUES ($1)`,
      [reason]
    );
  }

  async listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]> {
    const since = filter?.since ?? new Date(0);
    const { rows } = await this.db.query(
      `SELECT * FROM eval_capture_failures WHERE ts >= $1 ORDER BY ts DESC`,
      [since]
    );
    return rows as unknown as EvalCaptureFailure[];
  }
}

function rowToCodeEdge(row: Record<string, unknown>): import('./types.ts').CodeEdgeResult {
  return {
    id: row.id as number,
    from_chunk_id: row.from_chunk_id as number,
    to_chunk_id: row.to_chunk_id == null ? null : (row.to_chunk_id as number),
    from_symbol_qualified: (row.from_symbol_qualified as string) ?? '',
    to_symbol_qualified: (row.to_symbol_qualified as string) ?? '',
    edge_type: (row.edge_type as string) ?? '',
    edge_metadata: (row.edge_metadata as Record<string, unknown>) ?? {},
    source_id: row.source_id == null ? null : (row.source_id as string),
    resolved: Boolean(row.resolved),
  };
}
