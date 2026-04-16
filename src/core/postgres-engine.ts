import postgres from 'postgres';
import type { BrainEngine } from './engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';
import type {
  Page, PageInput, PageFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
} from './types.ts';
import { GBrainError } from './types.ts';
import * as db from './db.ts';
import { validateSlug, contentHash, rowToPage, rowToChunk, rowToSearchResult } from './utils.ts';

export class PostgresEngine implements BrainEngine {
  private _sql: ReturnType<typeof postgres> | null = null;

  // Instance connection (for workers) or fall back to module global (backward compat)
  get sql(): ReturnType<typeof postgres> {
    if (this._sql) return this._sql;
    return db.getConnection();
  }

  // Lifecycle
  async connect(config: EngineConfig & { poolSize?: number }): Promise<void> {
    if (config.poolSize) {
      // Instance-level connection for worker isolation
      const url = config.database_url;
      if (!url) throw new GBrainError('No database URL', 'database_url is missing', 'Provide --url');
      this._sql = postgres(url, {
        max: config.poolSize,
        idle_timeout: 20,
        connect_timeout: 10,
        types: { bigint: postgres.BigInt },
      });
      await this._sql`SELECT 1`;
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
    });
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

    const rows = await sql`
      INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
      VALUES (${slug}, ${page.type}, ${page.title}, ${page.compiled_truth}, ${page.timeline || ''}, ${JSON.stringify(frontmatter)}::jsonb, ${hash}, now())
      ON CONFLICT (slug) DO UPDATE SET
        type = EXCLUDED.type,
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

    // Normalize single `tag` into `tags_all` so all tag filters share one code path.
    const tagsAll: string[] = [
      ...(filters?.tag ? [filters.tag] : []),
      ...(filters?.tags_all ?? []),
    ];
    const tagsAny: string[] = filters?.tags_any ?? [];

    // Fast path: no tag filters -> plain query (no joins).
    if (tagsAll.length === 0 && tagsAny.length === 0) {
      const rows = filters?.type
        ? await sql`
            SELECT * FROM pages WHERE type = ${filters.type}
            ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
          `
        : await sql`
            SELECT * FROM pages
            ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
          `;
      return rows.map(rowToPage);
    }

    // Tag-filter path: GROUP BY + HAVING counts, composable across tags_all and tags_any.
    //
    // Strategy:
    //   WHERE t.tag = ANY($candidate) AND (p.type filter if any)
    //   GROUP BY p.id
    //   HAVING count DISTINCT matching tags_all = tags_all.length
    //      AND (tags_any empty OR count DISTINCT matching tags_any >= 1)
    //
    // The candidate set is the union of tags_all and tags_any so one join covers both.
    const candidate = [...new Set([...tagsAll, ...tagsAny])];

    const typeClause = filters?.type
      ? sql`AND p.type = ${filters.type}`
      : sql``;

    const havingAll = tagsAll.length > 0
      ? sql`COUNT(DISTINCT t.tag) FILTER (WHERE t.tag = ANY(${tagsAll})) = ${tagsAll.length}`
      : sql`TRUE`;

    const havingAny = tagsAny.length > 0
      ? sql`AND COUNT(DISTINCT t.tag) FILTER (WHERE t.tag = ANY(${tagsAny})) >= 1`
      : sql``;

    const rows = await sql`
      SELECT p.* FROM pages p
      JOIN tags t ON t.page_id = p.id
      WHERE t.tag = ANY(${candidate})
      ${typeClause}
      GROUP BY p.id
      HAVING ${havingAll} ${havingAny}
      ORDER BY p.updated_at DESC
      LIMIT ${limit} OFFSET ${offset}
    `;

    return rows.map(rowToPage);
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
    return fuzzy.map((r: { slug: string }) => r.slug);
  }

  // Search
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const detailLow = opts?.detail === 'low';

    // Search-only timeout: prevents DoS via expensive queries without
    // affecting long-running operations like embed --all or bulk import
    await sql`SET statement_timeout = '8s'`;
    try {
      // CTE: rank pages by FTS score, then pick the best chunk per page in SQL
      const rows = await sql`
        WITH ranked_pages AS (
          SELECT p.id, p.slug, p.title, p.type,
            ts_rank(p.search_vector, websearch_to_tsquery('english', ${query})) AS score
          FROM pages p
          WHERE p.search_vector @@ websearch_to_tsquery('english', ${query})
            ${type ? sql`AND p.type = ${type}` : sql``}
            ${excludeSlugs?.length ? sql`AND p.slug != ALL(${excludeSlugs})` : sql``}
          ORDER BY score DESC
          LIMIT ${limit}
          OFFSET ${offset}
        ),
        best_chunks AS (
          SELECT DISTINCT ON (rp.slug)
            rp.slug, rp.id as page_id, rp.title, rp.type, rp.score,
            cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source
          FROM ranked_pages rp
          JOIN content_chunks cc ON cc.page_id = rp.id
          ${detailLow ? sql`WHERE cc.chunk_source = 'compiled_truth'` : sql``}
          ORDER BY rp.slug, cc.chunk_index
        )
        SELECT slug, page_id, title, type, chunk_id, chunk_index, chunk_text, chunk_source, score,
          false AS stale
        FROM best_chunks
        ORDER BY score DESC
      `;
      return rows.map(rowToSearchResult);
    } finally {
      await sql`SET statement_timeout = '0'`;
    }
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = this.sql;
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const type = opts?.type;
    const excludeSlugs = opts?.exclude_slugs;
    const detailLow = opts?.detail === 'low';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const vecStr = '[' + Array.from(embedding).join(',') + ']';

    // Search-only timeout (see searchKeyword for rationale)
    await sql`SET statement_timeout = '8s'`;
    try {
      const rows = await sql`
        SELECT
          p.slug, p.id as page_id, p.title, p.type,
          cc.id as chunk_id, cc.chunk_index, cc.chunk_text, cc.chunk_source,
          1 - (cc.embedding <=> ${vecStr}::vector) AS score,
          false AS stale
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NOT NULL
          ${detailLow ? sql`AND cc.chunk_source = 'compiled_truth'` : sql``}
          ${type ? sql`AND p.type = ${type}` : sql``}
          ${excludeSlugs?.length ? sql`AND p.slug != ALL(${excludeSlugs})` : sql``}
        ORDER BY cc.embedding <=> ${vecStr}::vector
        LIMIT ${limit}
        OFFSET ${offset}
      `;
      return rows.map(rowToSearchResult);
    } finally {
      await sql`SET statement_timeout = '0'`;
    }
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
      if (row.embedding) result.set(row.id as number, row.embedding as Float32Array);
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

    // Batch upsert: build a single multi-row INSERT ON CONFLICT statement
    // This avoids per-row round-trips and reduces lock contention under parallel workers
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)';
    const rows: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;

      if (embeddingStr) {
        rows.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++}, $${paramIdx++}, now())`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, embeddingStr, chunk.model || 'text-embedding-3-large', chunk.token_count || null);
      } else {
        rows.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, NULL)`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, chunk.model || 'text-embedding-3-large', chunk.token_count || null);
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
         embedded_at = COALESCE(EXCLUDED.embedded_at, content_chunks.embedded_at)`,
      params,
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
    return rows.map(rowToChunk);
  }

  async deleteChunks(slug: string): Promise<void> {
    const sql = this.sql;
    await sql`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
    `;
  }

  // Links
  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    const sql = this.sql;
    const result = await sql`
      INSERT INTO links (from_page_id, to_page_id, link_type, context)
      SELECT f.id, t.id, ${linkType || ''}, ${context || ''}
      FROM pages f, pages t
      WHERE f.slug = ${from} AND t.slug = ${to}
      ON CONFLICT (from_page_id, to_page_id) DO UPDATE SET
        link_type = EXCLUDED.link_type,
        context = EXCLUDED.context
      RETURNING id
    `;
    if (result.length === 0) throw new Error(`addLink failed: page "${from}" or "${to}" not found`);
  }

  async removeLink(from: string, to: string): Promise<void> {
    const sql = this.sql;
    await sql`
      DELETE FROM links
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from})
        AND to_page_id = (SELECT id FROM pages WHERE slug = ${to})
    `;
  }

  async getLinks(slug: string): Promise<Link[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = ${slug}
    `;
    return rows as unknown as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = ${slug}
    `;
    return rows as unknown as Link[];
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const sql = this.sql;
    const rows = await sql`
      WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth
        FROM pages p WHERE p.slug = ${slug}

        UNION

        SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < ${depth}
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        coalesce(
          (SELECT jsonb_agg(jsonb_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
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
    return rows.map((r: { tag: string }) => r.tag);
  }

  // Timeline
  async addTimelineEntry(slug: string, entry: TimelineInput): Promise<void> {
    const sql = this.sql;
    const result = await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, ${entry.date}::date, ${entry.source || ''}, ${entry.summary}, ${entry.detail || ''}
      FROM pages WHERE slug = ${slug}
      RETURNING id
    `;
    if (result.length === 0) throw new Error(`addTimelineEntry failed: page "${slug}" not found`);
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
      SELECT id, ${source}, ${JSON.stringify(data)}::jsonb
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
    const [h] = await sql`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL)::float /
          GREATEST((SELECT count(*) FROM content_chunks), 1)::float as embed_coverage,
        (SELECT count(*) FROM pages p
         WHERE (p.compiled_truth != '' OR p.timeline != '')
           AND NOT EXISTS (SELECT 1 FROM content_chunks cc WHERE cc.page_id = p.id)
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
        (SELECT count(DISTINCT page_id) FROM timeline_entries) as pages_with_timeline
    `;

    const pageCount = Number(h.page_count);
    const embedCoverage = Number(h.embed_coverage);
    const orphanPages = Number(h.orphan_pages);
    const deadLinks = Number(h.dead_links);
    const linkCount = Number(h.link_count);
    const pagesWithTimeline = Number(h.pages_with_timeline);

    // brain_score: 0-100 weighted average
    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    const timelineCoverage = pageCount > 0 ? Math.min(pagesWithTimeline / pageCount, 1) : 0;
    const noOrphans = pageCount > 0 ? 1 - (orphanPages / pageCount) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;
    const brainScore = pageCount === 0 ? 0 : Math.round(
      (embedCoverage * 0.35 + linkDensity * 0.25 + timelineCoverage * 0.15 +
       noOrphans * 0.15 + noDeadLinks * 0.10) * 100
    );

    return {
      page_count: pageCount,
      embed_coverage: embedCoverage,
      stale_pages: Number(h.stale_pages),
      orphan_pages: orphanPages,
      dead_links: deadLinks,
      missing_embeddings: Number(h.missing_embeddings),
      brain_score: brainScore,
    };
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
      VALUES (${entry.source_type}, ${entry.source_ref}, ${JSON.stringify(entry.pages_updated)}::jsonb, ${entry.summary})
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
    return rows.map((r: Record<string, unknown>) => rowToChunk(r, true));
  }
}
