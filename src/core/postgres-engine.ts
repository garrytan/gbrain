import postgres from 'postgres';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput, ReservedConnection } from './engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput,
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
import { GBrainError } from './types.ts';
import * as db from './db.ts';
import { validateSlug, contentHash, rowToPage, rowToChunk, rowToSearchResult, parseEmbedding, tryParseEmbedding } from './utils.ts';

export class PostgresEngine implements BrainEngine {
  readonly kind = 'postgres' as const;
  private _sql: ReturnType<typeof postgres> | null = null;

  // Instance connection (for workers) or fall back to module global (backward compat)
  get sql(): ReturnType<typeof postgres> {
    if (this._sql) return this._sql;
    return db.getConnection();
  }

  // Lifecycle
  async connect(config: EngineConfig & { poolSize?: number }): Promise<void> {
    if (config.poolSize) {
      // Instance-level connection for worker isolation. resolvePoolSize lets
      // GBRAIN_POOL_SIZE cap below the caller's requested size when set — the
      // env var is a user escape hatch, so it wins.
      const url = config.database_url;
      if (!url) throw new GBrainError('No database URL', 'database_url is missing', 'Provide --url');
      const size = Math.min(config.poolSize, db.resolvePoolSize(config.poolSize));
      // Honor PgBouncer transaction-mode detection on worker-instance pools too.
      // Without this, `gbrain jobs work` against a Supabase pooler URL hits
      // "prepared statement does not exist" under load just like the module
      // singleton did before v0.15.4.
      const prepare = db.resolvePrepare(url);
      const opts: Record<string, unknown> = {
        max: size,
        idle_timeout: 20,
        connect_timeout: 10,
        types: { bigint: postgres.BigInt },
      };
      if (typeof prepare === 'boolean') {
        opts.prepare = prepare;
      }
      this._sql = postgres(url, opts);
      await this._sql`SELECT 1`;
      await db.setSessionDefaults(this._sql);
    } else {
      // Module-level singleton (backward compat for CLI main engine)
      await db.connect(config);
    }
  }

  async disconnect(): Promise<void> {
    if (this._sql) {
      await this._sql.end();
      this._sql = null;
    } else {
      await db.disconnect();
    }
  }

  async initSchema(): Promise<void> {
    const conn = this.sql;
    // Advisory lock prevents concurrent initSchema() calls from deadlocking
    // on DDL statements (DROP TRIGGER + CREATE TRIGGER acquire AccessExclusiveLock)
    await conn`SELECT pg_advisory_lock(42)`;
    try {
      await conn.unsafe(SCHEMA_SQL);

      // Run any pending migrations automatically
      const { applied } = await runMigrations(this);
      if (applied > 0) {
        console.log(`  ${applied} migration(s) applied`);
      }
    } finally {
      await conn`SELECT pg_advisory_unlock(42)`;
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const conn = this._sql || db.getConnection();
    return conn.begin(async (tx) => {
      // Create a scoped engine with tx as its connection, no shared state mutation
      const txEngine = Object.create(this) as PostgresEngine;
      Object.defineProperty(txEngine, 'sql', { get: () => tx });
      Object.defineProperty(txEngine, '_sql', { value: tx as unknown as ReturnType<typeof postgres>, writable: false });
      return fn(txEngine);
    }) as Promise<T>;
  }

  async withReservedConnection<T>(fn: (conn: ReservedConnection) => Promise<T>): Promise<T> {
    const pool = this._sql || db.getConnection();
    const reserved = await pool.reserve();
    try {
      const conn: ReservedConnection = {
        async executeRaw<R = Record<string, unknown>>(query: string, params?: unknown[]): Promise<R[]> {
          const rows = params === undefined
            ? await reserved.unsafe(query)
            : await reserved.unsafe(query, params as Parameters<typeof reserved.unsafe>[1]);
          return rows as unknown as R[];
        },
      };
      return await fn(conn);
    } finally {
      reserved.release();
    }
  }

  // Pages CRUD
  async getPage(slug: string): Promise<Page | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
      FROM pages WHERE slug = ${slug}
    `;
    if (rows.length === 0) return null;
    return rowToPage(rows[0]);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    slug = validateSlug(slug);
    const sql = this.sql;
    const hash = page.content_hash || contentHash(page);
    const frontmatter = page.frontmatter || {};

    // v0.18.0 Step 2: source_id relies on schema DEFAULT 'default'. ON
    // CONFLICT target becomes (source_id, slug) since global UNIQUE(slug)
    // was dropped in migration v17. See pglite-engine.ts for matching
    // notes; multi-source sync (Step 5) will surface an explicit sourceId.
    const pageKind = page.page_kind || 'markdown';
    const rows = await sql`
      INSERT INTO pages (slug, type, page_kind, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
      VALUES (${slug}, ${page.type}, ${pageKind}, ${page.title}, ${page.compiled_truth}, ${page.timeline || ''}, ${sql.json(frontmatter as Parameters<typeof sql.json>[0])}, ${hash}, now())
      ON CONFLICT (source_id, slug) DO UPDATE SET
        type = EXCLUDED.type,
        page_kind = EXCLUDED.page_kind,
        title = EXCLUDED.title,
        compiled_truth = EXCLUDED.compiled_truth,
        timeline = EXCLUDED.timeline,
        frontmatter = EXCLUDED.frontmatter,
        content_hash = EXCLUDED.content_hash,
        updated_at = now()
      RETURNING id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
    `;
    return rowToPage(rows[0]);
  }

  async deletePage(slug: string): Promise<void> {
    const sql = this.sql;
    await sql`DELETE FROM pages WHERE slug = ${slug}`;
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const sql = this.sql;
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    const updatedAfter = filters?.updated_after;

    // postgres.js sql.unsafe is awkward for conditional WHERE; use raw query branching.
    // The 4 dimensions (type, tag, updated_after, none) cross-product into 8 cases;
    // we use postgres.js's tagged-template chaining via sql`` fragments instead.

    // Build conditions with sql fragments. postgres.js supports fragment composition.
    const typeCondition = filters?.type ? sql`AND p.type = ${filters.type}` : sql``;
    const tagJoin = filters?.tag ? sql`JOIN tags t ON t.page_id = p.id` : sql``;
    const tagCondition = filters?.tag ? sql`AND t.tag = ${filters.tag}` : sql``;
    const updatedCondition = updatedAfter ? sql`AND p.updated_at > ${updatedAfter}::timestamptz` : sql``;

    const rows = await sql`
      SELECT p.* FROM pages p
      ${tagJoin}
      WHERE 1=1 ${typeCondition} ${tagCondition} ${updatedCondition}
      ORDER BY p.updated_at DESC LIMIT ${limit} OFFSET ${offset}
    `;

    return rows.map(rowToPage);
  }

  async getAllSlugs(): Promise<Set<string>> {
    const sql = this.sql;
    const rows = await sql`SELECT slug FROM pages`;
    return new Set(rows.map((r) => r.slug as string));
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    const sql = this.sql;

    // Try exact match first
    const exact = await sql`SELECT slug FROM pages WHERE slug = ${partial}`;
    if (exact.length > 0) return [exact[0].slug];

    // Fuzzy match via pg_trgm
    const fuzzy = await sql`
      SELECT slug, similarity(title, ${partial}) AS sim
      FROM pages
      WHERE title % ${partial} OR slug ILIKE ${'%' + partial + '%'}
      ORDER BY sim DESC
      LIMIT 5
    `;
    return fuzzy.map((r) => r.slug as string);
  }

  // Search
  // v0.20.0 Cathedral II Layer 3 (1b): chunk-grain FTS internally,
  // dedup-to-best-chunk-per-page on the way out. External shape
  // preserves the v0.19.0 contract so backlinks / enrichment-service /
  // list_pages etc. see zero breaking changes. A2 two-pass (Layer 7)
  // consumes searchKeywordChunks for the raw chunk-grain primitive.
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const detailLow = opts?.detail === 'low';
    // Fetch headroom for dedup: if we only fetch `limit` chunks, a cluster of
    // co-occurring terms in one page can eat the entire result set and we'd
    // ship < limit pages. 3x gives dedup enough to pick top N distinct pages.
    const innerLimit = Math.min(limit * 3, MAX_SEARCH_LIMIT * 3);

    // Search-only timeout: prevents DoS via expensive queries without
    // affecting long-running operations like embed --all or bulk import.
    // SET LOCAL inside sql.begin() scopes the GUC to the transaction so
    // it can never leak onto a pooled connection returned to other
    // callers. A bare `SET statement_timeout` goes to an arbitrary
    // connection from the pool, lives past this method, and either
    // clips an unrelated caller's long-running query (DoS) or — via
    // `SET statement_timeout = 0` — disables the guard for them.
    const rows = await sql.begin(async sql => {
      await sql`SET LOCAL statement_timeout = '8s'`;
      // CTE chain: rank chunks by FTS → DISTINCT ON (slug) to pick best
      // chunk per page → order by score → limit. The external shape is
      // page-grain; chunk-grain ranking wins because A4 weights mean
      // doc-comment hits (and, once Layer 5 populates them, qualified
      // symbol hits) beat body-text hits at the chunk level.
      return await sql`
        WITH ranked_chunks AS (
          SELECT
            p.slug, p.id as page_id, p.title, p.type, p.source_id,
            cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
            ts_rank(cc.search_vector, websearch_to_tsquery('english', ${query})) AS score
          FROM content_chunks cc
          JOIN pages p ON p.id = cc.page_id
          WHERE cc.search_vector @@ websearch_to_tsquery('english', ${query})
            ${type ? sql`AND p.type = ${type}` : sql``}
            ${excludeSlugs?.length ? sql`AND p.slug != ALL(${excludeSlugs})` : sql``}
            ${detailLow ? sql`AND cc.chunk_source = 'compiled_truth'` : sql``}
            ${language ? sql`AND cc.language = ${language}` : sql``}
            ${symbolKind ? sql`AND cc.symbol_type = ${symbolKind}` : sql``}
          ORDER BY score DESC
          LIMIT ${innerLimit}
        ),
        best_per_page AS (
          SELECT DISTINCT ON (slug) *
          FROM ranked_chunks
          ORDER BY slug, score DESC
        )
        SELECT slug, page_id, title, type, source_id,
          chunk_id, chunk_index, chunk_text, chunk_source, score,
          false AS stale
        FROM best_per_page
        ORDER BY score DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    });
    return rows.map(rowToSearchResult);
  }

  /**
   * v0.20.0 Cathedral II Layer 3 (1b) chunk-grain keyword search.
   * Ranks chunks via content_chunks.search_vector WITHOUT the
   * dedup-to-page pass searchKeyword applies. Used by A2 two-pass
   * retrieval (Layer 7) as the anchor-discovery primitive.
   *
   * Most callers should prefer searchKeyword (external page-grain
   * contract). This is intentionally a narrow internal knob.
   */
  async searchKeywordChunks(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const detailLow = opts?.detail === 'low';
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const rows = await sql.begin(async sql => {
      await sql`SET LOCAL statement_timeout = '8s'`;
      return await sql`
        SELECT
          p.slug, p.id as page_id, p.title, p.type, p.source_id,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          ts_rank(cc.search_vector, websearch_to_tsquery('english', ${query})) AS score,
          false AS stale
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.search_vector @@ websearch_to_tsquery('english', ${query})
          ${type ? sql`AND p.type = ${type}` : sql``}
          ${excludeSlugs?.length ? sql`AND p.slug != ALL(${excludeSlugs})` : sql``}
          ${detailLow ? sql`AND cc.chunk_source = 'compiled_truth'` : sql``}
          ${language ? sql`AND cc.language = ${language}` : sql``}
          ${symbolKind ? sql`AND cc.symbol_type = ${symbolKind}` : sql``}
        ORDER BY score DESC
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    });
    return rows.map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const detailLow = opts?.detail === 'low';
    const language = opts?.language;
    const symbolKind = opts?.symbolKind;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const vecStr = '[' + Array.from(embedding).join(',') + ']';

    // Search-only timeout (see searchKeyword for rationale). SET LOCAL +
    // sql.begin ensures the GUC stays transaction-scoped on the pooled
    // connection.
    const rows = await sql.begin(async sql => {
      await sql`SET LOCAL statement_timeout = '8s'`;
      return await sql`
        SELECT
          p.slug, p.id as page_id, p.title, p.type, p.source_id,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          1 - (cc.embedding <=> ${vecStr}::vector) AS score,
          false AS stale
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NOT NULL
          ${detailLow ? sql`AND cc.chunk_source = 'compiled_truth'` : sql``}
          ${type ? sql`AND p.type = ${type}` : sql``}
          ${excludeSlugs?.length ? sql`AND p.slug != ALL(${excludeSlugs})` : sql``}
          ${language ? sql`AND cc.language = ${language}` : sql``}
          ${symbolKind ? sql`AND cc.symbol_type = ${symbolKind}` : sql``}
        ORDER BY cc.embedding <=> ${vecStr}::vector
        LIMIT ${limit}
        OFFSET ${offset}
      `;
    });
    return rows.map(rowToSearchResult);
  }

  async getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>> {
    if (ids.length === 0) return new Map();
    const sql = this.sql;
    const rows = await sql`
      SELECT id, embedding FROM content_chunks
      WHERE id = ANY(${ids}::int[]) AND embedding IS NOT NULL
    `;
    const result = new Map<number, Float32Array>();
    for (const row of rows) {
      const embedding = tryParseEmbedding(row.embedding);
      if (embedding) result.set(row.id as number, embedding);
    }
    return result;
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const sql = this.sql;

    // Get page_id
    const pages = await sql`SELECT id FROM pages WHERE slug = ${slug}`;
    if (pages.length === 0) throw new Error(`Page not found: ${slug}`);
    const pageId = pages[0].id;

    // Remove chunks that no longer exist (chunk_index beyond new count)
    const newIndices = chunks.map(c => c.chunk_index);
    if (newIndices.length > 0) {
      await sql`DELETE FROM content_chunks WHERE page_id = ${pageId} AND chunk_index != ALL(${newIndices})`;
    } else {
      await sql`DELETE FROM content_chunks WHERE page_id = ${pageId}`;
      return;
    }

    // Batch upsert: build a single multi-row INSERT ON CONFLICT statement.
    // v0.19.0: includes language/symbol_name/symbol_type/start_line/end_line
    // so code chunks carry tree-sitter metadata into the DB. Markdown chunks
    // pass NULL for all five.
    // v0.20.0 Cathedral II Layer 6: adds parent_symbol_path / doc_comment /
    // symbol_name_qualified so nested-chunk emission (A3) can round-trip
    // scope metadata through upserts.
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at, language, symbol_name, symbol_type, start_line, end_line, parent_symbol_path, doc_comment, symbol_name_qualified)';
    const rows: string[] = [];
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
        rows.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++}, $${paramIdx++}, now(), $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::text[], $${paramIdx++}, $${paramIdx++})`);
        params.push(
          pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
          embeddingStr, chunk.model || 'text-embedding-3-large', chunk.token_count || null,
          chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
          chunk.start_line ?? null, chunk.end_line ?? null,
          parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
        );
      } else {
        rows.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::text[], $${paramIdx++}, $${paramIdx++})`);
        params.push(
          pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
          chunk.model || 'text-embedding-3-large', chunk.token_count || null,
          chunk.language || null, chunk.symbol_name || null, chunk.symbol_type || null,
          chunk.start_line ?? null, chunk.end_line ?? null,
          parentPath, chunk.doc_comment || null, chunk.symbol_name_qualified || null,
        );
      }
    }

    // Single statement upsert: preserves existing embeddings via COALESCE when new value is NULL
    await sql.unsafe(
      `INSERT INTO content_chunks ${cols} VALUES ${rows.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = CASE WHEN EXCLUDED.chunk_text != content_chunks.chunk_text THEN EXCLUDED.embedding ELSE COALESCE(EXCLUDED.embedding, content_chunks.embedding) END,
         model = COALESCE(EXCLUDED.model, content_chunks.model),
         token_count = EXCLUDED.token_count,
         embedded_at = COALESCE(EXCLUDED.embedded_at, content_chunks.embedded_at),
         language = EXCLUDED.language,
         symbol_name = EXCLUDED.symbol_name,
         symbol_type = EXCLUDED.symbol_type,
         start_line = EXCLUDED.start_line,
         end_line = EXCLUDED.end_line,
         parent_symbol_path = EXCLUDED.parent_symbol_path,
         doc_comment = EXCLUDED.doc_comment,
         symbol_name_qualified = EXCLUDED.symbol_name_qualified`,
      params as Parameters<typeof sql.unsafe>[1],
    );
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT cc.* FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ${slug}
      ORDER BY cc.chunk_index
    `;
    return rows.map((r) => rowToChunk(r as Record<string, unknown>));
  }

  async deleteChunks(slug: string): Promise<void> {
    const sql = this.sql;
    await sql`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
    `;
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
    const sql = this.sql;
    // Pre-check existence so we can throw a clear error (ON CONFLICT DO UPDATE
    // returns 0 rows when source SELECT is empty, indistinguishable from missing page).
    const exists = await sql`
      SELECT 1 FROM pages WHERE slug = ${from}
      INTERSECT
      SELECT 1 FROM pages WHERE slug = ${to}
    `;
    if (exists.length === 0) {
      throw new Error(`addLink failed: page "${from}" or "${to}" not found`);
    }
    // Default link_source to 'markdown' for back-compat with pre-v0.13 callers.
    // origin_page_id resolves from originSlug via the pages join (NULL if no slug).
    const src = linkSource ?? 'markdown';
    await sql`
      INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
      SELECT f.id, t.id, ${linkType || ''}, ${context || ''}, ${src},
             (SELECT id FROM pages WHERE slug = ${originSlug ?? null}),
             ${originField ?? null}
      FROM pages f, pages t
      WHERE f.slug = ${from} AND t.slug = ${to}
      ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO UPDATE SET
        context = EXCLUDED.context,
        origin_field = EXCLUDED.origin_field
    `;
  }

  async addLinksBatch(links: LinkBatchInput[]): Promise<number> {
    if (links.length === 0) return 0;
    const sql = this.sql;
    // unnest() pattern: 7 array-typed bound parameters regardless of batch size.
    // Avoids the 65535-parameter cap and the postgres-js sql(rows, ...) helper's
    // identifier-escape gotcha when used inside a (VALUES) subquery.
    //
    // v0.13: added link_source, origin_slug, origin_field. Defaults:
    //   link_source  → 'markdown' (back-compat with pre-v0.13 callers)
    //   origin_slug  → NULL (resolves to origin_page_id IS NULL via LEFT JOIN)
    //   origin_field → NULL
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
    const result = await sql`
      INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
      SELECT f.id, t.id, v.link_type, v.context, v.link_source, o.id, v.origin_field
      FROM unnest(
        ${fromSlugs}::text[], ${toSlugs}::text[], ${linkTypes}::text[],
        ${contexts}::text[], ${linkSources}::text[], ${originSlugs}::text[],
        ${originFields}::text[], ${fromSourceIds}::text[], ${toSourceIds}::text[],
        ${originSourceIds}::text[]
      ) AS v(from_slug, to_slug, link_type, context, link_source, origin_slug, origin_field, from_source_id, to_source_id, origin_source_id)
      JOIN pages f ON f.slug = v.from_slug AND f.source_id = v.from_source_id
      JOIN pages t ON t.slug = v.to_slug AND t.source_id = v.to_source_id
      LEFT JOIN pages o ON o.slug = v.origin_slug AND o.source_id = v.origin_source_id
      ON CONFLICT (from_page_id, to_page_id, link_type, link_source, origin_page_id) DO NOTHING
      RETURNING 1
    `;
    return result.length;
  }

  async removeLink(from: string, to: string, linkType?: string, linkSource?: string): Promise<void> {
    const sql = this.sql;
    // Build up filters dynamically. linkType + linkSource are independent
    // optional constraints; all four combinations are valid.
    if (linkType !== undefined && linkSource !== undefined) {
      await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to})
          AND link_type = ${linkType}
          AND link_source IS NOT DISTINCT FROM ${linkSource}
      `;
    } else if (linkType !== undefined) {
      await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to})
          AND link_type = ${linkType}
      `;
    } else if (linkSource !== undefined) {
      await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to})
          AND link_source IS NOT DISTINCT FROM ${linkSource}
      `;
    } else {
      await sql`
        DELETE FROM links
        WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from})
          AND to_page_id = (SELECT id FROM pages WHERE slug = ${to})
      `;
    }
  }

  async getLinks(slug: string): Promise<Link[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT f.slug as from_slug, t.slug as to_slug,
             l.link_type, l.context, l.link_source,
             o.slug as origin_slug, l.origin_field
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      LEFT JOIN pages o ON o.id = l.origin_page_id
      WHERE f.slug = ${slug}
    `;
    return rows as unknown as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT f.slug as from_slug, t.slug as to_slug,
             l.link_type, l.context, l.link_source,
             o.slug as origin_slug, l.origin_field
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      LEFT JOIN pages o ON o.id = l.origin_page_id
      WHERE t.slug = ${slug}
    `;
    return rows as unknown as Link[];
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
  ): Promise<{ slug: string; similarity: number } | null> {
    const sql = this.sql;
    // Use the `similarity()` function directly with an explicit threshold
    // comparison. DO NOT use `SET LOCAL pg_trgm.similarity_threshold` +
    // the `%` operator here — postgres.js auto-commits each sql`` call
    // so `SET LOCAL` is a no-op across statement boundaries. Inline
    // comparison is the only way to get predictable threshold behavior
    // without wrapping the caller in a transaction.
    //
    // Tie-breaker: sort by slug after similarity so re-runs return the
    // same winner when multiple pages score equally (prevents churn
    // in put_page auto-link reconciliation).
    const prefixPattern = dirPrefix ? `${dirPrefix}/%` : '%';
    const rows = await sql`
      SELECT slug, similarity(title, ${name}) AS sim
      FROM pages
      WHERE similarity(title, ${name}) >= ${minSimilarity}
        AND slug LIKE ${prefixPattern}
      ORDER BY sim DESC, slug ASC
      LIMIT 1
    `;
    if (rows.length === 0) return null;
    const row = rows[0] as { slug: string; sim: number };
    return { slug: row.slug, similarity: row.sim };
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const sql = this.sql;
    // Cycle prevention: visited array tracks page IDs already in the path.
    const rows = await sql`
      WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth, ARRAY[p.id] as visited
        FROM pages p WHERE p.slug = ${slug}

        UNION ALL

        SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1, g.visited || p2.id
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < ${depth}
          AND NOT (p2.id = ANY(g.visited))
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        coalesce(
          -- jsonb_agg(DISTINCT ...) collapses duplicate (to_slug, link_type)
          -- edges that originate from different provenance (markdown body
          -- vs frontmatter vs auto-extracted). The underlying links table
          -- preserves every row with its origin_page_id / link_source —
          -- the dedup is presentation-only for the legacy traverseGraph
          -- aggregation. traversePaths has its own in-memory dedup at a
          -- different layer. See plan Bug 6/10.
          (SELECT jsonb_agg(DISTINCT jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id),
          '[]'::jsonb
        ) as links
      FROM graph g
      ORDER BY g.depth, g.slug
    `;

    return rows.map((r: Record<string, unknown>) => ({
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
    const sql = this.sql;
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType ?? null;
    const linkTypeMatches = linkType !== null;

    let rows;
    if (direction === 'out') {
      rows = await sql`
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.from_page_id = w.id
          JOIN pages p2 ON p2.id = l.to_page_id
          WHERE w.depth < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
        )
        SELECT w.slug as from_slug, p2.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM walk w
        JOIN links l ON l.from_page_id = w.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
        ORDER BY depth, from_slug, to_slug
      `;
    } else if (direction === 'in') {
      rows = await sql`
        WITH RECURSIVE walk AS (
          SELECT p.id, p.slug, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug}
          UNION ALL
          SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON l.to_page_id = w.id
          JOIN pages p2 ON p2.id = l.from_page_id
          WHERE w.depth < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
        )
        SELECT p2.slug as from_slug, w.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM walk w
        JOIN links l ON l.to_page_id = w.id
        JOIN pages p2 ON p2.id = l.from_page_id
        WHERE w.depth < ${depth}
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
        ORDER BY depth, from_slug, to_slug
      `;
    } else {
      rows = await sql`
        WITH RECURSIVE walk AS (
          SELECT p.id, 0::int as depth, ARRAY[p.id] as visited
          FROM pages p WHERE p.slug = ${slug}
          UNION ALL
          SELECT p2.id, w.depth + 1, w.visited || p2.id
          FROM walk w
          JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
          JOIN pages p2 ON p2.id = CASE WHEN l.from_page_id = w.id THEN l.to_page_id ELSE l.from_page_id END
          WHERE w.depth < ${depth}
            AND NOT (p2.id = ANY(w.visited))
            AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
        )
        SELECT pf.slug as from_slug, pt.slug as to_slug,
               l.link_type, l.context, w.depth + 1 as depth
        FROM walk w
        JOIN links l ON (l.from_page_id = w.id OR l.to_page_id = w.id)
        JOIN pages pf ON pf.id = l.from_page_id
        JOIN pages pt ON pt.id = l.to_page_id
        WHERE w.depth < ${depth}
          AND (${!linkTypeMatches} OR l.link_type = ${linkType ?? ''})
        ORDER BY depth, from_slug, to_slug
      `;
    }

    // Dedup edges (same edge can appear via multiple visited paths).
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
        depth: Number(r.depth),
      });
    }
    return result;
  }

  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (slugs.length === 0) return result;
    for (const s of slugs) result.set(s, 0);

    const sql = this.sql;
    const rows = await sql`
      SELECT p.slug as slug, COUNT(l.id)::int as cnt
      FROM pages p
      LEFT JOIN links l ON l.to_page_id = p.id
      WHERE p.slug = ANY(${slugs}::text[])
      GROUP BY p.slug
    `;
    for (const r of rows as unknown as { slug: string; cnt: number }[]) {
      result.set(r.slug, Number(r.cnt));
    }
    return result;
  }

  async findOrphanPages(): Promise<Array<{ slug: string; title: string; domain: string | null }>> {
    const sql = this.sql;
    const rows = await sql`
      SELECT
        p.slug,
        COALESCE(p.title, p.slug) AS title,
        p.frontmatter->>'domain' AS domain
      FROM pages p
      WHERE NOT EXISTS (
        SELECT 1 FROM links l WHERE l.to_page_id = p.id
      )
      ORDER BY p.slug
    `;
    return rows as unknown as Array<{ slug: string; title: string; domain: string | null }>;
  }

  // Tags
  async addTag(slug: string, tag: string): Promise<void> {
    const sql = this.sql;
    // Verify page exists before attempting insert (ON CONFLICT DO NOTHING
    // swallows the "already tagged" case, but we still need to detect missing pages)
    const page = await sql`SELECT id FROM pages WHERE slug = ${slug}`;
    if (page.length === 0) throw new Error(`addTag failed: page "${slug}" not found`);
    await sql`
      INSERT INTO tags (page_id, tag)
      VALUES (${page[0].id}, ${tag})
      ON CONFLICT (page_id, tag) DO NOTHING
    `;
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    const sql = this.sql;
    await sql`
      DELETE FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
        AND tag = ${tag}
    `;
  }

  async getTags(slug: string): Promise<string[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT tag FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
      ORDER BY tag
    `;
    return rows.map((r) => r.tag as string);
  }

  // Timeline
  async addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean },
  ): Promise<void> {
    const sql = this.sql;
    if (!opts?.skipExistenceCheck) {
      const exists = await sql`SELECT 1 FROM pages WHERE slug = ${slug}`;
      if (exists.length === 0) {
        throw new Error(`addTimelineEntry failed: page "${slug}" not found`);
      }
    }
    // ON CONFLICT DO NOTHING via the (page_id, date, summary) unique index.
    // Returning 0 rows means either page missing OR duplicate; skipExistenceCheck
    // makes that ambiguity safe (caller asserts page exists).
    await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, ${entry.date}::date, ${entry.source || ''}, ${entry.summary}, ${entry.detail || ''}
      FROM pages WHERE slug = ${slug}
      ON CONFLICT (page_id, date, summary) DO NOTHING
    `;
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number> {
    if (entries.length === 0) return 0;
    const sql = this.sql;
    const slugs = entries.map(e => e.slug);
    const dates = entries.map(e => e.date);
    const sources = entries.map(e => e.source || '');
    const summaries = entries.map(e => e.summary);
    const details = entries.map(e => e.detail || '');
    const sourceIds = entries.map(e => e.source_id || 'default');
    const result = await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT p.id, v.date::date, v.source, v.summary, v.detail
      FROM unnest(${slugs}::text[], ${dates}::text[], ${sources}::text[], ${summaries}::text[], ${details}::text[], ${sourceIds}::text[])
        AS v(slug, date, source, summary, detail, source_id)
      JOIN pages p ON p.slug = v.slug AND p.source_id = v.source_id
      ON CONFLICT (page_id, date, summary) DO NOTHING
      RETURNING 1
    `;
    return result.length;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const sql = this.sql;
    const limit = opts?.limit || 100;

    let rows;
    if (opts?.after && opts?.before) {
      rows = await sql`
        SELECT te.* FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ${slug} AND te.date >= ${opts.after}::date AND te.date <= ${opts.before}::date
        ORDER BY te.date DESC LIMIT ${limit}
      `;
    } else if (opts?.after) {
      rows = await sql`
        SELECT te.* FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ${slug} AND te.date >= ${opts.after}::date
        ORDER BY te.date DESC LIMIT ${limit}
      `;
    } else {
      rows = await sql`
        SELECT te.* FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ${slug}
        ORDER BY te.date DESC LIMIT ${limit}
      `;
    }

    return rows as unknown as TimelineEntry[];
  }

  // Raw data
  async putRawData(slug: string, source: string, data: object): Promise<void> {
    const sql = this.sql;
    const result = await sql`
      INSERT INTO raw_data (page_id, source, data)
      SELECT id, ${source}, ${sql.json(data as Parameters<typeof sql.json>[0])}
      FROM pages WHERE slug = ${slug}
      ON CONFLICT (page_id, source) DO UPDATE SET
        data = EXCLUDED.data,
        fetched_at = now()
      RETURNING id
    `;
    if (result.length === 0) throw new Error(`putRawData failed: page "${slug}" not found`);
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    const sql = this.sql;
    let rows;
    if (source) {
      rows = await sql`
        SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug} AND rd.source = ${source}
      `;
    } else {
      rows = await sql`
        SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ${slug}
      `;
    }
    return rows as unknown as RawData[];
  }

  // Versions
  async createVersion(slug: string): Promise<PageVersion> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
      SELECT id, compiled_truth, frontmatter
      FROM pages WHERE slug = ${slug}
      RETURNING *
    `;
    if (rows.length === 0) throw new Error(`createVersion failed: page "${slug}" not found`);
    return rows[0] as unknown as PageVersion;
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ${slug}
      ORDER BY pv.snapshot_at DESC
    `;
    return rows as unknown as PageVersion[];
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    const sql = this.sql;
    await sql`
      UPDATE pages SET
        compiled_truth = pv.compiled_truth,
        frontmatter = pv.frontmatter,
        updated_at = now()
      FROM page_versions pv
      WHERE pages.slug = ${slug} AND pv.id = ${versionId} AND pv.page_id = pages.id
    `;
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const sql = this.sql;
    const [stats] = await sql`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks) as chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT tag) FROM tags) as tag_count,
        (SELECT count(*) FROM timeline_entries) as timeline_entry_count
    `;

    const types = await sql`
      SELECT type, count(*)::int as count FROM pages GROUP BY type ORDER BY count DESC
    `;
    const pages_by_type: Record<string, number> = {};
    for (const t of types) {
      pages_by_type[t.type as string] = t.count as number;
    }

    return {
      page_count: Number(stats.page_count),
      chunk_count: Number(stats.chunk_count),
      embedded_count: Number(stats.embedded_count),
      link_count: Number(stats.link_count),
      tag_count: Number(stats.tag_count),
      timeline_entry_count: Number(stats.timeline_entry_count),
      pages_by_type,
    };
  }

  async getHealth(): Promise<BrainHealth> {
    const sql = this.sql;
    // Bug 11 doc-drift fix — orphan_pages means "islanded" (no inbound AND
    // no outbound links), aligning both engines with the user-facing
    // definition. The type comment previously said "no inbound" but the
    // SQL required both — docs now match code so users can trust the
    // number. A hub page that links out to many but has no back-references
    // is working as intended, not an orphan.
    const [h] = await sql`
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
    `;

    const connected = await sql`
      SELECT p.slug,
             (SELECT count(*) FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id)::int as link_count
      FROM pages p
      WHERE p.type IN ('person', 'company')
      ORDER BY link_count DESC
      LIMIT 5
    `;

    const pageCount = Number(h.page_count);
    const embedCoverage = Number(h.embed_coverage);
    const orphanPages = Number(h.orphan_pages);
    const deadLinks = Number(h.dead_links);
    const linkCount = Number(h.link_count);
    const pagesWithTimeline = Number(h.pages_with_timeline);

    // brain_score: 0-100 weighted average
    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    const timelineCoverageWhole = pageCount > 0 ? Math.min(pagesWithTimeline / pageCount, 1) : 0;
    const noOrphans = pageCount > 0 ? 1 - (orphanPages / pageCount) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
    // Per-component points. Sum equals brainScore by construction.
    const embedCoverageScore = pageCount === 0 ? 0 : Math.round(embedCoverage * 35);
    const linkDensityScore = pageCount === 0 ? 0 : Math.round(linkDensity * 25);
    const timelineCoverageScore = pageCount === 0 ? 0 : Math.round(timelineCoverageWhole * 15);
    const noOrphansScore = pageCount === 0 ? 0 : Math.round(noOrphans * 15);
    const noDeadLinksScore = pageCount === 0 ? 0 : Math.round(noDeadLinks * 10);
    const brainScore = embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore;

    return {
      page_count: pageCount,
      embed_coverage: embedCoverage,
      stale_pages: Number(h.stale_pages),
      orphan_pages: orphanPages,
      missing_embeddings: Number(h.missing_embeddings),
      brain_score: brainScore,
      dead_links: deadLinks,
      link_coverage: Number(h.link_coverage),
      timeline_coverage: Number(h.timeline_coverage),
      most_connected: (connected as unknown as { slug: string; link_count: number }[]).map(c => ({
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
    const sql = this.sql;
    await sql`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
      VALUES (${entry.source_type}, ${entry.source_ref}, ${sql.json(entry.pages_updated)}, ${entry.summary})
    `;
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const sql = this.sql;
    const limit = opts?.limit || 50;
    const rows = await sql`
      SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows as unknown as IngestLogEntry[];
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    newSlug = validateSlug(newSlug);
    const sql = this.sql;
    await sql`UPDATE pages SET slug = ${newSlug}, updated_at = now() WHERE slug = ${oldSlug}`;
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub in v0.2. Links table uses integer page_id FKs, which are already
    // correct after updateSlug (page_id doesn't change, only slug does).
    // Textual [[wiki-links]] in compiled_truth are NOT rewritten here.
    // The maintain skill's dead link detector surfaces stale references.
  }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const sql = this.sql;
    const rows = await sql`SELECT value FROM config WHERE key = ${key}`;
    return rows.length > 0 ? (rows[0].value as string) : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO config (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }

  // Migration support
  async runMigration(_version: number, sqlStr: string): Promise<void> {
    const conn = this.sql;
    await conn.unsafe(sqlStr);
  }

  async getChunksWithEmbeddings(slug: string): Promise<Chunk[]> {
    const conn = this.sql;
    const rows = await conn`
      SELECT cc.* FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ${slug}
      ORDER BY cc.chunk_index
    `;
    return rows.map((r) => rowToChunk(r as Record<string, unknown>, true));
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const conn = this.sql;
    return conn.unsafe(sql, params as Parameters<typeof conn.unsafe>[1]) as unknown as T[];
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
    const sql = this.sql;
    let inserted = 0;
    const resolved = edges.filter(e => e.to_chunk_id != null);
    const unresolved = edges.filter(e => e.to_chunk_id == null);

    if (resolved.length > 0) {
      const fromIds = resolved.map(e => e.from_chunk_id);
      const toIds = resolved.map(e => e.to_chunk_id as number);
      const fromQual = resolved.map(e => e.from_symbol_qualified);
      const toQual = resolved.map(e => e.to_symbol_qualified);
      const edgeTypes = resolved.map(e => e.edge_type);
      const metas = resolved.map(e => JSON.stringify(e.edge_metadata ?? {}));
      const sources = resolved.map(e => e.source_id ?? null);
      const res = await sql`
        INSERT INTO code_edges_chunk (from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
        SELECT * FROM unnest(
          ${fromIds}::int[], ${toIds}::int[],
          ${fromQual}::text[], ${toQual}::text[],
          ${edgeTypes}::text[], ${metas}::jsonb[],
          ${sources}::text[]
        )
        ON CONFLICT (from_chunk_id, to_chunk_id, edge_type) DO NOTHING
      `;
      inserted += (res as unknown as { count: number }).count ?? 0;
    }

    if (unresolved.length > 0) {
      const fromIds = unresolved.map(e => e.from_chunk_id);
      const fromQual = unresolved.map(e => e.from_symbol_qualified);
      const toQual = unresolved.map(e => e.to_symbol_qualified);
      const edgeTypes = unresolved.map(e => e.edge_type);
      const metas = unresolved.map(e => JSON.stringify(e.edge_metadata ?? {}));
      const sources = unresolved.map(e => e.source_id ?? null);
      const res = await sql`
        INSERT INTO code_edges_symbol (from_chunk_id, from_symbol_qualified, to_symbol_qualified, edge_type, edge_metadata, source_id)
        SELECT * FROM unnest(
          ${fromIds}::int[],
          ${fromQual}::text[], ${toQual}::text[],
          ${edgeTypes}::text[], ${metas}::jsonb[],
          ${sources}::text[]
        )
        ON CONFLICT (from_chunk_id, to_symbol_qualified, edge_type) DO NOTHING
      `;
      inserted += (res as unknown as { count: number }).count ?? 0;
    }

    return inserted;
  }

  async deleteCodeEdgesForChunks(chunkIds: number[]): Promise<void> {
    if (chunkIds.length === 0) return;
    const sql = this.sql;
    await sql`DELETE FROM code_edges_chunk WHERE from_chunk_id = ANY(${chunkIds}::int[]) OR to_chunk_id = ANY(${chunkIds}::int[])`;
    await sql`DELETE FROM code_edges_symbol WHERE from_chunk_id = ANY(${chunkIds}::int[])`;
  }

  async getCallersOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const sql = this.sql;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const scopedSource: string | null =
      !opts?.allSources && opts?.sourceId ? opts.sourceId : null;
    const rows = await sql`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE to_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      UNION ALL
      SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        WHERE to_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      LIMIT ${limit}
    `;
    return rows.map(r => pgRowToCodeEdge(r as Record<string, unknown>));
  }

  async getCalleesOf(
    qualifiedName: string,
    opts?: { sourceId?: string; allSources?: boolean; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const sql = this.sql;
    const limit = Math.min(opts?.limit ?? 100, 500);
    const scopedSource: string | null =
      !opts?.allSources && opts?.sourceId ? opts.sourceId : null;
    const rows = await sql`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE from_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      UNION ALL
      SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, false as resolved
        FROM code_edges_symbol
        WHERE from_symbol_qualified = ${qualifiedName}
        ${scopedSource ? sql`AND source_id = ${scopedSource}` : sql``}
      LIMIT ${limit}
    `;
    return rows.map(r => pgRowToCodeEdge(r as Record<string, unknown>));
  }

  async getEdgesByChunk(
    chunkId: number,
    opts?: { direction?: 'in' | 'out' | 'both'; edgeType?: string; limit?: number },
  ): Promise<import('./types.ts').CodeEdgeResult[]> {
    const sql = this.sql;
    const direction = opts?.direction ?? 'both';
    const limit = Math.min(opts?.limit ?? 50, 200);
    const typeFilter = opts?.edgeType;

    const chunkRows = await sql`
      SELECT id, from_chunk_id, to_chunk_id, from_symbol_qualified, to_symbol_qualified,
             edge_type, edge_metadata, source_id, true as resolved
        FROM code_edges_chunk
        WHERE
          ${direction === 'in' ? sql`to_chunk_id = ${chunkId}`
            : direction === 'out' ? sql`from_chunk_id = ${chunkId}`
            : sql`(from_chunk_id = ${chunkId} OR to_chunk_id = ${chunkId})`}
          ${typeFilter ? sql`AND edge_type = ${typeFilter}` : sql``}
        LIMIT ${limit}
    `;
    let symbolRows: unknown[] = [];
    if (direction !== 'in') {
      const sRows = await sql`
        SELECT id, from_chunk_id, NULL::int as to_chunk_id, from_symbol_qualified, to_symbol_qualified,
               edge_type, edge_metadata, source_id, false as resolved
          FROM code_edges_symbol
          WHERE from_chunk_id = ${chunkId}
            ${typeFilter ? sql`AND edge_type = ${typeFilter}` : sql``}
          LIMIT ${limit}
      `;
      symbolRows = [...sRows];
    }
    return [...chunkRows, ...symbolRows].map(r => pgRowToCodeEdge(r as Record<string, unknown>));
  }

  // Eval capture (v0.25.0). See BrainEngine interface docs.
  async logEvalCandidate(input: EvalCandidateInput): Promise<number> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO eval_candidates (
        tool_name, query, retrieved_slugs, retrieved_chunk_ids, source_ids,
        expand_enabled, detail, detail_resolved, vector_enabled, expansion_applied,
        latency_ms, remote, job_id, subagent_id
      ) VALUES (
        ${input.tool_name}, ${input.query}, ${input.retrieved_slugs}, ${input.retrieved_chunk_ids}, ${input.source_ids},
        ${input.expand_enabled}, ${input.detail}, ${input.detail_resolved}, ${input.vector_enabled}, ${input.expansion_applied},
        ${input.latency_ms}, ${input.remote}, ${input.job_id}, ${input.subagent_id}
      )
      RETURNING id
    `;
    return rows[0]!.id as number;
  }

  async listEvalCandidates(filter?: { since?: Date; limit?: number; tool?: 'query' | 'search' }): Promise<EvalCandidate[]> {
    const sql = this.sql;
    const raw = filter?.limit;
    const limit = (raw === undefined || raw === null || !Number.isFinite(raw) || raw <= 0)
      ? 1000
      : Math.min(Math.floor(raw), 100000);
    const since = filter?.since ?? new Date(0);
    const tool = filter?.tool ?? null;
    // id DESC tiebreaker so same-millisecond inserts return deterministically
    // — without this, `gbrain eval export --since` could dupe or miss rows
    // across non-overlapping windows.
    const rows = tool
      ? await sql`
          SELECT * FROM eval_candidates
          WHERE created_at >= ${since} AND tool_name = ${tool}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `
      : await sql`
          SELECT * FROM eval_candidates
          WHERE created_at >= ${since}
          ORDER BY created_at DESC, id DESC
          LIMIT ${limit}
        `;
    return rows as unknown as EvalCandidate[];
  }

  async deleteEvalCandidatesBefore(date: Date): Promise<number> {
    const sql = this.sql;
    const rows = await sql`
      DELETE FROM eval_candidates WHERE created_at < ${date} RETURNING id
    `;
    return rows.length;
  }

  async logEvalCaptureFailure(reason: EvalCaptureFailureReason): Promise<void> {
    const sql = this.sql;
    await sql`INSERT INTO eval_capture_failures (reason) VALUES (${reason})`;
  }

  async listEvalCaptureFailures(filter?: { since?: Date }): Promise<EvalCaptureFailure[]> {
    const sql = this.sql;
    const since = filter?.since ?? new Date(0);
    const rows = await sql`
      SELECT * FROM eval_capture_failures
      WHERE ts >= ${since}
      ORDER BY ts DESC
    `;
    return rows as unknown as EvalCaptureFailure[];
  }
}

function pgRowToCodeEdge(row: Record<string, unknown>): import('./types.ts').CodeEdgeResult {
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
