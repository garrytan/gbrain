import postgres from 'postgres';
import type { BrainEngine } from './engine.ts';
import {
  assertMemoryCandidateCreateStatus,
  isAllowedMemoryCandidateStatusUpdate,
} from './memory-inbox-status.ts';
import { runMigrations } from './migrate.ts';
import { SCHEMA_SQL } from './schema-embedded.ts';
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
import { MBrainError } from './types.ts';
import { clearConnectionOwner } from './db.ts';
import { buildFrontmatterSearchText } from './markdown.ts';
import { ensurePageChunks } from './page-chunks.ts';
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
  rowToRetrievalTrace,
  rowToSearchResult,
  rowToTaskAttempt,
  rowToTaskDecision,
  rowToTaskThread,
  rowToTaskWorkingSet,
} from './utils.ts';

const INTERACTION_ID_LOOKUP_BATCH_SIZE = 500;

type PostgresParam = string | number | boolean | null | Date | Uint8Array | string[];

function jsonParam(value: unknown): postgres.JSONValue {
  return value as postgres.JSONValue;
}

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
    return conn.begin<Promise<T>>(async (tx) => {
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
      VALUES (${slug}, ${page.type}, ${page.title}, ${page.compiled_truth}, ${page.timeline || ''}, ${searchText}, ${sql.json(jsonParam(frontmatter))}, ${hash}, now())
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
    return fuzzy.map((row) => String(row.slug));
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
    const params: PostgresParam[] = [query];
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
    const params: PostgresParam[] = [vecStr];
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
    const params: PostgresParam[] = [];
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
    return rows.map(row => rowToChunk(row, false));
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
    return rows.map((row) => String(row.tag));
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
      SELECT id, ${source}, ${sql.json(jsonParam(data))}
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
          frontmatter = ${sql.json(jsonParam(frontmatter))},
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
      VALUES (${entry.source_type}, ${entry.source_ref}, ${sql.json(jsonParam(entry.pages_updated))}, ${entry.summary})
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

  async createTaskThread(input: TaskThreadInput): Promise<TaskThread> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO task_threads (
        id, scope, title, goal, status, repo_path, branch_name, current_summary
      ) VALUES (
        ${input.id},
        ${input.scope},
        ${input.title},
        ${input.goal ?? ''},
        ${input.status},
        ${input.repo_path ?? null},
        ${input.branch_name ?? null},
        ${input.current_summary ?? ''}
      )
      RETURNING id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
    `;
    return rowToTaskThread(rows[0] as Record<string, unknown>);
  }

  async updateTaskThread(id: string, patch: TaskThreadPatch): Promise<TaskThread> {
    const sql = this.sql;
    const current = await this.getTaskThread(id);
    if (!current) throw new Error(`Task thread not found: ${id}`);

    const rows = await sql`
      UPDATE task_threads
      SET scope = ${patch.scope ?? current.scope},
          title = ${patch.title ?? current.title},
          goal = ${patch.goal ?? current.goal},
          status = ${patch.status ?? current.status},
          repo_path = ${patch.repo_path === undefined ? current.repo_path : patch.repo_path},
          branch_name = ${patch.branch_name === undefined ? current.branch_name : patch.branch_name},
          current_summary = ${patch.current_summary ?? current.current_summary},
          updated_at = now()
      WHERE id = ${id}
      RETURNING id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
    `;
    return rowToTaskThread(rows[0] as Record<string, unknown>);
  }

  async listTaskThreads(filters?: TaskThreadFilters): Promise<TaskThread[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 50;
    const offset = filters?.offset ?? 0;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
      FROM task_threads
      WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToTaskThread(rows[0] as Record<string, unknown>);
  }

  async getTaskWorkingSet(taskId: string): Promise<TaskWorkingSet | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
      FROM task_working_sets
      WHERE task_id = ${taskId}
    `;
    if (rows.length === 0) return null;
    return rowToTaskWorkingSet(rows[0] as Record<string, unknown>);
  }

  async upsertTaskWorkingSet(input: TaskWorkingSetInput): Promise<TaskWorkingSet> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO task_working_sets (
        task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
      ) VALUES (
        ${input.task_id},
        ${sql.json(jsonParam(input.active_paths ?? []))},
        ${sql.json(jsonParam(input.active_symbols ?? []))},
        ${sql.json(jsonParam(input.blockers ?? []))},
        ${sql.json(jsonParam(input.open_questions ?? []))},
        ${sql.json(jsonParam(input.next_steps ?? []))},
        ${sql.json(jsonParam(input.verification_notes ?? []))},
        ${input.last_verified_at instanceof Date ? input.last_verified_at.toISOString() : input.last_verified_at ?? null},
        now()
      )
      ON CONFLICT (task_id) DO UPDATE SET
        active_paths = EXCLUDED.active_paths,
        active_symbols = EXCLUDED.active_symbols,
        blockers = EXCLUDED.blockers,
        open_questions = EXCLUDED.open_questions,
        next_steps = EXCLUDED.next_steps,
        verification_notes = EXCLUDED.verification_notes,
        last_verified_at = EXCLUDED.last_verified_at,
        updated_at = now()
      RETURNING task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
    `;
    return rowToTaskWorkingSet(rows[0] as Record<string, unknown>);
  }

  async recordTaskAttempt(input: TaskAttemptInput): Promise<TaskAttempt> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO task_attempts (
        id, task_id, summary, outcome, applicability_context, evidence
      ) VALUES (
        ${input.id},
        ${input.task_id},
        ${input.summary},
        ${input.outcome},
        ${sql.json(jsonParam(input.applicability_context ?? {}))},
        ${sql.json(jsonParam(input.evidence ?? []))}
      )
      RETURNING id, task_id, summary, outcome, applicability_context, evidence, created_at
    `;
    return rowToTaskAttempt(rows[0] as Record<string, unknown>);
  }

  async listTaskAttempts(taskId: string, opts?: { limit?: number }): Promise<TaskAttempt[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, task_id, summary, outcome, applicability_context, evidence, created_at
      FROM task_attempts
      WHERE task_id = ${taskId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${opts?.limit ?? 20}
    `;
    return (rows as Record<string, unknown>[]).map(rowToTaskAttempt);
  }

  async recordTaskDecision(input: TaskDecisionInput): Promise<TaskDecision> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO task_decisions (
        id, task_id, summary, rationale, consequences, validity_context
      ) VALUES (
        ${input.id},
        ${input.task_id},
        ${input.summary},
        ${input.rationale},
        ${sql.json(jsonParam(input.consequences ?? []))},
        ${sql.json(jsonParam(input.validity_context ?? {}))}
      )
      RETURNING id, task_id, summary, rationale, consequences, validity_context, created_at
    `;
    return rowToTaskDecision(rows[0] as Record<string, unknown>);
  }

  async listTaskDecisions(taskId: string, opts?: { limit?: number }): Promise<TaskDecision[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, task_id, summary, rationale, consequences, validity_context, created_at
      FROM task_decisions
      WHERE task_id = ${taskId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${opts?.limit ?? 20}
    `;
    return (rows as Record<string, unknown>[]).map(rowToTaskDecision);
  }

  async putRetrievalTrace(input: RetrievalTraceInput): Promise<RetrievalTrace> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO retrieval_traces (
        id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome
      ) VALUES (
        ${input.id},
        ${input.task_id ?? null},
        ${input.scope},
        ${sql.json(jsonParam(input.route ?? []))},
        ${sql.json(jsonParam(input.source_refs ?? []))},
        ${sql.json(jsonParam(input.derived_consulted ?? []))},
        ${sql.json(jsonParam(input.verification ?? []))},
        ${input.write_outcome ?? 'no_durable_write'},
        ${input.selected_intent ?? null},
        ${input.scope_gate_policy ?? null},
        ${input.scope_gate_reason ?? null},
        ${input.outcome}
      )
      RETURNING id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
    `;
    return rowToRetrievalTrace(rows[0] as Record<string, unknown>);
  }

  async getRetrievalTrace(id: string): Promise<RetrievalTrace | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
      FROM retrieval_traces
      WHERE id = ${id}
    `;
    const [row] = rows as Record<string, unknown>[];
    return row ? rowToRetrievalTrace(row) : null;
  }

  async listRetrievalTraces(taskId: string, opts?: { limit?: number }): Promise<RetrievalTrace[]> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, task_id, scope, route, source_refs, derived_consulted, verification,
        write_outcome, selected_intent, scope_gate_policy, scope_gate_reason, outcome, created_at
      FROM retrieval_traces
      WHERE task_id = ${taskId}
      ORDER BY created_at DESC, id DESC
      LIMIT ${opts?.limit ?? 20}
    `;
    return (rows as Record<string, unknown>[]).map(rowToRetrievalTrace);
  }

  async listRetrievalTracesByWindow(filters: RetrievalTraceWindowFilters): Promise<RetrievalTrace[]> {
    const sql = this.sql;
    const params: PostgresParam[] = [filters.since.toISOString(), filters.until.toISOString()];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO profile_memory_entries (
        id, scope_id, profile_type, subject, content, source_refs, sensitivity,
        export_status, last_confirmed_at, superseded_by
      ) VALUES (
        ${input.id},
        ${input.scope_id},
        ${input.profile_type},
        ${input.subject},
        ${input.content},
        ${sql.json(jsonParam(input.source_refs ?? []))},
        ${input.sensitivity},
        ${input.export_status},
        ${input.last_confirmed_at instanceof Date ? input.last_confirmed_at.toISOString() : input.last_confirmed_at ?? null},
        ${input.superseded_by ?? null}
      )
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
                export_status, last_confirmed_at, superseded_by, created_at, updated_at
    `;
    return rowToProfileMemoryEntry(rows[0] as Record<string, unknown>);
  }

  async getProfileMemoryEntry(id: string): Promise<ProfileMemoryEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, profile_type, subject, content, source_refs, sensitivity,
             export_status, last_confirmed_at, superseded_by, created_at, updated_at
      FROM profile_memory_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToProfileMemoryEntry(rows[0] as Record<string, unknown>);
  }

  async listProfileMemoryEntries(filters?: ProfileMemoryFilters): Promise<ProfileMemoryEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM profile_memory_entries
      WHERE id = ${id}
    `;
  }

  async createPersonalEpisodeEntry(input: PersonalEpisodeEntryInput): Promise<PersonalEpisodeEntry> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO personal_episode_entries (
        id, scope_id, title, start_time, end_time, source_kind, summary, source_refs, candidate_ids
      ) VALUES (
        ${input.id},
        ${input.scope_id},
        ${input.title},
        ${input.start_time instanceof Date ? input.start_time.toISOString() : input.start_time},
        ${input.end_time instanceof Date ? input.end_time.toISOString() : input.end_time ?? null},
        ${input.source_kind},
        ${input.summary},
        ${sql.json(jsonParam(input.source_refs ?? []))},
        ${sql.json(jsonParam(input.candidate_ids ?? []))}
      )
      RETURNING id, scope_id, title, start_time, end_time, source_kind, summary,
                source_refs, candidate_ids, created_at, updated_at
    `;
    return rowToPersonalEpisodeEntry(rows[0] as Record<string, unknown>);
  }

  async getPersonalEpisodeEntry(id: string): Promise<PersonalEpisodeEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, title, start_time, end_time, source_kind, summary,
             source_refs, candidate_ids, created_at, updated_at
      FROM personal_episode_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToPersonalEpisodeEntry(rows[0] as Record<string, unknown>);
  }

  async listPersonalEpisodeEntries(filters?: PersonalEpisodeFilters): Promise<PersonalEpisodeEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM personal_episode_entries
      WHERE id = ${id}
    `;
  }

  async createMemoryCandidateEntry(input: MemoryCandidateEntryInput): Promise<MemoryCandidateEntry> {
    const sql = this.sql;
    const initialStatus = assertMemoryCandidateCreateStatus(input.status);
    const rows = await sql`
      INSERT INTO memory_candidate_entries (
        id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
        extraction_kind, confidence_score, importance_score, recurrence_score,
        sensitivity, status, target_object_type, target_object_id, reviewed_at,
        review_reason
      ) VALUES (
        ${input.id},
        ${input.scope_id},
        ${input.candidate_type},
        ${input.proposed_content},
        ${sql.json(jsonParam(input.source_refs ?? []))},
        ${input.generated_by},
        ${input.extraction_kind},
        ${input.confidence_score},
        ${input.importance_score},
        ${input.recurrence_score},
        ${input.sensitivity},
        ${initialStatus},
        ${input.target_object_type ?? null},
        ${input.target_object_id ?? null},
        ${input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null},
        ${input.review_reason ?? null}
      )
      RETURNING id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
                extraction_kind, confidence_score, importance_score, recurrence_score,
                sensitivity, status, target_object_type, target_object_id, reviewed_at,
                review_reason, created_at, updated_at
    `;
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async getMemoryCandidateEntry(id: string): Promise<MemoryCandidateEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
             extraction_kind, confidence_score, importance_score, recurrence_score,
             sensitivity, status, target_object_type, target_object_id, reviewed_at,
             review_reason, created_at, updated_at
      FROM memory_candidate_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async listMemoryCandidateEntries(filters?: MemoryCandidateFilters): Promise<MemoryCandidateEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: Array<string | number> = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    const current = await this.getMemoryCandidateEntry(id);
    if (!current) {
      throw new Error(`Memory candidate entry not found before status update: ${id}`);
    }
    if (!isAllowedMemoryCandidateStatusUpdate(current.status, patch.status)) {
      throw new Error(`Cannot update memory candidate from ${current.status} to ${patch.status}.`);
    }
    const rows = await sql`
      UPDATE memory_candidate_entries
      SET status = ${patch.status},
          reviewed_at = ${patch.reviewed_at instanceof Date ? patch.reviewed_at.toISOString() : patch.reviewed_at ?? null},
          review_reason = ${patch.review_reason ?? null},
          updated_at = now()
      WHERE id = ${id}
        AND status = ${current.status}
      RETURNING id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
                extraction_kind, confidence_score, importance_score, recurrence_score,
                sensitivity, status, target_object_type, target_object_id, reviewed_at,
                review_reason, created_at, updated_at
    `;
    if (rows.length === 0) return null;
    return rowToMemoryCandidateEntry(rows[0] as Record<string, unknown>);
  }

  async promoteMemoryCandidateEntry(id: string, patch: MemoryCandidatePromotionPatch = {}): Promise<MemoryCandidateEntry | null> {
    const sql = this.sql;
    // I4: reject promotion unless the candidate has at least one non-blank
    // provenance entry. Defense-in-depth behind the service-layer preflight
    // check.
    const rows = await sql`
      UPDATE memory_candidate_entries
      SET status = 'promoted',
          reviewed_at = ${patch.reviewed_at instanceof Date ? patch.reviewed_at.toISOString() : patch.reviewed_at ?? null},
          review_reason = ${patch.review_reason ?? null},
          updated_at = now()
      WHERE id = ${id}
        AND status = ${patch.expected_current_status ?? 'staged_for_review'}
        AND EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(memory_candidate_entries.source_refs) AS source_ref(value)
          WHERE btrim(source_ref.value) <> ''
        )
      RETURNING id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
                extraction_kind, confidence_score, importance_score, recurrence_score,
                sensitivity, status, target_object_type, target_object_id, reviewed_at,
                review_reason, created_at, updated_at
    `;
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
        const tx = txBase as PostgresEngine;
        const sql = tx.sql;
        const supersededRows = await sql`
          SELECT id, scope_id, status
          FROM memory_candidate_entries
          WHERE id = ${input.superseded_candidate_id}
          FOR UPDATE
        `;
        const replacementRows = await sql`
          SELECT id, scope_id, status
          FROM memory_candidate_entries
          WHERE id = ${input.replacement_candidate_id}
          FOR UPDATE
        `;
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

        const rows = await sql`
          INSERT INTO memory_candidate_supersession_entries (
            id, scope_id, superseded_candidate_id, replacement_candidate_id, reviewed_at, review_reason,
            interaction_id
          )
          VALUES (
            ${input.id},
            ${input.scope_id},
            ${input.superseded_candidate_id},
            ${input.replacement_candidate_id},
            ${input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null},
            ${input.review_reason ?? null},
            ${input.interaction_id ?? null}
          )
          RETURNING id, scope_id, superseded_candidate_id, replacement_candidate_id,
                    reviewed_at, review_reason, interaction_id, created_at, updated_at
        `;
        if (rows.length === 0) {
          throw new Error(rollbackSentinel);
        }

        const updatedRows = await sql`
          UPDATE memory_candidate_entries
          SET status = 'superseded',
              reviewed_at = ${input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null},
              review_reason = ${input.review_reason ?? null},
              updated_at = now()
          WHERE id = ${input.superseded_candidate_id}
            AND scope_id = ${input.scope_id}
            AND status = ${input.expected_current_status}
          RETURNING id
        `;
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
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, superseded_candidate_id, replacement_candidate_id,
             reviewed_at, review_reason, interaction_id, created_at, updated_at
      FROM memory_candidate_supersession_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateSupersessionEntry(rows[0] as Record<string, unknown>);
  }

  async listMemoryCandidateSupersessionEntriesByInteractionIds(
    interactionIds: string[],
  ): Promise<MemoryCandidateSupersessionEntry[]> {
    if (interactionIds.length === 0) return [];
    const sql = this.sql;
    const entries: MemoryCandidateSupersessionEntry[] = [];
    for (const chunk of chunkInteractionIds(interactionIds)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const rows = await sql.unsafe(
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
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO memory_candidate_contradiction_entries (
        id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
        reviewed_at, review_reason, interaction_id
      )
      SELECT
        ${input.id},
        ${input.scope_id},
        ${input.candidate_id},
        ${input.challenged_candidate_id},
        ${input.outcome},
        ${input.supersession_entry_id ?? null},
        ${input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null},
        ${input.review_reason ?? null},
        ${input.interaction_id ?? null}
      WHERE EXISTS (
        SELECT 1
        FROM memory_candidate_entries candidate
        JOIN memory_candidate_entries challenged
          ON challenged.id = ${input.challenged_candidate_id}
        WHERE candidate.id = ${input.candidate_id}
          AND candidate.scope_id = ${input.scope_id}
          AND challenged.scope_id = ${input.scope_id}
      )
        AND (
          ${input.supersession_entry_id ?? null}::text IS NULL
          OR EXISTS (
            SELECT 1
            FROM memory_candidate_supersession_entries
            WHERE id = ${input.supersession_entry_id ?? null}
              AND scope_id = ${input.scope_id}
              AND replacement_candidate_id = ${input.candidate_id}
              AND superseded_candidate_id = ${input.challenged_candidate_id}
          )
        )
      RETURNING id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
                reviewed_at, review_reason, interaction_id, created_at, updated_at
    `;
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateContradictionEntry(rows[0] as Record<string, unknown>);
  }

  async getMemoryCandidateContradictionEntry(id: string): Promise<MemoryCandidateContradictionEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, candidate_id, challenged_candidate_id, outcome, supersession_entry_id,
             reviewed_at, review_reason, interaction_id, created_at, updated_at
      FROM memory_candidate_contradiction_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) {
      return null;
    }
    return rowToMemoryCandidateContradictionEntry(rows[0] as Record<string, unknown>);
  }

  async listMemoryCandidateContradictionEntriesByInteractionIds(
    interactionIds: string[],
  ): Promise<MemoryCandidateContradictionEntry[]> {
    if (interactionIds.length === 0) return [];
    const sql = this.sql;
    const entries: MemoryCandidateContradictionEntry[] = [];
    for (const chunk of chunkInteractionIds(interactionIds)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const rows = await sql.unsafe(
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
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO canonical_handoff_entries (
        id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
        reviewed_at, review_reason, interaction_id
      )
      SELECT
        ${input.id},
        ${input.scope_id},
        ${input.candidate_id},
        ${input.target_object_type},
        ${input.target_object_id},
        source_refs,
        ${input.reviewed_at instanceof Date ? input.reviewed_at.toISOString() : input.reviewed_at ?? null},
        ${input.review_reason ?? null},
        ${input.interaction_id ?? null}
      FROM memory_candidate_entries
      WHERE id = ${input.candidate_id}
        AND scope_id = ${input.scope_id}
        AND status = 'promoted'
        AND target_object_type = ${input.target_object_type}
        AND target_object_id = ${input.target_object_id}
      ON CONFLICT DO NOTHING
      RETURNING id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
                reviewed_at, review_reason, interaction_id, created_at, updated_at
    `;
    if (rows.length === 0) {
      return null;
    }
    return rowToCanonicalHandoffEntry(rows[0] as Record<string, unknown>);
  }

  async getCanonicalHandoffEntry(id: string): Promise<CanonicalHandoffEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, candidate_id, target_object_type, target_object_id, source_refs,
             reviewed_at, review_reason, interaction_id, created_at, updated_at
      FROM canonical_handoff_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) {
      return null;
    }
    return rowToCanonicalHandoffEntry(rows[0] as Record<string, unknown>);
  }

  async listCanonicalHandoffEntries(filters?: CanonicalHandoffFilters): Promise<CanonicalHandoffEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    const entries: CanonicalHandoffEntry[] = [];
    for (const chunk of chunkInteractionIds(interactionIds)) {
      const placeholders = chunk.map((_, index) => `$${index + 1}`).join(', ');
      const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM memory_candidate_entries
      WHERE id = ${id}
    `;
  }

  async upsertNoteManifestEntry(input: NoteManifestEntryInput): Promise<NoteManifestEntry> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO note_manifest_entries (
        scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
        outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
        extractor_version, last_indexed_at
      ) VALUES (
        ${input.scope_id},
        ${input.page_id},
        ${validateSlug(input.slug)},
        ${input.path},
        ${input.page_type},
        ${input.title},
        ${sql.json(jsonParam(input.frontmatter ?? {}))},
        ${sql.json(jsonParam(input.aliases ?? []))},
        ${sql.json(jsonParam(input.tags ?? []))},
        ${sql.json(jsonParam(input.outgoing_wikilinks ?? []))},
        ${sql.json(jsonParam(input.outgoing_urls ?? []))},
        ${sql.json(jsonParam(input.source_refs ?? []))},
        ${sql.json(jsonParam(input.heading_index ?? []))},
        ${input.content_hash},
        ${input.extractor_version},
        now()
      )
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
                extractor_version, last_indexed_at
    `;
    return rowToNoteManifestEntry(rows[0] as Record<string, unknown>);
  }

  async getNoteManifestEntry(scopeId: string, slug: string): Promise<NoteManifestEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
             outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
             extractor_version, last_indexed_at
      FROM note_manifest_entries
      WHERE scope_id = ${scopeId} AND slug = ${validateSlug(slug)}
    `;
    if (rows.length === 0) return null;
    return rowToNoteManifestEntry(rows[0] as Record<string, unknown>);
  }

  async listNoteManifestEntries(filters?: NoteManifestFilters): Promise<NoteManifestEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM note_manifest_entries
      WHERE scope_id = ${scopeId} AND slug = ${validateSlug(slug)}
    `;
  }

  async replaceNoteSectionEntries(
    scopeId: string,
    pageSlug: string,
    entries: NoteSectionEntryInput[],
  ): Promise<NoteSectionEntry[]> {
    const sql = this.sql;
    const normalizedSlug = validateSlug(pageSlug);

    await sql`
      DELETE FROM note_section_entries
      WHERE scope_id = ${scopeId} AND page_slug = ${normalizedSlug}
    `;

    const timestamp = new Date().toISOString();
    for (const entry of entries) {
      await sql`
        INSERT INTO note_section_entries (
          scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
          heading_path, heading_text, depth, line_start, line_end, section_text,
          outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
        ) VALUES (
          ${scopeId},
          ${entry.page_id},
          ${validateSlug(entry.page_slug)},
          ${entry.page_path},
          ${entry.section_id},
          ${entry.parent_section_id ?? null},
          ${entry.heading_slug},
          ${sql.json(jsonParam(entry.heading_path ?? []))},
          ${entry.heading_text},
          ${entry.depth},
          ${entry.line_start},
          ${entry.line_end},
          ${entry.section_text},
          ${sql.json(jsonParam(entry.outgoing_wikilinks ?? []))},
          ${sql.json(jsonParam(entry.outgoing_urls ?? []))},
          ${sql.json(jsonParam(entry.source_refs ?? []))},
          ${entry.content_hash},
          ${entry.extractor_version},
          ${timestamp}
        )
      `;
    }

    return this.listNoteSectionEntries({
      scope_id: scopeId,
      page_slug: normalizedSlug,
      limit: Math.max(entries.length, 1),
    });
  }

  async getNoteSectionEntry(scopeId: string, sectionId: string): Promise<NoteSectionEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
             heading_path, heading_text, depth, line_start, line_end, section_text,
             outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
      FROM note_section_entries
      WHERE scope_id = ${scopeId} AND section_id = ${sectionId}
    `;
    if (rows.length === 0) return null;
    return rowToNoteSectionEntry(rows[0] as Record<string, unknown>);
  }

  async listNoteSectionEntries(filters?: NoteSectionFilters): Promise<NoteSectionEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM note_section_entries
      WHERE scope_id = ${scopeId} AND page_slug = ${validateSlug(pageSlug)}
    `;
  }

  async upsertContextMapEntry(input: ContextMapEntryInput): Promise<ContextMapEntry> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO context_map_entries (
        id, scope_id, kind, title, build_mode, status, source_set_hash,
        extractor_version, node_count, edge_count, community_count, graph_json,
        generated_at, stale_reason
      ) VALUES (
        ${input.id},
        ${input.scope_id},
        ${input.kind},
        ${input.title},
        ${input.build_mode},
        ${input.status},
        ${input.source_set_hash},
        ${input.extractor_version},
        ${input.node_count},
        ${input.edge_count},
        ${input.community_count ?? 0},
        ${sql.json(jsonParam(input.graph_json ?? {}))},
        now(),
        ${input.stale_reason ?? null}
      )
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
                generated_at, stale_reason
    `;
    return rowToContextMapEntry(rows[0] as Record<string, unknown>);
  }

  async getContextMapEntry(id: string): Promise<ContextMapEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, scope_id, kind, title, build_mode, status, source_set_hash,
             extractor_version, node_count, edge_count, community_count, graph_json,
             generated_at, stale_reason
      FROM context_map_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToContextMapEntry(rows[0] as Record<string, unknown>);
  }

  async listContextMapEntries(filters?: ContextMapFilters): Promise<ContextMapEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM context_map_entries
      WHERE id = ${id}
    `;
  }

  async upsertContextAtlasEntry(input: ContextAtlasEntryInput): Promise<ContextAtlasEntry> {
    const sql = this.sql;
    const rows = await sql`
      INSERT INTO context_atlas_entries (
        id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      ) VALUES (
        ${input.id},
        ${input.map_id},
        ${input.scope_id},
        ${input.kind},
        ${input.title},
        ${input.freshness},
        ${sql.json(jsonParam(input.entrypoints ?? []))},
        ${input.budget_hint},
        now()
      )
      ON CONFLICT (id) DO UPDATE SET
        map_id = EXCLUDED.map_id,
        scope_id = EXCLUDED.scope_id,
        kind = EXCLUDED.kind,
        title = EXCLUDED.title,
        freshness = EXCLUDED.freshness,
        entrypoints = EXCLUDED.entrypoints,
        budget_hint = EXCLUDED.budget_hint,
        generated_at = EXCLUDED.generated_at
      RETURNING id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
    `;
    return rowToContextAtlasEntry(rows[0] as Record<string, unknown>);
  }

  async getContextAtlasEntry(id: string): Promise<ContextAtlasEntry | null> {
    const sql = this.sql;
    const rows = await sql`
      SELECT id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      FROM context_atlas_entries
      WHERE id = ${id}
    `;
    if (rows.length === 0) return null;
    return rowToContextAtlasEntry(rows[0] as Record<string, unknown>);
  }

  async listContextAtlasEntries(filters?: ContextAtlasFilters): Promise<ContextAtlasEntry[]> {
    const sql = this.sql;
    const limit = filters?.limit ?? 100;
    const params: PostgresParam[] = [];
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
    const rows = await sql.unsafe(
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
    const sql = this.sql;
    await sql`
      DELETE FROM context_atlas_entries
      WHERE id = ${id}
    `;
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
