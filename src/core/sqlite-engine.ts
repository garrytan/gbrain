import { Database } from 'bun:sqlite';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { validateSlug, contentHash } from './utils.ts';
import type { BrainEngine } from './engine.ts';
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

export class SQLiteEngine implements BrainEngine {
  private db: Database | null = null;
  private hasVec0 = false;
  private vec0Warned = false;

  // ── Lifecycle ────────────────────────────────────────────

  async connect(config: EngineConfig): Promise<void> {
    const dbPath = config.database_path;
    if (!dbPath) {
      throw new Error('database_path is required for SQLite engine');
    }
    this.db = new Database(dbPath, { create: true });
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');

    // Try loading vec0 extension
    try {
      this.db.loadExtension('vec0');
      this.hasVec0 = true;
    } catch {
      this.hasVec0 = false;
    }
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async initSchema(): Promise<void> {
    const conn = this.getDb();
    const schemaPath = join(dirname(new URL(import.meta.url).pathname), '..', 'sqlite-schema.sql');
    const schemaSql = readFileSync(schemaPath, 'utf-8');

    // bun:sqlite exec handles multi-statement SQL including triggers correctly
    conn.exec(schemaSql);

    // Create vec0 virtual table if extension loaded
    if (this.hasVec0) {
      try {
        conn.exec(`
          CREATE VIRTUAL TABLE IF NOT EXISTS chunks_vec USING vec0(
            chunk_id INTEGER PRIMARY KEY,
            embedding float[1536]
          )
        `);
      } catch {
        this.hasVec0 = false;
      }
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const conn = this.getDb();
    // NOTE: bun:sqlite is synchronous. All SQLiteEngine methods execute
    // synchronously even though they return Promises. The `await fn(this)`
    // resolves via microtasks before any other macrotask can execute, so
    // the BEGIN...COMMIT block is safe in single-threaded Bun environments.
    conn.exec('BEGIN');
    try {
      const result = await fn(this);
      conn.exec('COMMIT');
      return result;
    } catch (e) {
      conn.exec('ROLLBACK');
      throw e;
    }
  }

  // ── Pages CRUD ───────────────────────────────────────────

  async getPage(slug: string): Promise<Page | null> {
    const conn = this.getDb();
    const row = conn.query(`
      SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
      FROM pages WHERE slug = ?
    `).get(slug) as Record<string, unknown> | null;
    if (!row) return null;
    return this.rowToPage(row);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    validateSlug(slug);
    const conn = this.getDb();
    const hash = contentHash(page.compiled_truth, page.timeline || '');
    const frontmatter = JSON.stringify(page.frontmatter || {});
    const now = new Date().toISOString();

    conn.query(`
      INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        compiled_truth = excluded.compiled_truth,
        timeline = excluded.timeline,
        frontmatter = excluded.frontmatter,
        content_hash = excluded.content_hash,
        updated_at = ?
    `).run(slug, page.type, page.title, page.compiled_truth, page.timeline || '', frontmatter, hash, now, now, now);

    return (await this.getPage(slug))!;
  }

  async deletePage(slug: string): Promise<void> {
    const conn = this.getDb();
    conn.query('DELETE FROM pages WHERE slug = ?').run(slug);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const conn = this.getDb();
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    let sql: string;
    let params: unknown[];

    if (filters?.type && filters?.tag) {
      sql = `
        SELECT p.* FROM pages p
        JOIN tags t ON t.page_id = p.id
        WHERE p.type = ? AND t.tag = ?
        ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
      `;
      params = [filters.type, filters.tag, limit, offset];
    } else if (filters?.type) {
      sql = `SELECT * FROM pages WHERE type = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params = [filters.type, limit, offset];
    } else if (filters?.tag) {
      sql = `
        SELECT p.* FROM pages p
        JOIN tags t ON t.page_id = p.id
        WHERE t.tag = ?
        ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
      `;
      params = [filters.tag, limit, offset];
    } else {
      sql = `SELECT * FROM pages ORDER BY updated_at DESC LIMIT ? OFFSET ?`;
      params = [limit, offset];
    }

    const rows = conn.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => this.rowToPage(r));
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    const conn = this.getDb();

    // Exact match first
    const exact = conn.query('SELECT slug FROM pages WHERE slug = ?').get(partial) as { slug: string } | null;
    if (exact) return [exact.slug];

    // LIKE fuzzy match
    const fuzzy = conn.query(`
      SELECT slug FROM pages
      WHERE slug LIKE ? OR title LIKE ?
      ORDER BY
        CASE WHEN slug LIKE ? THEN 1
             WHEN title LIKE ? THEN 2
             ELSE 3
        END
      LIMIT 5
    `).all(`%${partial}%`, `%${partial}%`, `%${partial}%`, `%${partial}%`) as { slug: string }[];

    return fuzzy.map(r => r.slug);
  }

  // ── Search ───────────────────────────────────────────────

  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const conn = this.getDb();
    const limit = opts?.limit || 20;
    const ftsQuery = toFts5Query(query);
    if (!ftsQuery) return [];

    try {
      // Get matching pages ranked by FTS5, then join to first chunk for result display
      const rows = conn.query(`
        SELECT
          p.slug, p.id as page_id, p.title, p.type,
          cc.chunk_text, cc.chunk_source,
          (-pages_fts.rank) AS score,
          0 AS stale
        FROM pages_fts
        JOIN pages p ON p.id = pages_fts.rowid
        LEFT JOIN content_chunks cc ON cc.page_id = p.id
          AND cc.id = (SELECT id FROM content_chunks WHERE page_id = p.id ORDER BY chunk_index LIMIT 1)
        WHERE pages_fts MATCH ?
        ORDER BY pages_fts.rank
        LIMIT ?
      `).all(ftsQuery, limit) as Record<string, unknown>[];

      // Filter out rows with no chunk (page exists in FTS but has no chunks)
      return rows
        .filter(r => r.chunk_text != null)
        .map(r => this.rowToSearchResult(r));
    } catch {
      return [];
    }
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    if (!this.hasVec0) {
      if (!this.vec0Warned) {
        console.warn('vec0 extension not loaded — vector search unavailable. Using keyword search only.');
        this.vec0Warned = true;
      }
      return [];
    }

    const conn = this.getDb();
    const limit = opts?.limit || 20;
    const vecStr = '[' + Array.from(embedding).join(',') + ']';

    try {
      const rows = conn.query(`
        SELECT
          p.slug, p.id as page_id, p.title, p.type,
          cc.chunk_text, cc.chunk_source,
          (1.0 - v.distance) AS score,
          0 AS stale
        FROM chunks_vec v
        JOIN content_chunks cc ON cc.id = v.chunk_id
        JOIN pages p ON p.id = cc.page_id
        WHERE v.embedding MATCH ?
        ORDER BY v.distance
        LIMIT ?
      `).all(vecStr, limit) as Record<string, unknown>[];

      return rows.map(r => this.rowToSearchResult(r));
    } catch {
      return [];
    }
  }

  // ── Chunks ───────────────────────────────────────────────

  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const conn = this.getDb();
    const pageRow = conn.query('SELECT id FROM pages WHERE slug = ?').get(slug) as { id: number } | null;
    if (!pageRow) throw new Error(`Page not found: ${slug}`);
    const pageId = pageRow.id;

    // Clean up vec0 first
    if (this.hasVec0) {
      const existingIds = conn.query('SELECT id FROM content_chunks WHERE page_id = ?').all(pageId) as { id: number }[];
      for (const { id } of existingIds) {
        try { conn.query('DELETE FROM chunks_vec WHERE chunk_id = ?').run(id); } catch {}
      }
    }

    conn.query('DELETE FROM content_chunks WHERE page_id = ?').run(pageId);
    if (chunks.length === 0) return;

    const now = new Date().toISOString();
    const insertChunk = conn.query(`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, model, token_count, embedded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      const runResult = insertChunk.run(
        pageId, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
        chunk.model || 'text-embedding-3-large', chunk.token_count || null,
        chunk.embedding ? now : null,
      );

      if (this.hasVec0 && chunk.embedding) {
        const chunkId = runResult.lastInsertRowid;
        const vecStr = '[' + Array.from(chunk.embedding).join(',') + ']';
        try { conn.query('INSERT INTO chunks_vec (chunk_id, embedding) VALUES (?, ?)').run(chunkId, vecStr); } catch {}
      }
    }
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const conn = this.getDb();
    const rows = conn.query(`
      SELECT cc.* FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ?
      ORDER BY cc.chunk_index
    `).all(slug) as Record<string, unknown>[];
    return rows.map(r => this.rowToChunk(r));
  }

  async deleteChunks(slug: string): Promise<void> {
    const conn = this.getDb();
    if (this.hasVec0) {
      const ids = conn.query(`
        SELECT cc.id FROM content_chunks cc
        JOIN pages p ON p.id = cc.page_id
        WHERE p.slug = ?
      `).all(slug) as { id: number }[];
      for (const { id } of ids) {
        try { conn.query('DELETE FROM chunks_vec WHERE chunk_id = ?').run(id); } catch {}
      }
    }
    conn.query(`
      DELETE FROM content_chunks
      WHERE page_id = (SELECT id FROM pages WHERE slug = ?)
    `).run(slug);
  }

  // ── Links ────────────────────────────────────────────────

  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO links (from_page_id, to_page_id, link_type, context)
      SELECT f.id, t.id, ?, ?
      FROM pages f, pages t
      WHERE f.slug = ? AND t.slug = ?
      ON CONFLICT (from_page_id, to_page_id) DO UPDATE SET
        link_type = excluded.link_type,
        context = excluded.context
    `).run(linkType || '', context || '', from, to);
  }

  async removeLink(from: string, to: string): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      DELETE FROM links
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = ?)
        AND to_page_id = (SELECT id FROM pages WHERE slug = ?)
    `).run(from, to);
  }

  async getLinks(slug: string): Promise<Link[]> {
    const conn = this.getDb();
    return conn.query(`
      SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = ?
    `).all(slug) as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const conn = this.getDb();
    return conn.query(`
      SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = ?
    `).all(slug) as Link[];
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const conn = this.getDb();
    const rows = conn.query(`
      WITH RECURSIVE graph AS (
        SELECT p.id, p.slug, p.title, p.type, 0 as depth
        FROM pages p WHERE p.slug = ?

        UNION

        SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1
        FROM graph g
        JOIN links l ON l.from_page_id = g.id
        JOIN pages p2 ON p2.id = l.to_page_id
        WHERE g.depth < ?
      )
      SELECT DISTINCT g.slug, g.title, g.type, g.depth,
        (
          SELECT json_group_array(json_object('to_slug', p3.slug, 'link_type', l2.link_type))
          FROM links l2
          JOIN pages p3 ON p3.id = l2.to_page_id
          WHERE l2.from_page_id = g.id
        ) as links
      FROM graph g
      ORDER BY g.depth, g.slug
    `).all(slug, depth) as Record<string, unknown>[];

    return rows.map(r => ({
      slug: r.slug as string,
      title: r.title as string,
      type: r.type as PageType,
      depth: r.depth as number,
      links: r.links ? JSON.parse(r.links as string) : [],
    }));
  }

  // ── Tags ─────────────────────────────────────────────────

  async addTag(slug: string, tag: string): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO tags (page_id, tag)
      SELECT id, ? FROM pages WHERE slug = ?
      ON CONFLICT (page_id, tag) DO NOTHING
    `).run(tag, slug);
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      DELETE FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ?) AND tag = ?
    `).run(slug, tag);
  }

  async getTags(slug: string): Promise<string[]> {
    const conn = this.getDb();
    const rows = conn.query(`
      SELECT tag FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ?)
      ORDER BY tag
    `).all(slug) as { tag: string }[];
    return rows.map(r => r.tag);
  }

  // ── Timeline ─────────────────────────────────────────────

  async addTimelineEntry(slug: string, entry: TimelineInput): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, ?, ?, ?, ?
      FROM pages WHERE slug = ?
    `).run(entry.date, entry.source || '', entry.summary, entry.detail || '', slug);
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const conn = this.getDb();
    const limit = opts?.limit || 100;
    let sql: string;
    let params: unknown[];

    if (opts?.after && opts?.before) {
      sql = `
        SELECT te.* FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ? AND te.date >= ? AND te.date <= ?
        ORDER BY te.date DESC LIMIT ?
      `;
      params = [slug, opts.after, opts.before, limit];
    } else if (opts?.after) {
      sql = `
        SELECT te.* FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ? AND te.date >= ?
        ORDER BY te.date DESC LIMIT ?
      `;
      params = [slug, opts.after, limit];
    } else {
      sql = `
        SELECT te.* FROM timeline_entries te
        JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ?
        ORDER BY te.date DESC LIMIT ?
      `;
      params = [slug, limit];
    }

    const rows = conn.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      page_id: r.page_id as number,
      date: r.date as string,
      source: r.source as string,
      summary: r.summary as string,
      detail: r.detail as string,
      created_at: new Date(r.created_at as string),
    }));
  }

  // ── Raw data ─────────────────────────────────────────────

  async putRawData(slug: string, source: string, data: object): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO raw_data (page_id, source, data)
      SELECT id, ?, ?
      FROM pages WHERE slug = ?
      ON CONFLICT (page_id, source) DO UPDATE SET
        data = excluded.data,
        fetched_at = datetime('now')
    `).run(source, JSON.stringify(data), slug);
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    const conn = this.getDb();
    let rows: Record<string, unknown>[];
    if (source) {
      rows = conn.query(`
        SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ? AND rd.source = ?
      `).all(slug, source) as Record<string, unknown>[];
    } else {
      rows = conn.query(`
        SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id
        WHERE p.slug = ?
      `).all(slug) as Record<string, unknown>[];
    }
    return rows.map(r => ({
      source: r.source as string,
      data: JSON.parse(r.data as string),
      fetched_at: new Date(r.fetched_at as string),
    }));
  }

  // ── Versions ─────────────────────────────────────────────

  async createVersion(slug: string): Promise<PageVersion> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
      SELECT id, compiled_truth, frontmatter FROM pages WHERE slug = ?
    `).run(slug);

    const row = conn.query(`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ?
      ORDER BY pv.id DESC LIMIT 1
    `).get(slug) as Record<string, unknown>;

    return {
      id: row.id as number,
      page_id: row.page_id as number,
      compiled_truth: row.compiled_truth as string,
      frontmatter: JSON.parse(row.frontmatter as string),
      snapshot_at: new Date(row.snapshot_at as string),
    };
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    const conn = this.getDb();
    const rows = conn.query(`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ?
      ORDER BY pv.snapshot_at DESC
    `).all(slug) as Record<string, unknown>[];

    return rows.map(r => ({
      id: r.id as number,
      page_id: r.page_id as number,
      compiled_truth: r.compiled_truth as string,
      frontmatter: JSON.parse(r.frontmatter as string),
      snapshot_at: new Date(r.snapshot_at as string),
    }));
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    const conn = this.getDb();
    const version = conn.query('SELECT * FROM page_versions WHERE id = ?').get(versionId) as Record<string, unknown> | null;
    if (!version) throw new Error(`Version not found: ${versionId}`);
    const now = new Date().toISOString();
    conn.query(`
      UPDATE pages SET compiled_truth = ?, frontmatter = ?, updated_at = ?
      WHERE slug = ? AND id = ?
    `).run(version.compiled_truth, version.frontmatter, now, slug, version.page_id);
  }

  // ── Stats + health ───────────────────────────────────────

  async getStats(): Promise<BrainStats> {
    const conn = this.getDb();
    const stats = conn.query(`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks) as chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT tag) FROM tags) as tag_count,
        (SELECT count(*) FROM timeline_entries) as timeline_entry_count
    `).get() as Record<string, number>;

    const types = conn.query(`
      SELECT type, count(*) as count FROM pages GROUP BY type ORDER BY count DESC
    `).all() as { type: string; count: number }[];

    const pages_by_type: Record<string, number> = {};
    for (const t of types) pages_by_type[t.type] = t.count;

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
    const conn = this.getDb();
    const h = conn.query(`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        CAST((SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) AS REAL) /
          MAX((SELECT count(*) FROM content_chunks), 1) as embed_coverage,
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
    `).get() as Record<string, number>;

    return {
      page_count: Number(h.page_count),
      embed_coverage: Number(h.embed_coverage),
      stale_pages: Number(h.stale_pages),
      orphan_pages: Number(h.orphan_pages),
      dead_links: Number(h.dead_links),
      missing_embeddings: Number(h.missing_embeddings),
    };
  }

  // ── Ingest log ───────────────────────────────────────────

  async logIngest(entry: IngestLogInput): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
      VALUES (?, ?, ?, ?)
    `).run(entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary);
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const conn = this.getDb();
    const limit = opts?.limit || 50;
    const rows = conn.query('SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ?').all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      id: r.id as number,
      source_type: r.source_type as string,
      source_ref: r.source_ref as string,
      pages_updated: JSON.parse(r.pages_updated as string),
      summary: r.summary as string,
      created_at: new Date(r.created_at as string),
    }));
  }

  // ── Sync ─────────────────────────────────────────────────

  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    validateSlug(newSlug);
    const conn = this.getDb();
    const now = new Date().toISOString();
    conn.query('UPDATE pages SET slug = ?, updated_at = ? WHERE slug = ?').run(newSlug, now, oldSlug);
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Stub — links use integer FKs, already correct after updateSlug.
  }

  // ── Config ───────────────────────────────────────────────

  async getConfig(key: string): Promise<string | null> {
    const conn = this.getDb();
    const row = conn.query('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | null;
    return row ? row.value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    const conn = this.getDb();
    conn.query(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }

  // ── Private helpers ──────────────────────────────────────

  private getDb(): Database {
    if (!this.db) {
      throw new Error('SQLite database not connected. Call connect() first.');
    }
    return this.db;
  }

  private rowToPage(row: Record<string, unknown>): Page {
    return {
      id: row.id as number,
      slug: row.slug as string,
      type: row.type as PageType,
      title: row.title as string,
      compiled_truth: row.compiled_truth as string,
      timeline: row.timeline as string,
      frontmatter: typeof row.frontmatter === 'string' ? JSON.parse(row.frontmatter) : row.frontmatter as Record<string, unknown>,
      content_hash: row.content_hash as string | undefined,
      created_at: new Date(row.created_at as string),
      updated_at: new Date(row.updated_at as string),
    };
  }

  private rowToChunk(row: Record<string, unknown>): Chunk {
    return {
      id: row.id as number,
      page_id: row.page_id as number,
      chunk_index: row.chunk_index as number,
      chunk_text: row.chunk_text as string,
      chunk_source: row.chunk_source as 'compiled_truth' | 'timeline',
      embedding: null,
      model: row.model as string,
      token_count: row.token_count as number | null,
      embedded_at: row.embedded_at ? new Date(row.embedded_at as string) : null,
    };
  }

  private rowToSearchResult(row: Record<string, unknown>): SearchResult {
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
}

// ── FTS5 query helper ────────────────────────────────────

export function toFts5Query(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return '';

  // If user already wrote FTS5 syntax, pass through.
  // Note: malformed FTS5 will throw in SQLite, caught by searchKeyword which returns [].
  if (trimmed.includes('"') || trimmed.includes(' OR ') || trimmed.includes(' NOT ')) {
    return trimmed;
  }

  const tokens = trimmed.split(/\s+/);
  const positiveParts: string[] = [];
  const negativeParts: string[] = [];

  for (const token of tokens) {
    if (token.startsWith('-') && token.length > 1) {
      negativeParts.push(token.slice(1));
    } else {
      positiveParts.push(token);
    }
  }

  // FTS5 NOT requires a positive term before it
  if (positiveParts.length === 0) {
    // All negative tokens with no positive context — just return the first positive token
    // to avoid a bare NOT error; treat as keyword search on the negated terms
    return negativeParts.join(' ');
  }

  const result = positiveParts.join(' ');
  if (negativeParts.length === 0) return result;
  return result + ' NOT ' + negativeParts.join(' NOT ');
}
