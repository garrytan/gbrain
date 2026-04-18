import postgres from 'postgres';
import type { BrainEngine } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';
import type {
  Page, PageInput, PageFilters, PageType,
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
import { MBrainError } from './types.ts';
import { clearConnectionOwner } from './db.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
import { ensurePageChunks } from './page-chunks.ts';
import { validateSlug, contentHash, importContentHash, rowToPage, rowToChunk, rowToSearchResult } from './utils.ts';

export class PostgresEngine implements BrainEngine {
  private _sql: ReturnType<typeof postgres> | null = null;

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

  // Lifecycle
  async connect(config: EngineConfig & { poolSize?: number }): Promise<void> {
    if (this._sql) return;

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
        types: { bigint: postgres.BigInt },
      });
      await sql`SELECT 1`;
      this._sql = sql;
    } catch (e: unknown) {
      if (sql) {
        await sql.end({ timeout: 0 }).catch(() => undefined);
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new MBrainError(
        'Cannot connect to database',
        msg,
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
    const conn = this.sql;
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
    const hash = page.content_hash || contentHash(page.compiled_truth, page.timeline || '');
    const frontmatter = page.frontmatter || {};
    const searchText = buildFrontmatterSearchText(frontmatter);

    const rows = await sql`
      INSERT INTO pages (slug, type, title, compiled_truth, timeline, search_text, frontmatter, content_hash, updated_at)
      VALUES (${slug}, ${page.type}, ${page.title}, ${page.compiled_truth}, ${page.timeline || ''}, ${searchText}, ${JSON.stringify(frontmatter)}::jsonb, ${hash}, now())
      ON CONFLICT (slug) DO UPDATE SET
        type = EXCLUDED.type,
        title = EXCLUDED.title,
        compiled_truth = EXCLUDED.compiled_truth,
        timeline = EXCLUDED.timeline,
        search_text = EXCLUDED.search_text,
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

    let rows;
    if (filters?.type && filters?.tag) {
      rows = await sql`
        SELECT p.* FROM pages p
        JOIN tags t ON t.page_id = p.id
        WHERE p.type = ${filters.type} AND t.tag = ${filters.tag}
        ORDER BY p.updated_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (filters?.type) {
      rows = await sql`
        SELECT * FROM pages WHERE type = ${filters.type}
        ORDER BY updated_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (filters?.tag) {
      rows = await sql`
        SELECT p.* FROM pages p
        JOIN tags t ON t.page_id = p.id
        WHERE t.tag = ${filters.tag}
        ORDER BY p.updated_at DESC, p.id DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT * FROM pages
        ORDER BY updated_at DESC, id DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }

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

  private async withSearchTimeout<T>(fn: (sql: ReturnType<typeof postgres>) => Promise<T>): Promise<T> {
    const sql = this.sql as ReturnType<typeof postgres> & {
      reserve?: () => Promise<ReturnType<typeof postgres> & { release?: () => Promise<void> }>;
      release?: () => Promise<void>;
      savepoint?: unknown;
    };

    if (typeof sql.savepoint === 'function') {
      await sql`SELECT set_config('statement_timeout', '8s', true)`;
      return fn(sql);
    }

    const reserved = typeof sql.reserve === 'function' ? await sql.reserve() : null;
    const scopedSql = (reserved || sql) as ReturnType<typeof postgres> & { release?: () => Promise<void> };
    const previous = await scopedSql<{ statement_timeout: string }[]>`
      SELECT current_setting('statement_timeout') AS statement_timeout
    `;

    try {
      await scopedSql`SELECT set_config('statement_timeout', '8s', false)`;
      return await fn(scopedSql);
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

  // Search
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;
    const params: unknown[] = [query];
    let filterSql = '';

    if (opts?.type) {
      params.push(opts.type);
      filterSql += ` AND p.type = $${params.length}`;
    }

    if (opts?.exclude_slugs?.length) {
      params.push(opts.exclude_slugs.map((slug) => validateSlug(slug)));
      filterSql += ` AND p.slug != ALL($${params.length}::text[])`;
    }

    return this.withSearchTimeout(async (sql) => {
      const rows = await sql.unsafe(
        `SELECT DISTINCT ON (ranked.slug)
          ranked.slug, ranked.page_id, ranked.title, ranked.type,
          CASE
            WHEN ranked.frontmatter_score > ranked.chunk_score THEN ranked.search_text
            ELSE ranked.chunk_text
          END AS chunk_text,
          CASE
            WHEN ranked.frontmatter_score > ranked.chunk_score THEN 'frontmatter'
            ELSE ranked.chunk_source
          END AS chunk_source,
          ranked.page_score AS score,
          ranked.stale
        FROM (
          SELECT
            p.slug,
            p.id AS page_id,
            p.title,
            p.type,
            p.search_text,
            cc.chunk_text,
            cc.chunk_source,
            cc.chunk_index,
            ts_rank(to_tsvector('english', coalesce(p.search_text, '')), websearch_to_tsquery('english', $1)) AS frontmatter_score,
            ts_rank(to_tsvector('english', coalesce(cc.chunk_text, '')), websearch_to_tsquery('english', $1)) AS chunk_score,
            ts_rank(p.search_vector, websearch_to_tsquery('english', $1)) AS page_score,
            CASE WHEN p.updated_at < (
              SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
            ) THEN true ELSE false END AS stale
          FROM pages p
          JOIN content_chunks cc ON cc.page_id = p.id
          WHERE p.search_vector @@ websearch_to_tsquery('english', $1)${filterSql}
        ) ranked
        ORDER BY ranked.slug, GREATEST(ranked.frontmatter_score, ranked.chunk_score) DESC, ranked.page_score DESC, ranked.chunk_index ASC`,
        params,
      );

      rows.sort((a: any, b: any) => b.score - a.score);
      rows.splice(limit);

      return rows.map(rowToSearchResult);
    });
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;
    const vecStr = '[' + Array.from(embedding).join(',') + ']';
    const params: unknown[] = [vecStr];
    let filterSql = '';

    if (opts?.type) {
      params.push(opts.type);
      filterSql += ` AND p.type = $${params.length}`;
    }

    if (opts?.exclude_slugs?.length) {
      params.push(opts.exclude_slugs.map((slug) => validateSlug(slug)));
      filterSql += ` AND p.slug != ALL($${params.length}::text[])`;
    }

    params.push(limit);

    return this.withSearchTimeout(async (sql) => {
      const rows = await sql.unsafe(
        `SELECT
          p.slug, p.id as page_id, p.title, p.type,
          cc.chunk_text, cc.chunk_source,
          1 - (cc.embedding <=> $1::vector) AS score,
          CASE WHEN p.updated_at < (
            SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
          ) THEN true ELSE false END AS stale
        FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE cc.embedding IS NOT NULL${filterSql}
        ORDER BY cc.embedding <=> $1::vector
        LIMIT $${params.length}`,
        params,
      );

      return rows.map(rowToSearchResult);
    });
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
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, embeddingStr, chunk.model || 'nomic-embed-text', chunk.token_count || null);
      } else {
        rows.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, NULL)`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, chunk.model || 'nomic-embed-text', chunk.token_count || null);
      }
    }

    // Single statement upsert: preserves existing embeddings via COALESCE when new value is NULL
    await sql.unsafe(
      `INSERT INTO content_chunks ${cols} VALUES ${rows.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = COALESCE(EXCLUDED.embedding, content_chunks.embedding),
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

  async getPageEmbeddings(type?: PageType): Promise<Array<{
    page_id: number;
    slug: string;
    embedding: Float32Array | null;
  }>> {
    const sql = this.sql;
    const rows = type
      ? await sql`
        SELECT p.id AS page_id, p.slug, p.page_embedding AS embedding
        FROM pages p
        WHERE p.type = ${type}
        ORDER BY p.slug
      `
      : await sql`
        SELECT p.id AS page_id, p.slug, p.page_embedding AS embedding
        FROM pages p
        ORDER BY p.slug
      `;

    return rows.map((row: Record<string, unknown>) => ({
      page_id: Number(row.page_id),
      slug: String(row.slug),
      embedding: vectorValueToFloat32(row.embedding),
    }));
  }

  async updatePageEmbedding(slug: string, embedding: Float32Array | null): Promise<void> {
    const sql = this.sql;
    const rows = embedding
      ? await sql`
        UPDATE pages
        SET page_embedding = ${vectorLiteral(embedding)}::vector(768)
        WHERE slug = ${slug}
        RETURNING id
      `
      : await sql`
        UPDATE pages
        SET page_embedding = NULL
        WHERE slug = ${slug}
        RETURNING id
      `;

    if (rows.length === 0) {
      throw new Error(`Page not found: ${validateSlug(slug)}`);
    }
  }

  // Links
  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    const sql = this.sql;
    await sql`
      INSERT INTO links (from_page_id, to_page_id, link_type, context)
      SELECT f.id, t.id, ${linkType || ''}, ${context || ''}
      FROM pages f, pages t
      WHERE f.slug = ${from} AND t.slug = ${to}
      ON CONFLICT (from_page_id, to_page_id) DO UPDATE SET
        link_type = EXCLUDED.link_type,
        context = EXCLUDED.context
    `;
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
    await sql`
      INSERT INTO tags (page_id, tag)
      SELECT id, ${tag} FROM pages WHERE slug = ${slug}
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
    await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, ${entry.date}::date, ${entry.source || ''}, ${entry.summary}, ${entry.detail || ''}
      FROM pages WHERE slug = ${slug}
    `;
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
    await sql`
      INSERT INTO raw_data (page_id, source, data)
      SELECT id, ${source}, ${JSON.stringify(data)}::jsonb
      FROM pages WHERE slug = ${slug}
      ON CONFLICT (page_id, source) DO UPDATE SET
        data = EXCLUDED.data,
        fetched_at = now()
    `;
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
    const rows = await sql`
      SELECT pv.compiled_truth, pv.frontmatter, p.title, p.type, p.timeline
      FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ${slug} AND pv.id = ${versionId}
      LIMIT 1
    `;
    if (rows.length === 0) return;

    const version = rows[0] as {
      compiled_truth: string;
      frontmatter: unknown;
      title: string;
      type: PageType;
      timeline?: unknown;
    };
    const frontmatter = (
      version.frontmatter && typeof version.frontmatter === 'object' && !Array.isArray(version.frontmatter)
    )
      ? version.frontmatter as Record<string, unknown>
      : typeof version.frontmatter === 'string' && version.frontmatter.length > 0
        ? JSON.parse(version.frontmatter) as Record<string, unknown>
        : {};
    const tags = await this.getTags(slug);
    const searchText = buildFrontmatterSearchText(frontmatter);
    const hash = importContentHash({
      title: version.title,
      type: version.type,
      compiled_truth: version.compiled_truth,
      timeline: String(version.timeline ?? ''),
      frontmatter,
      tags,
    });

    await sql`
      UPDATE pages
      SET compiled_truth = ${version.compiled_truth},
          search_text = ${searchText},
          frontmatter = ${JSON.stringify(frontmatter)}::jsonb,
          content_hash = ${hash},
          updated_at = now()
      WHERE slug = ${slug}
    `;

    const page = await this.getPage(slug);
    if (page) {
      await ensurePageChunks(this, page);
    }
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
         WHERE p.updated_at < (SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id)
        ) as stale_pages,
        (SELECT count(*) FROM pages p
         WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
        ) as orphan_pages,
        (SELECT count(*) FROM links l
         WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)
        ) as dead_links,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NULL) as missing_embeddings
    `;

    return {
      page_count: Number(h.page_count),
      embed_coverage: Number(h.embed_coverage),
      stale_pages: Number(h.stale_pages),
      orphan_pages: Number(h.orphan_pages),
      dead_links: Number(h.dead_links),
      missing_embeddings: Number(h.missing_embeddings),
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
