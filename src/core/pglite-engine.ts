import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Transaction } from '@electric-sql/pglite';
import type { BrainEngine } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { PGLITE_SCHEMA_SQL } from './pglite-schema.ts';
import { acquireLock, releaseLock, type LockHandle } from './pglite-lock.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
import { ensurePageChunks } from './page-chunks.ts';
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
import { validateSlug, contentHash, importContentHash, rowToPage, rowToChunk, rowToSearchResult } from './utils.ts';

type PGLiteDB = PGlite;

export class PGLiteEngine implements BrainEngine {
  private _db: PGLiteDB | null = null;
  private _lock: LockHandle | null = null;

  get db(): PGLiteDB {
    if (!this._db) throw new Error('PGLite not connected. Call connect() first.');
    return this._db;
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
    await this.db.exec(PGLITE_SCHEMA_SQL);

    const { applied } = await runMigrations(this);
    if (applied > 0) {
      console.log(`  ${applied} migration(s) applied`);
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return this.db.transaction(async (tx) => {
      const txEngine = Object.create(this) as PGLiteEngine;
      Object.defineProperty(txEngine, 'db', { get: () => tx });
      return fn(txEngine);
    });
  }

  // Pages CRUD
  async getPage(slug: string): Promise<Page | null> {
    const { rows } = await this.db.query(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
       FROM pages WHERE slug = $1`,
      [slug]
    );
    if (rows.length === 0) return null;
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    slug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page.compiled_truth, page.timeline || '');
    const frontmatter = page.frontmatter || {};
    const searchText = buildFrontmatterSearchText(frontmatter);

    const { rows } = await this.db.query(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, search_text, frontmatter, content_hash, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
       ON CONFLICT (slug) DO UPDATE SET
         type = EXCLUDED.type,
         title = EXCLUDED.title,
         compiled_truth = EXCLUDED.compiled_truth,
         timeline = EXCLUDED.timeline,
         search_text = EXCLUDED.search_text,
         frontmatter = EXCLUDED.frontmatter,
         content_hash = EXCLUDED.content_hash,
         updated_at = now()
       RETURNING id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at`,
      [slug, page.type, page.title, page.compiled_truth, page.timeline || '', searchText, JSON.stringify(frontmatter), hash]
    );
    return rowToPage(rows[0] as Record<string, unknown>);
  }

  async deletePage(slug: string): Promise<void> {
    await this.db.query('DELETE FROM pages WHERE slug = $1', [slug]);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    let result;
    if (filters?.type && filters?.tag) {
      result = await this.db.query(
        `SELECT p.* FROM pages p
         JOIN tags t ON t.page_id = p.id
         WHERE p.type = $1 AND t.tag = $2
         ORDER BY p.updated_at DESC, p.id DESC LIMIT $3 OFFSET $4`,
        [filters.type, filters.tag, limit, offset]
      );
    } else if (filters?.type) {
      result = await this.db.query(
        `SELECT * FROM pages WHERE type = $1
         ORDER BY updated_at DESC, id DESC LIMIT $2 OFFSET $3`,
        [filters.type, limit, offset]
      );
    } else if (filters?.tag) {
      result = await this.db.query(
        `SELECT p.* FROM pages p
         JOIN tags t ON t.page_id = p.id
         WHERE t.tag = $1
         ORDER BY p.updated_at DESC, p.id DESC LIMIT $2 OFFSET $3`,
        [filters.tag, limit, offset]
      );
    } else {
      result = await this.db.query(
        `SELECT * FROM pages
         ORDER BY updated_at DESC, id DESC LIMIT $1 OFFSET $2`,
        [limit, offset]
      );
    }

    return (result.rows as Record<string, unknown>[]).map(rowToPage);
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
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;
    const params: unknown[] = [query];
    let filterSql = '';

    if (opts?.type) {
      params.push(opts.type);
      filterSql += ` AND p.type = $${params.length}`;
    }

    if (opts?.exclude_slugs?.length) {
      const excludeSlugs = opts.exclude_slugs.map((slug) => validateSlug(slug));
      const placeholderStart = params.length + 1;
      filterSql += ` AND p.slug NOT IN (${excludeSlugs.map((_, idx) => `$${placeholderStart + idx}`).join(', ')})`;
      params.push(...excludeSlugs);
    }

    const { rows } = await this.db.query(
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
      params
    );

    // Re-sort by score (DISTINCT ON requires ORDER BY slug first) and apply limit
    const sorted = (rows as Record<string, unknown>[]).sort(
      (a: any, b: any) => b.score - a.score
    );
    sorted.splice(limit);

    return sorted.map(rowToSearchResult);
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
      const excludeSlugs = opts.exclude_slugs.map((slug) => validateSlug(slug));
      const placeholderStart = params.length + 1;
      filterSql += ` AND p.slug NOT IN (${excludeSlugs.map((_, idx) => `$${placeholderStart + idx}`).join(', ')})`;
      params.push(...excludeSlugs);
    }

    params.push(limit);

    const { rows } = await this.db.query(
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
      params
    );

    return (rows as Record<string, unknown>[]).map(rowToSearchResult);
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

    // Batch upsert: build dynamic multi-row INSERT
    const cols = '(page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)';
    const rowParts: string[] = [];
    const params: unknown[] = [];
    let paramIdx = 1;

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;

      if (embeddingStr) {
        rowParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}::vector, $${paramIdx++}, $${paramIdx++}, now())`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, embeddingStr, chunk.model || 'nomic-embed-text', chunk.token_count || null);
      } else {
        rowParts.push(`($${paramIdx++}, $${paramIdx++}, $${paramIdx++}, $${paramIdx++}, NULL, $${paramIdx++}, $${paramIdx++}, NULL)`);
        params.push(pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source, chunk.model || 'nomic-embed-text', chunk.token_count || null);
      }
    }

    await this.db.query(
      `INSERT INTO content_chunks ${cols} VALUES ${rowParts.join(', ')}
       ON CONFLICT (page_id, chunk_index) DO UPDATE SET
         chunk_text = EXCLUDED.chunk_text,
         chunk_source = EXCLUDED.chunk_source,
         embedding = COALESCE(EXCLUDED.embedding, content_chunks.embedding),
         model = COALESCE(EXCLUDED.model, content_chunks.model),
         token_count = EXCLUDED.token_count,
         embedded_at = COALESCE(EXCLUDED.embedded_at, content_chunks.embedded_at)`,
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

  async deleteChunks(slug: string): Promise<void> {
    await this.db.query(
      `DELETE FROM content_chunks
       WHERE page_id = (SELECT id FROM pages WHERE slug = $1)`,
      [slug]
    );
  }

  // Links
  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    await this.db.query(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context)
       SELECT f.id, t.id, $3, $4
       FROM pages f, pages t
       WHERE f.slug = $1 AND t.slug = $2
       ON CONFLICT (from_page_id, to_page_id) DO UPDATE SET
         link_type = EXCLUDED.link_type,
         context = EXCLUDED.context`,
      [from, to, linkType || '', context || '']
    );
  }

  async removeLink(from: string, to: string): Promise<void> {
    await this.db.query(
      `DELETE FROM links
       WHERE from_page_id = (SELECT id FROM pages WHERE slug = $1)
         AND to_page_id = (SELECT id FROM pages WHERE slug = $2)`,
      [from, to]
    );
  }

  async getLinks(slug: string): Promise<Link[]> {
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       WHERE f.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const { rows } = await this.db.query(
      `SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       WHERE t.slug = $1`,
      [slug]
    );
    return rows as unknown as Link[];
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const { rows } = await this.db.query(
      `WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth
        FROM pages p WHERE p.slug = $1

        UNION

        SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < $2
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
  async addTimelineEntry(slug: string, entry: TimelineInput): Promise<void> {
    await this.db.query(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT id, $2::date, $3, $4, $5
       FROM pages WHERE slug = $1`,
      [slug, entry.date, entry.source || '', entry.summary, entry.detail || '']
    );
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
    const { rows } = await this.db.query(
      `SELECT pv.compiled_truth, pv.frontmatter, p.title, p.type, p.timeline
       FROM page_versions pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = $1 AND pv.id = $2
       LIMIT 1`,
      [slug, versionId]
    );
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
      title: version.title as string,
      type: version.type as PageType,
      compiled_truth: version.compiled_truth,
      timeline: String(version.timeline ?? ''),
      frontmatter,
      tags,
    });

    await this.db.query(
      `UPDATE pages
       SET compiled_truth = $1,
           search_text = $2,
           frontmatter = $3::jsonb,
           content_hash = $4,
           updated_at = now()
       WHERE slug = $5`,
      [version.compiled_truth, searchText, JSON.stringify(frontmatter), hash, slug]
    );

    const page = await this.getPage(slug);
    if (page) {
      await ensurePageChunks(this, page);
    }
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const { rows: [stats] } = await this.db.query(`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
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
    const { rows: [h] } = await this.db.query(`
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
    `);

    const r = h as Record<string, unknown>;
    return {
      page_count: Number(r.page_count),
      embed_coverage: Number(r.embed_coverage),
      stale_pages: Number(r.stale_pages),
      orphan_pages: Number(r.orphan_pages),
      dead_links: Number(r.dead_links),
      missing_embeddings: Number(r.missing_embeddings),
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
}
