import type { BrainEngine } from './engine.ts';
import { validateSlug, contentHash } from './utils.ts';
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
import * as db from './db.ts';

export class PostgresEngine implements BrainEngine {
  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    await db.connect(config);
  }

  async disconnect(): Promise<void> {
    await db.disconnect();
  }

  async initSchema(): Promise<void> {
    await db.initSchema();
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    return db.withTransaction(() => fn(this));
  }

  // Pages CRUD
  async getPage(slug: string): Promise<Page | null> {
    const sql = db.getConnection();
    const rows = await sql`
      SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
      FROM pages WHERE slug = ${slug}
    `;
    if (rows.length === 0) return null;
    return rowToPage(rows[0]);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    validateSlug(slug);
    const sql = db.getConnection();
    const hash = contentHash(page.compiled_truth, page.timeline || '');
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
    const sql = db.getConnection();
    await sql`DELETE FROM pages WHERE slug = ${slug}`;
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const sql = db.getConnection();
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    let rows;
    if (filters?.type && filters?.tag) {
      rows = await sql`
        SELECT p.* FROM pages p
        JOIN tags t ON t.page_id = p.id
        WHERE p.type = ${filters.type} AND t.tag = ${filters.tag}
        ORDER BY p.updated_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (filters?.type) {
      rows = await sql`
        SELECT * FROM pages WHERE type = ${filters.type}
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else if (filters?.tag) {
      rows = await sql`
        SELECT p.* FROM pages p
        JOIN tags t ON t.page_id = p.id
        WHERE t.tag = ${filters.tag}
        ORDER BY p.updated_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    } else {
      rows = await sql`
        SELECT * FROM pages
        ORDER BY updated_at DESC LIMIT ${limit} OFFSET ${offset}
      `;
    }

    return rows.map(rowToPage);
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    const sql = db.getConnection();

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
    const sql = db.getConnection();
    const limit = opts?.limit || 20;

    const rows = await sql`
      SELECT
        p.slug, p.id as page_id, p.title, p.type,
        cc.chunk_text, cc.chunk_source,
        ts_rank(p.search_vector, websearch_to_tsquery('english', ${query})) AS score,
        CASE WHEN p.updated_at < (
          SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
        ) THEN true ELSE false END AS stale
      FROM pages p
      JOIN content_chunks cc ON cc.page_id = p.id
      WHERE p.search_vector @@ websearch_to_tsquery('english', ${query})
      ORDER BY score DESC
      LIMIT ${limit}
    `;

    return rows.map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const sql = db.getConnection();
    const limit = opts?.limit || 20;
    const vecStr = '[' + Array.from(embedding).join(',') + ']';

    const rows = await sql`
      SELECT
        p.slug, p.id as page_id, p.title, p.type,
        cc.chunk_text, cc.chunk_source,
        1 - (cc.embedding <=> ${vecStr}::vector) AS score,
        CASE WHEN p.updated_at < (
          SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
        ) THEN true ELSE false END AS stale
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE cc.embedding IS NOT NULL
      ORDER BY cc.embedding <=> ${vecStr}::vector
      LIMIT ${limit}
    `;

    return rows.map(rowToSearchResult);
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const sql = db.getConnection();

    // Get page_id
    const pages = await sql`SELECT id FROM pages WHERE slug = ${slug}`;
    if (pages.length === 0) throw new Error(`Page not found: ${slug}`);
    const pageId = pages[0].id;

    // Delete existing chunks for this page
    await sql`DELETE FROM content_chunks WHERE page_id = ${pageId}`;

    // Insert new chunks
    if (chunks.length === 0) return;

    for (const chunk of chunks) {
      const embeddingStr = chunk.embedding
        ? '[' + Array.from(chunk.embedding).join(',') + ']'
        : null;

      await sql`
        INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)
        VALUES (
          ${pageId}, ${chunk.chunk_index}, ${chunk.chunk_text}, ${chunk.chunk_source},
          ${embeddingStr ? sql`${embeddingStr}::vector` : sql`NULL`},
          ${chunk.model || 'text-embedding-3-large'},
          ${chunk.token_count || null},
          ${chunk.embedding ? sql`now()` : sql`NULL`}
        )
      `;
    }
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const sql = db.getConnection();
    const rows = await sql`
      SELECT cc.* FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ${slug}
      ORDER BY cc.chunk_index
    `;
    return rows.map(rowToChunk);
  }

  async deleteChunks(slug: string): Promise<void> {
    const sql = db.getConnection();
    await sql`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
    `;
  }

  // Links
  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    const sql = db.getConnection();
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
    const sql = db.getConnection();
    await sql`
      DELETE FROM links
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = ${from})
        AND to_page_id = (SELECT id FROM pages WHERE slug = ${to})
    `;
  }

  async getLinks(slug: string): Promise<Link[]> {
    const sql = db.getConnection();
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
    const sql = db.getConnection();
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
    const sql = db.getConnection();
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
          (SELECT json_agg(json_build_object('to_slug', p3.slug, 'link_type', l2.link_type))
           FROM links l2
           JOIN pages p3 ON p3.id = l2.to_page_id
           WHERE l2.from_page_id = g.id),
          '[]'::json
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
    const sql = db.getConnection();
    await sql`
      INSERT INTO tags (page_id, tag)
      SELECT id, ${tag} FROM pages WHERE slug = ${slug}
      ON CONFLICT (page_id, tag) DO NOTHING
    `;
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    const sql = db.getConnection();
    await sql`
      DELETE FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
        AND tag = ${tag}
    `;
  }

  async getTags(slug: string): Promise<string[]> {
    const sql = db.getConnection();
    const rows = await sql`
      SELECT tag FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ${slug})
      ORDER BY tag
    `;
    return rows.map((r: { tag: string }) => r.tag);
  }

  // Timeline
  async addTimelineEntry(slug: string, entry: TimelineInput): Promise<void> {
    const sql = db.getConnection();
    await sql`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, ${entry.date}::date, ${entry.source || ''}, ${entry.summary}, ${entry.detail || ''}
      FROM pages WHERE slug = ${slug}
    `;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const sql = db.getConnection();
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
    const sql = db.getConnection();
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
    const sql = db.getConnection();
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
    const sql = db.getConnection();
    const rows = await sql`
      INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
      SELECT id, compiled_truth, frontmatter
      FROM pages WHERE slug = ${slug}
      RETURNING *
    `;
    return rows[0] as unknown as PageVersion;
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    const sql = db.getConnection();
    const rows = await sql`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ${slug}
      ORDER BY pv.snapshot_at DESC
    `;
    return rows as unknown as PageVersion[];
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    const sql = db.getConnection();
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
    const sql = db.getConnection();
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
    const sql = db.getConnection();
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
    const sql = db.getConnection();
    await sql`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
      VALUES (${entry.source_type}, ${entry.source_ref}, ${JSON.stringify(entry.pages_updated)}::jsonb, ${entry.summary})
    `;
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const sql = db.getConnection();
    const limit = opts?.limit || 50;
    const rows = await sql`
      SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ${limit}
    `;
    return rows as unknown as IngestLogEntry[];
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    validateSlug(newSlug);
    const sql = db.getConnection();
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
    const sql = db.getConnection();
    const rows = await sql`SELECT value FROM config WHERE key = ${key}`;
    return rows.length > 0 ? (rows[0].value as string) : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    const sql = db.getConnection();
    await sql`
      INSERT INTO config (key, value) VALUES (${key}, ${value})
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value
    `;
  }
}

// Helpers
function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: row.id as number,
    slug: row.slug as string,
    type: row.type as PageType,
    title: row.title as string,
    compiled_truth: row.compiled_truth as string,
    timeline: row.timeline as string,
    frontmatter: (typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter) as Record<string, unknown>,
    content_hash: row.content_hash as string | undefined,
    created_at: new Date(row.created_at as string),
    updated_at: new Date(row.updated_at as string),
  };
}

function rowToChunk(row: Record<string, unknown>): Chunk {
  return {
    id: row.id as number,
    page_id: row.page_id as number,
    chunk_index: row.chunk_index as number,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    embedding: null, // Don't load embeddings into memory by default
    model: row.model as string,
    token_count: row.token_count as number | null,
    embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
  };
}

function rowToSearchResult(row: Record<string, unknown>): SearchResult {
  return {
    slug: row.slug as string,
    page_id: row.page_id as number,
    title: row.title as string,
    type: row.type as PageType,
    chunk_text: row.chunk_text as string,
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
}
