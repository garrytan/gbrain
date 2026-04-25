import { PGlite } from '@electric-sql/pglite';
import { vector } from '@electric-sql/pglite/vector';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import type { Transaction } from '@electric-sql/pglite';
import type { BrainEngine } from './engine.ts';
import {
  assertMemoryCandidateCreateStatus,
  isAllowedMemoryCandidateStatusUpdate,
} from './memory-inbox-status.ts';
import { runMigrations } from './migrate.ts';
import { PGLITE_SCHEMA_SQL } from './pglite-schema.ts';
import { acquireLock, releaseLock, type LockHandle } from './pglite-lock.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
import { ensurePageChunks } from './page-chunks.ts';
import { buildPageCentroid } from './services/page-embedding.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  NoteManifestEntry,
  NoteManifestEntryInput,
  NoteManifestFilters,
  NoteSectionEntry,
  NoteSectionEntryInput,
  NoteSectionFilters,
  ContextMapEntry,
  ContextMapEntryInput,
  ContextMapFilters,
  ContextAtlasEntry,
  ContextAtlasEntryInput,
  ContextAtlasFilters,
  MemoryCandidateEntry,
  MemoryCandidateContradictionEntry,
  MemoryCandidateContradictionEntryInput,
  MemoryCandidateEntryInput,
  MemoryCandidateFilters,
  MemoryCandidatePromotionPatch,
  MemoryCandidateSupersessionEntry,
  MemoryCandidateSupersessionInput,
  MemoryCandidateStatusPatch,
  CanonicalHandoffEntry,
  CanonicalHandoffEntryInput,
  CanonicalHandoffFilters,
  ProfileMemoryEntry,
  ProfileMemoryEntryInput,
  ProfileMemoryFilters,
  PersonalEpisodeEntry,
  PersonalEpisodeEntryInput,
  PersonalEpisodeFilters,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
  RetrievalTrace,
  RetrievalTraceInput,
  RetrievalTraceWindowFilters,
  TaskAttempt,
  TaskAttemptInput,
  TaskDecision,
  TaskDecisionInput,
  TaskThread,
  TaskThreadFilters,
  TaskThreadInput,
  TaskThreadPatch,
  TaskWorkingSet,
  TaskWorkingSetInput,
} from './types.ts';
import {
  validateSlug,
  contentHash,
  importContentHash,
  rowToPage,
  rowToChunk,
  rowToContextAtlasEntry,
  rowToContextMapEntry,
  rowToMemoryCandidateEntry,
  rowToMemoryCandidateContradictionEntry,
  rowToMemoryCandidateSupersessionEntry,
  rowToCanonicalHandoffEntry,
  rowToNoteManifestEntry,
  rowToNoteSectionEntry,
  rowToProfileMemoryEntry,
  rowToPersonalEpisodeEntry,
  rowToSearchResult,
  rowToRetrievalTrace,
  rowToTaskAttempt,
  rowToTaskDecision,
  rowToTaskThread,
  rowToTaskWorkingSet,
} from './utils.ts';

type PGLiteDB = PGlite;
const INTERACTION_ID_LOOKUP_BATCH_SIZE = 500;

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
      await this.refreshPageEmbeddingFromChunks(pageId);
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

    await this.refreshPageEmbeddingFromChunks(pageId);
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
    const { rows } = await this.db.query('SELECT id FROM pages WHERE slug = $1', [slug]);
    if (rows.length === 0) return;

    const pageId = Number((rows[0] as { id: number }).id);
    await this.db.query('DELETE FROM content_chunks WHERE page_id = $1', [pageId]);
    await this.refreshPageEmbeddingFromChunks(pageId);
  }

  async getPageEmbeddings(type?: PageType): Promise<Array<{
    page_id: number;
    slug: string;
    embedding: Float32Array | null;
  }>> {
    const query = type
      ? `SELECT p.id AS page_id, p.slug, p.page_embedding AS embedding
         FROM pages p
         WHERE p.type = $1
         ORDER BY p.slug`
      : `SELECT p.id AS page_id, p.slug, p.page_embedding AS embedding
         FROM pages p
         ORDER BY p.slug`;
    const params = type ? [type] : [];
    const { rows } = await this.db.query(query, params);

    return (rows as Record<string, unknown>[]).map((row) => ({
      page_id: Number(row.page_id),
      slug: String(row.slug),
      embedding: vectorValueToFloat32(row.embedding),
    }));
  }

  async updatePageEmbedding(slug: string, embedding: Float32Array | null): Promise<void> {
    const query = embedding
      ? `UPDATE pages
         SET page_embedding = $1::vector(768)
         WHERE slug = $2
         RETURNING id`
      : `UPDATE pages
         SET page_embedding = NULL
         WHERE slug = $1
         RETURNING id`;
    const params = embedding ? [vectorLiteral(embedding), slug] : [slug];
    const { rows } = await this.db.query(query, params);

    if (rows.length === 0) {
      throw new Error(`Page not found: ${validateSlug(slug)}`);
    }
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

  async createTaskThread(input: TaskThreadInput): Promise<TaskThread> {
    const { rows } = await this.db.query(
      `INSERT INTO task_threads (
        id, scope, title, goal, status, repo_path, branch_name, current_summary
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      RETURNING id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at`,
      [
        input.id,
        input.scope,
        input.title,
        input.goal ?? '',
        input.status,
        input.repo_path ?? null,
        input.branch_name ?? null,
        input.current_summary ?? '',
      ],
    );
    return rowToTaskThread(rows[0] as Record<string, unknown>);
  }

  async updateTaskThread(id: string, patch: TaskThreadPatch): Promise<TaskThread> {
    const current = await this.getTaskThread(id);
    if (!current) throw new Error(`Task thread not found: ${id}`);

    const { rows } = await this.db.query(
      `UPDATE task_threads
       SET scope = $2,
           title = $3,
           goal = $4,
           status = $5,
           repo_path = $6,
           branch_name = $7,
           current_summary = $8,
           updated_at = now()
       WHERE id = $1
       RETURNING id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at`,
      [
        id,
        patch.scope ?? current.scope,
        patch.title ?? current.title,
        patch.goal ?? current.goal,
        patch.status ?? current.status,
        patch.repo_path === undefined ? current.repo_path : patch.repo_path,
        patch.branch_name === undefined ? current.branch_name : patch.branch_name,
        patch.current_summary ?? current.current_summary,
      ],
    );
    return rowToTaskThread(rows[0] as Record<string, unknown>);
  }

  async listTaskThreads(filters?: TaskThreadFilters): Promise<TaskThread[]> {
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope) {
      params.push(filters.scope);
      clauses.push(`scope = $${params.length}`);
    }
    if (filters?.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
       FROM task_threads
       ${whereClause}
       ORDER BY updated_at DESC, id DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );

    return (rows as Record<string, unknown>[]).map(rowToTaskThread);
  }

  async getTaskThread(id: string): Promise<TaskThread | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
       FROM task_threads
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToTaskThread(rows[0] as Record<string, unknown>);
  }

  async getTaskWorkingSet(taskId: string): Promise<TaskWorkingSet | null> {
    const { rows } = await this.db.query(
      `SELECT task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
       FROM task_working_sets
       WHERE task_id = $1`,
      [taskId],
    );
    if (rows.length === 0) return null;
    return rowToTaskWorkingSet(rows[0] as Record<string, unknown>);
  }

  async upsertTaskWorkingSet(input: TaskWorkingSetInput): Promise<TaskWorkingSet> {
    const { rows } = await this.db.query(
      `INSERT INTO task_working_sets (
        task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
      ) VALUES ($1, $2::jsonb, $3::jsonb, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, now())
      ON CONFLICT (task_id) DO UPDATE SET
        active_paths = EXCLUDED.active_paths,
        active_symbols = EXCLUDED.active_symbols,
        blockers = EXCLUDED.blockers,
        open_questions = EXCLUDED.open_questions,
        next_steps = EXCLUDED.next_steps,
        verification_notes = EXCLUDED.verification_notes,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = now()
      RETURNING task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at`,
      [
        input.task_id,
        JSON.stringify(input.active_paths ?? []),
        JSON.stringify(input.active_symbols ?? []),
        JSON.stringify(input.blockers ?? []),
        JSON.stringify(input.open_questions ?? []),
        JSON.stringify(input.next_steps ?? []),
        JSON.stringify(input.verification_notes ?? []),
        input.last_verified_at instanceof Date ? input.last_verified_at.toISOString() : input.last_verified_at ?? null,
      ],
    );
    return rowToTaskWorkingSet(rows[0] as Record<string, unknown>);
  }

  async recordTaskAttempt(input: TaskAttemptInput): Promise<TaskAttempt> {
    const { rows } = await this.db.query(
      `INSERT INTO task_attempts (
        id, task_id, summary, outcome, applicability_context, evidence
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      RETURNING id, task_id, summary, outcome, applicability_context, evidence, created_at`,
      [
        input.id,
        input.task_id,
        input.summary,
        input.outcome,
        JSON.stringify(input.applicability_context ?? {}),
        JSON.stringify(input.evidence ?? []),
      ],
    );
    return rowToTaskAttempt(rows[0] as Record<string, unknown>);
  }

  async listTaskAttempts(taskId: string, opts?: { limit?: number }): Promise<TaskAttempt[]> {
    const { rows } = await this.db.query(
      `SELECT id, task_id, summary, outcome, applicability_context, evidence, created_at
       FROM task_attempts
       WHERE task_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [taskId, opts?.limit ?? 20],
    );
    return (rows as Record<string, unknown>[]).map(rowToTaskAttempt);
  }

  async recordTaskDecision(input: TaskDecisionInput): Promise<TaskDecision> {
    const { rows } = await this.db.query(
      `INSERT INTO task_decisions (
        id, task_id, summary, rationale, consequences, validity_context
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
      RETURNING id, task_id, summary, rationale, consequences, validity_context, created_at`,
      [
        input.id,
        input.task_id,
        input.summary,
        input.rationale,
        JSON.stringify(input.consequences ?? []),
        JSON.stringify(input.validity_context ?? {}),
      ],
    );
    return rowToTaskDecision(rows[0] as Record<string, unknown>);
  }

  async listTaskDecisions(taskId: string, opts?: { limit?: number }): Promise<TaskDecision[]> {
    const { rows } = await this.db.query(
      `SELECT id, task_id, summary, rationale, consequences, validity_context, created_at
       FROM task_decisions
       WHERE task_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [taskId, opts?.limit ?? 20],
    );
    return (rows as Record<string, unknown>[]).map(rowToTaskDecision);
  }

  async putRetrievalTrace(input: RetrievalTraceInput): Promise<RetrievalTrace> {
    const { rows } = await this.db.query(
      `INSERT INTO retrieval_traces (
        id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome
      ) VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb, $7::jsonb, $8, $9, $10, $11, $12)
      RETURNING id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at`,
      [
        input.id,
        input.task_id ?? null,
        input.scope,
        JSON.stringify(input.route ?? []),
        JSON.stringify(input.source_refs ?? []),
        JSON.stringify(input.derived_consulted ?? []),
        JSON.stringify(input.verification ?? []),
        input.write_outcome ?? 'no_durable_write',
        input.selected_intent ?? null,
        input.scope_gate_policy ?? null,
        input.scope_gate_reason ?? null,
        input.outcome,
      ],
    );
    return rowToRetrievalTrace(rows[0] as Record<string, unknown>);
  }

  async getRetrievalTrace(id: string): Promise<RetrievalTrace | null> {
    const { rows } = await this.db.query(
      `SELECT id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
       FROM retrieval_traces
       WHERE id = $1`,
      [id],
    );
    const [row] = rows as Record<string, unknown>[];
    return row ? rowToRetrievalTrace(row) : null;
  }

  async listRetrievalTraces(taskId: string, opts?: { limit?: number }): Promise<RetrievalTrace[]> {
    const { rows } = await this.db.query(
      `SELECT id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
       FROM retrieval_traces
       WHERE task_id = $1
       ORDER BY created_at DESC, id DESC
       LIMIT $2`,
      [taskId, opts?.limit ?? 20],
    );
    return (rows as Record<string, unknown>[]).map(rowToRetrievalTrace);
  }

  async listRetrievalTracesByWindow(filters: RetrievalTraceWindowFilters): Promise<RetrievalTrace[]> {
    const params: unknown[] = [filters.since.toISOString(), filters.until.toISOString()];
    const clauses = ['created_at >= $1', 'created_at < $2'];

    if (filters.task_id !== undefined) {
      params.push(filters.task_id);
      clauses.push(`task_id = $${params.length}`);
    }
    if (filters.scope !== undefined) {
      params.push(filters.scope);
      clauses.push(`scope = $${params.length}`);
    }

    params.push(filters.limit ?? 500);
    params.push(filters.offset ?? 0);
    const { rows } = await this.db.query(
      `SELECT id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
       FROM retrieval_traces
       WHERE ${clauses.join(' AND ')}
       ORDER BY created_at DESC, id DESC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToRetrievalTrace);
  }

  async upsertProfileMemoryEntry(input: ProfileMemoryEntryInput): Promise<ProfileMemoryEntry> {
    const { rows } = await this.db.query(
      `INSERT INTO profile_memory_entries (
        id, scope_id, profile_type, subject, content, source_refs, sensitivity,
        export_status, last_confirmed_at, superseded_by
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10)
      ON CONFLICT (id) DO UPDATE SET
        scope_id = EXCLUDED.scope_id,
        profile_type = EXCLUDED.profile_type,
        subject = EXCLUDED.subject,
        content = EXCLUDED.content,
        source_refs = EXCLUDED.source_refs,
        sensitivity = EXCLUDED.sensitivity,
        export_status = EXCLUDED.export_status,
        last_confirmed_at = EXCLUDED.last_confirmed_at,
        superseded_by = EXCLUDED.superseded_by,
        updated_at = now()
      RETURNING id, scope_id, profile_type, subject, content, source_refs, sensitivity,
                export_status, last_confirmed_at, superseded_by, created_at, updated_at`,
      [
        input.id,
        input.scope_id,
        input.profile_type,
        input.subject,
        input.content,
        JSON.stringify(input.source_refs ?? []),
        input.sensitivity,
        input.export_status,
        input.last_confirmed_at instanceof Date ? input.last_confirmed_at.toISOString() : input.last_confirmed_at ?? null,
        input.superseded_by ?? null,
      ],
    );
    return rowToProfileMemoryEntry(rows[0] as Record<string, unknown>);
  }

  async getProfileMemoryEntry(id: string): Promise<ProfileMemoryEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, profile_type, subject, content, source_refs, sensitivity,
              export_status, last_confirmed_at, superseded_by, created_at, updated_at
       FROM profile_memory_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToProfileMemoryEntry(rows[0] as Record<string, unknown>);
  }

  async listProfileMemoryEntries(filters?: ProfileMemoryFilters): Promise<ProfileMemoryEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.subject) {
      params.push(filters.subject);
      clauses.push(`subject = $${params.length}`);
    }
    if (filters?.profile_type) {
      params.push(filters.profile_type);
      clauses.push(`profile_type = $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, scope_id, profile_type, subject, content, source_refs, sensitivity,
              export_status, last_confirmed_at, superseded_by, created_at, updated_at
       FROM profile_memory_entries
       ${whereClause}
       ORDER BY updated_at DESC, id ASC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToProfileMemoryEntry);
  }

  async deleteProfileMemoryEntry(id: string): Promise<void> {
    await this.db.query(`DELETE FROM profile_memory_entries WHERE id = $1`, [id]);
  }

  async createPersonalEpisodeEntry(input: PersonalEpisodeEntryInput): Promise<PersonalEpisodeEntry> {
    const { rows } = await this.db.query(
      `INSERT INTO personal_episode_entries (
        id, scope_id, title, start_time, end_time, source_kind, summary, source_refs, candidate_ids
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)
      RETURNING id, scope_id, title, start_time, end_time, source_kind, summary,
                source_refs, candidate_ids, created_at, updated_at`,
      [
        input.id,
        input.scope_id,
        input.title,
        input.start_time instanceof Date ? input.start_time.toISOString() : input.start_time,
        input.end_time instanceof Date ? input.end_time.toISOString() : input.end_time ?? null,
        input.source_kind,
        input.summary,
        JSON.stringify(input.source_refs ?? []),
        JSON.stringify(input.candidate_ids ?? []),
      ],
    );
    return rowToPersonalEpisodeEntry(rows[0] as Record<string, unknown>);
  }

  async getPersonalEpisodeEntry(id: string): Promise<PersonalEpisodeEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, title, start_time, end_time, source_kind, summary,
              source_refs, candidate_ids, created_at, updated_at
       FROM personal_episode_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToPersonalEpisodeEntry(rows[0] as Record<string, unknown>);
  }

  async listPersonalEpisodeEntries(filters?: PersonalEpisodeFilters): Promise<PersonalEpisodeEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.title) {
      params.push(filters.title);
      clauses.push(`title = $${params.length}`);
    }
    if (filters?.source_kind) {
      params.push(filters.source_kind);
      clauses.push(`source_kind = $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, scope_id, title, start_time, end_time, source_kind, summary,
              source_refs, candidate_ids, created_at, updated_at
       FROM personal_episode_entries
       ${whereClause}
       ORDER BY start_time DESC, id ASC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToPersonalEpisodeEntry);
  }

  async deletePersonalEpisodeEntry(id: string): Promise<void> {
    await this.db.query(`DELETE FROM personal_episode_entries WHERE id = $1`, [id]);
  }

  async createMemoryCandidateEntry(input: MemoryCandidateEntryInput): Promise<MemoryCandidateEntry> {
    const initialStatus = assertMemoryCandidateCreateStatus(input.status);
    const { rows } = await this.db.query(
      `INSERT INTO memory_candidate_entries (
        id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
        extraction_kind, confidence_score, importance_score, recurrence_score,
        sensitivity, status, target_object_type, target_object_id, reviewed_at,
        review_reason
      ) VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
      RETURNING id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
                extraction_kind, confidence_score, importance_score, recurrence_score,
                sensitivity, status, target_object_type, target_object_id, reviewed_at,
                review_reason, created_at, updated_at`,
      [
        input.id,
        input.scope_id,
        input.candidate_type,
        input.proposed_content,
        JSON.stringify(input.source_refs ?? []),
        input.generated_by,
        input.extraction_kind,
        input.confidence_score,
        input.importance_score,
        input.recurrence_score,
        input.sensitivity,
        initialStatus,
        input.target_object_type ?? null,
        input.target_object_id ?? null,
        input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null,
        input.review_reason ?? null,
      ],
    );
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async getMemoryCandidateEntry(id: string): Promise<MemoryCandidateEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
              extraction_kind, confidence_score, importance_score, recurrence_score,
              sensitivity, status, target_object_type, target_object_id, reviewed_at,
              review_reason, created_at, updated_at
       FROM memory_candidate_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async listMemoryCandidateEntries(filters?: MemoryCandidateFilters): Promise<MemoryCandidateEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.status) {
      params.push(filters.status);
      clauses.push(`status = $${params.length}`);
    }
    if (filters?.candidate_type) {
      params.push(filters.candidate_type);
      clauses.push(`candidate_type = $${params.length}`);
    }
    if (filters?.target_object_type) {
      params.push(filters.target_object_type);
      clauses.push(`target_object_type = $${params.length}`);
    }
    if (filters?.target_object_id !== undefined) {
      params.push(filters.target_object_id);
      clauses.push(`target_object_id = $${params.length}`);
    }
    if (filters?.created_since !== undefined) {
      params.push(filters.created_since.toISOString());
      clauses.push(`created_at >= $${params.length}`);
    }
    if (filters?.created_until !== undefined) {
      params.push(filters.created_until.toISOString());
      clauses.push(`created_at < $${params.length}`);
    }
    if (filters?.reviewed_since !== undefined) {
      params.push(filters.reviewed_since.toISOString());
      clauses.push(`reviewed_at >= $${params.length}`);
    }
    if (filters?.reviewed_until !== undefined) {
      params.push(filters.reviewed_until.toISOString());
      clauses.push(`reviewed_at < $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
              extraction_kind, confidence_score, importance_score, recurrence_score,
              sensitivity, status, target_object_type, target_object_id, reviewed_at,
              review_reason, created_at, updated_at
       FROM memory_candidate_entries
       ${whereClause}
       ORDER BY updated_at DESC, id ASC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToMemoryCandidateEntry);
  }

  async updateMemoryCandidateEntryStatus(id: string, patch: MemoryCandidateStatusPatch): Promise<MemoryCandidateEntry | null> {
    const current = await this.getMemoryCandidateEntry(id);
    if (!current) {
      throw new Error(`Memory candidate entry not found before status update: ${id}`);
    }
    if (!isAllowedMemoryCandidateStatusUpdate(current.status, patch.status)) {
      throw new Error(`Cannot update memory candidate from ${current.status} to ${patch.status}.`);
    }

    const { rows } = await this.db.query(
      `UPDATE memory_candidate_entries
      SET status = $2,
          reviewed_at = $3,
          review_reason = $4,
          updated_at = now()
      WHERE id = $1
        AND status = $5
      RETURNING id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
                extraction_kind, confidence_score, importance_score, recurrence_score,
                sensitivity, status, target_object_type, target_object_id, reviewed_at,
                 review_reason, created_at, updated_at`,
      [
        id,
        patch.status,
        patch.reviewed_at instanceof Date ? patch.reviewed_at.toISOString() : patch.reviewed_at ?? null,
        patch.review_reason ?? null,
        current.status,
      ],
    );
    if (rows.length === 0) return null;
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async promoteMemoryCandidateEntry(id: string, patch: MemoryCandidatePromotionPatch = {}): Promise<MemoryCandidateEntry | null> {
    // I4: reject promotion unless the candidate has at least one non-blank
    // provenance entry. Keeps direct engine callers fail-closed.
    const { rows } = await this.db.query(
      `UPDATE memory_candidate_entries
       SET status = 'promoted',
           reviewed_at = $2,
           review_reason = $3,
           updated_at = now()
       WHERE id = $1
         AND status = $4
         AND EXISTS (
           SELECT 1
           FROM jsonb_array_elements_text(memory_candidate_entries.source_refs) AS source_ref(value)
           WHERE btrim(source_ref.value) <> ''
         )
       RETURNING id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
                 extraction_kind, confidence_score, importance_score, recurrence_score,
                 sensitivity, status, target_object_type, target_object_id, reviewed_at,
                 review_reason, created_at, updated_at`,
      [
        id,
        patch.reviewed_at instanceof Date ? patch.reviewed_at.toISOString() : patch.reviewed_at ?? null,
        patch.review_reason ?? null,
        patch.expected_current_status ?? 'staged_for_review',
      ],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async supersedeMemoryCandidateEntry(
    input: MemoryCandidateSupersessionInput,
  ): Promise<MemoryCandidateSupersessionEntry | null> {
    const rollbackSentinel = 'memory_candidate_supersession_invalid_replacement';
    try {
      return await this.transaction(async (txBase) => {
        const tx = txBase as PGLiteEngine;
        const { rows: supersededRows } = await tx.db.query(
          `SELECT id, scope_id, status
           FROM memory_candidate_entries
           WHERE id = $1
           FOR UPDATE`,
          [input.superseded_candidate_id],
        );
        const { rows: replacementRows } = await tx.db.query(
          `SELECT id, scope_id, status
           FROM memory_candidate_entries
           WHERE id = $1
           FOR UPDATE`,
          [input.replacement_candidate_id],
        );
        const supersededCandidate = supersededRows[0] as { id: string; scope_id: string; status: string } | undefined;
        const replacementCandidate = replacementRows[0] as { id: string; scope_id: string; status: string } | undefined;
        if (!supersededCandidate || !replacementCandidate) {
          return null;
        }
        if (supersededCandidate.id === replacementCandidate.id) {
          return null;
        }
        if (supersededCandidate.scope_id !== input.scope_id || replacementCandidate.scope_id !== input.scope_id) {
          return null;
        }
        if (supersededCandidate.status !== input.expected_current_status) {
          return null;
        }
        if (replacementCandidate.status !== 'promoted') {
          return null;
        }

        const { rows } = await tx.db.query(
          `INSERT INTO memory_candidate_supersession_entries (
            id, scope_id, superseded_candidate_id, replacement_candidate_id, reviewed_at, review_reason,
            interaction_id
          )
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id, scope_id, superseded_candidate_id, replacement_candidate_id,
                    reviewed_at, review_reason, interaction_id, created_at, updated_at`,
          [
            input.id,
            input.scope_id,
            input.superseded_candidate_id,
            input.replacement_candidate_id,
            input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null,
            input.review_reason ?? null,
            input.interaction_id ?? null,
          ],
        );
        if (rows.length === 0) {
          throw new Error(rollbackSentinel);
        }

        const { rows: updatedRows } = await tx.db.query(
          `UPDATE memory_candidate_entries
           SET status = 'superseded',
               reviewed_at = $2,
               review_reason = $3,
               updated_at = now()
           WHERE id = $1
             AND scope_id = $4
             AND status = $5
           RETURNING id`,
          [
            input.superseded_candidate_id,
            input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null,
            input.review_reason ?? null,
            input.scope_id,
            input.expected_current_status,
          ],
        );
        if (updatedRows.length === 0) {
          throw new Error(rollbackSentinel);
        }

        return rowToMemoryCandidateSupersessionEntry(rows[0] as Record<string, unknown>);
      });
    } catch (error) {
      if (error instanceof Error && error.message === rollbackSentinel) {
        return null;
      }
      if (isSupersessionDuplicateConstraint(error)) {
        return null;
      }
      throw error;
    }
  }

  async getMemoryCandidateSupersessionEntry(id: string): Promise<MemoryCandidateSupersessionEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, superseded_candidate_id, replacement_candidate_id,
              reviewed_at, review_reason, interaction_id, created_at, updated_at
       FROM memory_candidate_supersession_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateSupersessionEntry(rows[0] as Record<string, unknown>);
  }

  async listMemoryCandidateSupersessionEntriesByInteractionIds(
    interactionIds: string[],
  ): Promise<MemoryCandidateSupersessionEntry[]> {
    if (interactionIds.length === 0) return [];
    const entries: MemoryCandidateSupersessionEntry[] = [];
    for (const chunk of chunkInteractionIds(interactionIds)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const { rows } = await this.db.query(
        `SELECT id, scope_id, superseded_candidate_id, replacement_candidate_id,
                reviewed_at, review_reason, interaction_id, created_at, updated_at
         FROM memory_candidate_supersession_entries
         WHERE interaction_id IN (${placeholders})
         ORDER BY created_at DESC, id ASC`,
        chunk,
      );
      entries.push(...(rows as Record<string, unknown>[]).map(rowToMemoryCandidateSupersessionEntry));
    }
    return sortByCreatedAtDescIdAsc(entries);
  }

  async createMemoryCandidateContradictionEntry(
    input: MemoryCandidateContradictionEntryInput,
  ): Promise<MemoryCandidateContradictionEntry | null> {
    const { rows } = await this.db.query(
      `INSERT INTO memory_candidate_contradiction_entries (
        id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
        reviewed_at, review_reason, interaction_id
      )
      SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
      WHERE EXISTS (
        SELECT 1
        FROM memory_candidate_entries candidate
        JOIN memory_candidate_entries challenged
          ON challenged.id = $10
        WHERE candidate.id = $3
          AND candidate.scope_id = $2
          AND challenged.scope_id = $2
      )
        AND (
          $6::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM memory_candidate_supersession_entries
            WHERE id = $6
              AND scope_id = $2
              AND replacement_candidate_id = $3
              AND superseded_candidate_id = $4
          )
        )
      RETURNING id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
                reviewed_at, review_reason, interaction_id, created_at, updated_at`,
      [
        input.id,
        input.scope_id,
        input.candidate_id,
        input.challenged_candidate_id,
        input.outcome,
        input.supersession_entry_id ?? null,
        input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null,
        input.review_reason ?? null,
        input.interaction_id ?? null,
        input.challenged_candidate_id,
      ],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateContradictionEntry(rows[0] as Record<string, unknown>);
  }

  async getMemoryCandidateContradictionEntry(id: string): Promise<MemoryCandidateContradictionEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
              reviewed_at, review_reason, interaction_id, created_at, updated_at
       FROM memory_candidate_contradiction_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateContradictionEntry(rows[0] as Record<string, unknown>);
  }

  async listMemoryCandidateContradictionEntriesByInteractionIds(
    interactionIds: string[],
  ): Promise<MemoryCandidateContradictionEntry[]> {
    if (interactionIds.length === 0) return [];
    const entries: MemoryCandidateContradictionEntry[] = [];
    for (const chunk of chunkInteractionIds(interactionIds)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const { rows } = await this.db.query(
        `SELECT id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
                reviewed_at, review_reason, interaction_id, created_at, updated_at
         FROM memory_candidate_contradiction_entries
         WHERE interaction_id IN (${placeholders})
         ORDER BY created_at DESC, id ASC`,
        chunk,
      );
      entries.push(...(rows as Record<string, unknown>[]).map(rowToMemoryCandidateContradictionEntry));
    }
    return sortByCreatedAtDescIdAsc(entries);
  }

  async createCanonicalHandoffEntry(
    input: CanonicalHandoffEntryInput,
  ): Promise<CanonicalHandoffEntry | null> {
    const { rows } = await this.db.query(
      `INSERT INTO canonical_handoff_entries (
        id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
        reviewed_at, review_reason, interaction_id
      )
      SELECT $1, $2, $3, $4, $5, source_refs, $6, $7, $8
      FROM memory_candidate_entries
      WHERE id = $3
        AND scope_id = $2
        AND status = 'promoted'
        AND target_object_type = $4
        AND target_object_id = $5
      ON CONFLICT DO NOTHING
      RETURNING id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
                reviewed_at, review_reason, interaction_id, created_at, updated_at`,
      [
        input.id,
        input.scope_id,
        input.candidate_id,
        input.target_object_type,
        input.target_object_id,
        input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null,
        input.review_reason ?? null,
        input.interaction_id ?? null,
      ],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToCanonicalHandoffEntry(rows[0] as Record<string, unknown>);
  }

  async getCanonicalHandoffEntry(id: string): Promise<CanonicalHandoffEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
              reviewed_at, review_reason, interaction_id, created_at, updated_at
       FROM canonical_handoff_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) {
      return null;
    }
    return rowToCanonicalHandoffEntry(rows[0] as Record<string, unknown>);
  }

  async listCanonicalHandoffEntries(filters?: CanonicalHandoffFilters): Promise<CanonicalHandoffEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id !== undefined) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.candidate_id !== undefined) {
      params.push(filters.candidate_id);
      clauses.push(`candidate_id = $${params.length}`);
    }
    if (filters?.target_object_type !== undefined) {
      params.push(filters.target_object_type);
      clauses.push(`target_object_type = $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
              reviewed_at, review_reason, interaction_id, created_at, updated_at
       FROM canonical_handoff_entries
       ${whereClause}
       ORDER BY created_at DESC, id ASC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToCanonicalHandoffEntry);
  }

  async listCanonicalHandoffEntriesByInteractionIds(
    interactionIds: string[],
  ): Promise<CanonicalHandoffEntry[]> {
    if (interactionIds.length === 0) return [];
    const entries: CanonicalHandoffEntry[] = [];
    for (const chunk of chunkInteractionIds(interactionIds)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const { rows } = await this.db.query(
        `SELECT id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
                reviewed_at, review_reason, interaction_id, created_at, updated_at
         FROM canonical_handoff_entries
         WHERE interaction_id IN (${placeholders})
         ORDER BY created_at DESC, id ASC`,
        chunk,
      );
      entries.push(...(rows as Record<string, unknown>[]).map(rowToCanonicalHandoffEntry));
    }
    return sortByCreatedAtDescIdAsc(entries);
  }

  async deleteMemoryCandidateEntry(id: string): Promise<void> {
    await this.db.query(`DELETE FROM memory_candidate_entries WHERE id = $1`, [id]);
  }

  async upsertNoteManifestEntry(input: NoteManifestEntryInput): Promise<NoteManifestEntry> {
    const { rows } = await this.db.query(
      `INSERT INTO note_manifest_entries (
        scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
        outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
        extractor_version, last_indexed_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8::jsonb, $9::jsonb, $10::jsonb, $11::jsonb, $12::jsonb, $13::jsonb, $14, $15, now())
      ON CONFLICT (scope_id, page_id) DO UPDATE SET
        slug = EXCLUDED.slug,
        path = EXCLUDED.path,
        page_type = EXCLUDED.page_type,
        title = EXCLUDED.title,
        frontmatter = EXCLUDED.frontmatter,
        aliases = EXCLUDED.aliases,
        tags = EXCLUDED.tags,
        outgoing_wikilinks = EXCLUDED.outgoing_wikilinks,
        outgoing_urls = EXCLUDED.outgoing_urls,
        source_refs = EXCLUDED.source_refs,
        heading_index = EXCLUDED.heading_index,
        content_hash = EXCLUDED.content_hash,
        extractor_version = EXCLUDED.extractor_version,
        last_indexed_at = EXCLUDED.last_indexed_at
      RETURNING scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
                outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
                extractor_version, last_indexed_at`,
      [
        input.scope_id,
        input.page_id,
        validateSlug(input.slug),
        input.path,
        input.page_type,
        input.title,
        JSON.stringify(input.frontmatter ?? {}),
        JSON.stringify(input.aliases ?? []),
        JSON.stringify(input.tags ?? []),
        JSON.stringify(input.outgoing_wikilinks ?? []),
        JSON.stringify(input.outgoing_urls ?? []),
        JSON.stringify(input.source_refs ?? []),
        JSON.stringify(input.heading_index ?? []),
        input.content_hash,
        input.extractor_version,
      ],
    );
    return rowToNoteManifestEntry(rows[0] as Record<string, unknown>);
  }

  async getNoteManifestEntry(scopeId: string, slug: string): Promise<NoteManifestEntry | null> {
    const { rows } = await this.db.query(
      `SELECT scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
              outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
              extractor_version, last_indexed_at
       FROM note_manifest_entries
       WHERE scope_id = $1 AND slug = $2`,
      [scopeId, validateSlug(slug)],
    );
    if (rows.length === 0) return null;
    return rowToNoteManifestEntry(rows[0] as Record<string, unknown>);
  }

  async listNoteManifestEntries(filters?: NoteManifestFilters): Promise<NoteManifestEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.slug) {
      params.push(validateSlug(filters.slug));
      clauses.push(`slug = $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
              outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
              extractor_version, last_indexed_at
       FROM note_manifest_entries
       ${whereClause}
       ORDER BY last_indexed_at DESC, slug ASC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToNoteManifestEntry);
  }

  async deleteNoteManifestEntry(scopeId: string, slug: string): Promise<void> {
    await this.db.query(
      `DELETE FROM note_manifest_entries WHERE scope_id = $1 AND slug = $2`,
      [scopeId, validateSlug(slug)],
    );
  }

  async replaceNoteSectionEntries(
    scopeId: string,
    pageSlug: string,
    entries: NoteSectionEntryInput[],
  ): Promise<NoteSectionEntry[]> {
    const normalizedSlug = validateSlug(pageSlug);
    await this.db.query(
      `DELETE FROM note_section_entries WHERE scope_id = $1 AND page_slug = $2`,
      [scopeId, normalizedSlug],
    );

    const timestamp = new Date().toISOString();
    for (const entry of entries) {
      await this.db.query(
        `INSERT INTO note_section_entries (
          scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
          heading_path, heading_text, depth, line_start, line_end, section_text,
          outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb, $17, $18, $19)`,
        [
          scopeId,
          entry.page_id,
          validateSlug(entry.page_slug),
          entry.page_path,
          entry.section_id,
          entry.parent_section_id ?? null,
          entry.heading_slug,
          JSON.stringify(entry.heading_path ?? []),
          entry.heading_text,
          entry.depth,
          entry.line_start,
          entry.line_end,
          entry.section_text,
          JSON.stringify(entry.outgoing_wikilinks ?? []),
          JSON.stringify(entry.outgoing_urls ?? []),
          JSON.stringify(entry.source_refs ?? []),
          entry.content_hash,
          entry.extractor_version,
          timestamp,
        ],
      );
    }

    return this.listNoteSectionEntries({
      scope_id: scopeId,
      page_slug: normalizedSlug,
      limit: Math.max(entries.length, 1),
    });
  }

  async getNoteSectionEntry(scopeId: string, sectionId: string): Promise<NoteSectionEntry | null> {
    const { rows } = await this.db.query(
      `SELECT scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
              heading_path, heading_text, depth, line_start, line_end, section_text,
              outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
       FROM note_section_entries
       WHERE scope_id = $1 AND section_id = $2`,
      [scopeId, sectionId],
    );
    if (rows.length === 0) return null;
    return rowToNoteSectionEntry(rows[0] as Record<string, unknown>);
  }

  async listNoteSectionEntries(filters?: NoteSectionFilters): Promise<NoteSectionEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.page_slug) {
      params.push(validateSlug(filters.page_slug));
      clauses.push(`page_slug = $${params.length}`);
    }
    if (filters?.section_id) {
      params.push(filters.section_id);
      clauses.push(`section_id = $${params.length}`);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
              heading_path, heading_text, depth, line_start, line_end, section_text,
              outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
       FROM note_section_entries
       ${whereClause}
       ORDER BY page_slug ASC, line_start ASC, section_id ASC
       LIMIT $${params.length - 1}
       OFFSET $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToNoteSectionEntry);
  }

  async deleteNoteSectionEntries(scopeId: string, pageSlug: string): Promise<void> {
    await this.db.query(
      `DELETE FROM note_section_entries WHERE scope_id = $1 AND page_slug = $2`,
      [scopeId, validateSlug(pageSlug)],
    );
  }

  async upsertContextMapEntry(input: ContextMapEntryInput): Promise<ContextMapEntry> {
    const { rows } = await this.db.query(
      `INSERT INTO context_map_entries (
        id, scope_id, kind, title, build_mode, status, source_set_hash,
        extractor_version, node_count, edge_count, community_count, graph_json,
        generated_at, stale_reason
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12::jsonb, now(), $13)
      ON CONFLICT (id) DO UPDATE SET
        scope_id = EXCLUDED.scope_id,
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        build_mode = EXCLUDED.build_mode,
        status = EXCLUDED.status,
        source_set_hash = EXCLUDED.source_set_hash,
        extractor_version = EXCLUDED.extractor_version,
        node_count = EXCLUDED.node_count,
        edge_count = EXCLUDED.edge_count,
        community_count = EXCLUDED.community_count,
        graph_json = EXCLUDED.graph_json,
        generated_at = EXCLUDED.generated_at,
        stale_reason = EXCLUDED.stale_reason
      RETURNING id, scope_id, kind, title, build_mode, status, source_set_hash,
                extractor_version, node_count, edge_count, community_count, graph_json,
                generated_at, stale_reason`,
      [
        input.id,
        input.scope_id,
        input.kind,
        input.title,
        input.build_mode,
        input.status,
        input.source_set_hash,
        input.extractor_version,
        input.node_count,
        input.edge_count,
        input.community_count ?? 0,
        JSON.stringify(input.graph_json ?? {}),
        input.stale_reason ?? null,
      ],
    );
    return rowToContextMapEntry(rows[0] as Record<string, unknown>);
  }

  async getContextMapEntry(id: string): Promise<ContextMapEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, scope_id, kind, title, build_mode, status, source_set_hash,
              extractor_version, node_count, edge_count, community_count, graph_json,
              generated_at, stale_reason
       FROM context_map_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToContextMapEntry(rows[0] as Record<string, unknown>);
  }

  async listContextMapEntries(filters?: ContextMapFilters): Promise<ContextMapEntry[]> {
    const limit = filters?.limit ?? 100;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.kind) {
      params.push(filters.kind);
      clauses.push(`kind = $${params.length}`);
    }

    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, scope_id, kind, title, build_mode, status, source_set_hash,
              extractor_version, node_count, edge_count, community_count, graph_json,
              generated_at, stale_reason
       FROM context_map_entries
       ${whereClause}
       ORDER BY generated_at DESC, id ASC
       LIMIT $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToContextMapEntry);
  }

  async deleteContextMapEntry(id: string): Promise<void> {
    await this.db.query(`DELETE FROM context_map_entries WHERE id = $1`, [id]);
  }

  async upsertContextAtlasEntry(input: ContextAtlasEntryInput): Promise<ContextAtlasEntry> {
    const { rows } = await this.db.query(
      `INSERT INTO context_atlas_entries (
        id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, now())
      ON CONFLICT (id) DO UPDATE SET
        map_id = EXCLUDED.map_id,
        scope_id = EXCLUDED.scope_id,
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        freshness = EXCLUDED.freshness,
        entrypoints = EXCLUDED.entrypoints,
        budget_hint = EXCLUDED.budget_hint,
        generated_at = EXCLUDED.generated_at
      RETURNING id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at`,
      [
        input.id,
        input.map_id,
        input.scope_id,
        input.kind,
        input.title,
        input.freshness,
        JSON.stringify(input.entrypoints ?? []),
        input.budget_hint,
      ],
    );
    return rowToContextAtlasEntry(rows[0] as Record<string, unknown>);
  }

  async getContextAtlasEntry(id: string): Promise<ContextAtlasEntry | null> {
    const { rows } = await this.db.query(
      `SELECT id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
       FROM context_atlas_entries
       WHERE id = $1`,
      [id],
    );
    if (rows.length === 0) return null;
    return rowToContextAtlasEntry(rows[0] as Record<string, unknown>);
  }

  async listContextAtlasEntries(filters?: ContextAtlasFilters): Promise<ContextAtlasEntry[]> {
    const limit = filters?.limit ?? 100;
    const params: unknown[] = [];
    const clauses: string[] = [];

    if (filters?.scope_id) {
      params.push(filters.scope_id);
      clauses.push(`scope_id = $${params.length}`);
    }
    if (filters?.kind) {
      params.push(filters.kind);
      clauses.push(`kind = $${params.length}`);
    }

    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const { rows } = await this.db.query(
      `SELECT id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
       FROM context_atlas_entries
       ${whereClause}
       ORDER BY generated_at DESC, id ASC
       LIMIT $${params.length}`,
      params,
    );
    return (rows as Record<string, unknown>[]).map(rowToContextAtlasEntry);
  }

  async deleteContextAtlasEntry(id: string): Promise<void> {
    await this.db.query(`DELETE FROM context_atlas_entries WHERE id = $1`, [id]);
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
      await this.db.query(
        `UPDATE pages
         SET page_embedding = $1::vector(768)
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

function chunkInteractionIds(interactionIds: string[]): string[][] {
  const chunks: string[][] = [];
  for (let index = 0; index < interactionIds.length; index += INTERACTION_ID_LOOKUP_BATCH_SIZE) {
    chunks.push(interactionIds.slice(index, index + INTERACTION_ID_LOOKUP_BATCH_SIZE));
  }
  return chunks;
}

function sortByCreatedAtDescIdAsc<T extends { created_at: Date; id: string }>(entries: T[]): T[] {
  return entries.sort((a, b) => {
    const createdDelta = b.created_at.getTime() - a.created_at.getTime();
    return createdDelta !== 0 ? createdDelta : a.id.localeCompare(b.id);
  });
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

function isSupersessionDuplicateConstraint(error: unknown): boolean {
  if (typeof error !== 'object' || error == null) {
    return false;
  }
  const candidate = error as { code?: string; constraint?: string; message?: string };
  return candidate.code === '23505'
    && (candidate.constraint === 'memory_candidate_supersession_entries_superseded_candidate_id_key'
      || candidate.message?.includes('superseded_candidate_id') === true);
}
