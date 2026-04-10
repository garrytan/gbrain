import { Database } from 'bun:sqlite';
import { createHash } from 'crypto';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
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
import { GBrainError } from './types.ts';

const SCHEMA_SQL = `
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

CREATE TABLE IF NOT EXISTS pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  type          TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   TEXT    NOT NULL DEFAULT '{}',
  content_hash  TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title, compiled_truth, timeline,
  content='pages', content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline)
  VALUES (new.id, new.title, new.compiled_truth, new.timeline);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline)
  VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline);
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline)
  VALUES (new.id, new.title, new.compiled_truth, new.timeline);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline)
  VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline);
END;

CREATE TABLE IF NOT EXISTS content_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding     BLOB,
  model         TEXT    NOT NULL DEFAULT 'text-embedding-3-large',
  token_count   INTEGER,
  embedded_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);

CREATE TABLE IF NOT EXISTS links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type    TEXT    NOT NULL DEFAULT '',
  context      TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_page_id, to_page_id)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to   ON links(to_page_id);

CREATE TABLE IF NOT EXISTS tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag     ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

CREATE TABLE IF NOT EXISTS raw_data (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       TEXT    NOT NULL,
  fetched_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(page_id, source)
);
CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

CREATE TABLE IF NOT EXISTS timeline_entries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date     TEXT    NOT NULL,
  source   TEXT    NOT NULL DEFAULT '',
  summary  TEXT    NOT NULL,
  detail   TEXT    NOT NULL DEFAULT '',
  created_at TEXT  NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);

CREATE TABLE IF NOT EXISTS page_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT    NOT NULL,
  frontmatter    TEXT    NOT NULL DEFAULT '{}',
  snapshot_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

CREATE TABLE IF NOT EXISTS ingest_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated TEXT    NOT NULL DEFAULT '[]',
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT OR IGNORE INTO config (key, value) VALUES
  ('version', '1'),
  ('engine', 'sqlite'),
  ('embedding_model', 'text-embedding-3-large'),
  ('embedding_dimensions', '1536'),
  ('chunk_strategy', 'semantic');
`;

export class SQLiteEngine implements BrainEngine {
  private db: Database | null = null;

  private get conn(): Database {
    if (!this.db) throw new GBrainError('Not connected', 'Database not open', 'Call connect() first');
    return this.db;
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    const dbPath = config.database_path || `${process.env.HOME}/.gbrain/brain.db`;
    const dir = dirname(dbPath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    this.db = new Database(dbPath);
    this.db.exec('PRAGMA journal_mode=WAL');
    this.db.exec('PRAGMA foreign_keys=ON');
  }

  async disconnect(): Promise<void> {
    this.db?.close();
    this.db = null;
  }

  async initSchema(): Promise<void> {
    this.conn.exec(SCHEMA_SQL);
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const db = this.conn;
    db.exec('BEGIN');
    try {
      const result = await fn(this);
      db.exec('COMMIT');
      return result;
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }

  // Pages CRUD
  async getPage(slug: string): Promise<Page | null> {
    const row = this.conn.query(
      'SELECT * FROM pages WHERE slug = ?'
    ).get(slug) as Record<string, unknown> | null;
    return row ? rowToPage(row) : null;
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    validateSlug(slug);
    const hash = page.content_hash || contentHash(page.compiled_truth, page.timeline || '');
    const fm = JSON.stringify(page.frontmatter || {});
    const now = new Date().toISOString();

    this.conn.query(`
      INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (slug) DO UPDATE SET
        type = excluded.type, title = excluded.title,
        compiled_truth = excluded.compiled_truth, timeline = excluded.timeline,
        frontmatter = excluded.frontmatter, content_hash = excluded.content_hash,
        updated_at = ?
    `).run(slug, page.type, page.title, page.compiled_truth, page.timeline || '', fm, hash, now, now);

    return (await this.getPage(slug))!;
  }

  async deletePage(slug: string): Promise<void> {
    this.conn.query('DELETE FROM pages WHERE slug = ?').run(slug);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;
    let rows: Record<string, unknown>[];

    if (filters?.type && filters?.tag) {
      rows = this.conn.query(`
        SELECT p.* FROM pages p JOIN tags t ON t.page_id = p.id
        WHERE p.type = ? AND t.tag = ?
        ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
      `).all(filters.type, filters.tag, limit, offset) as Record<string, unknown>[];
    } else if (filters?.type) {
      rows = this.conn.query(
        'SELECT * FROM pages WHERE type = ? ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      ).all(filters.type, limit, offset) as Record<string, unknown>[];
    } else if (filters?.tag) {
      rows = this.conn.query(`
        SELECT p.* FROM pages p JOIN tags t ON t.page_id = p.id
        WHERE t.tag = ? ORDER BY p.updated_at DESC LIMIT ? OFFSET ?
      `).all(filters.tag, limit, offset) as Record<string, unknown>[];
    } else {
      rows = this.conn.query(
        'SELECT * FROM pages ORDER BY updated_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset) as Record<string, unknown>[];
    }
    return rows.map(rowToPage);
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    // Exact match first
    const exact = this.conn.query('SELECT slug FROM pages WHERE slug = ?').get(partial) as { slug: string } | null;
    if (exact) return [exact.slug];

    // LIKE fallback (no pg_trgm in SQLite)
    const fuzzy = this.conn.query(
      "SELECT slug FROM pages WHERE slug LIKE ? OR title LIKE ? LIMIT 5"
    ).all(`%${partial}%`, `%${partial}%`) as { slug: string }[];
    return fuzzy.map(r => r.slug);
  }

  // Search
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit || 20;
    // FTS5 query: simple word matching
    const ftsQuery = query.replace(/[^\w\s\u4e00-\u9fff]/g, '').trim();
    if (!ftsQuery) return [];

    const rows = this.conn.query(`
      SELECT
        p.slug, p.id as page_id, p.title, p.type,
        cc.chunk_text, cc.chunk_source,
        bm25(pages_fts) AS score,
        CASE WHEN p.updated_at < (
          SELECT MAX(te.created_at) FROM timeline_entries te WHERE te.page_id = p.id
        ) THEN 1 ELSE 0 END AS stale
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      LEFT JOIN content_chunks cc ON cc.page_id = p.id
      WHERE pages_fts MATCH ?
      ORDER BY score
      LIMIT ?
    `).all(ftsQuery, limit) as Record<string, unknown>[];

    return rows.map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    // Vector search requires sqlite-vss or vec0 extension.
    // Without it, return empty (graceful degradation to keyword-only).
    // TODO: implement when vec0 extension is loaded
    return [];
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const page = this.conn.query('SELECT id FROM pages WHERE slug = ?').get(slug) as { id: number } | null;
    if (!page) throw new Error(`Page not found: ${slug}`);

    this.conn.query('DELETE FROM content_chunks WHERE page_id = ?').run(page.id);
    if (chunks.length === 0) return;

    const stmt = this.conn.query(`
      INSERT INTO content_chunks (page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const chunk of chunks) {
      const embBlob = chunk.embedding ? Buffer.from(chunk.embedding.buffer) : null;
      stmt.run(
        page.id, chunk.chunk_index, chunk.chunk_text, chunk.chunk_source,
        embBlob, chunk.model || 'text-embedding-3-large', chunk.token_count || null,
        chunk.embedding ? new Date().toISOString() : null
      );
    }
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const rows = this.conn.query(`
      SELECT cc.* FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ? ORDER BY cc.chunk_index
    `).all(slug) as Record<string, unknown>[];
    return rows.map(rowToChunk);
  }

  async deleteChunks(slug: string): Promise<void> {
    this.conn.query(
      'DELETE FROM content_chunks WHERE page_id = (SELECT id FROM pages WHERE slug = ?)'
    ).run(slug);
  }

  // Links
  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    this.conn.query(`
      INSERT INTO links (from_page_id, to_page_id, link_type, context)
      SELECT f.id, t.id, ?, ?
      FROM pages f, pages t
      WHERE f.slug = ? AND t.slug = ?
      ON CONFLICT (from_page_id, to_page_id) DO UPDATE SET
        link_type = excluded.link_type, context = excluded.context
    `).run(linkType || '', context || '', from, to);
  }

  async removeLink(from: string, to: string): Promise<void> {
    this.conn.query(`
      DELETE FROM links
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = ?)
        AND to_page_id = (SELECT id FROM pages WHERE slug = ?)
    `).run(from, to);
  }

  async getLinks(slug: string): Promise<Link[]> {
    return this.conn.query(`
      SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = ?
    `).all(slug) as Link[];
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    return this.conn.query(`
      SELECT f.slug as from_slug, t.slug as to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = ?
    `).all(slug) as Link[];
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const rows = this.conn.query(`
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
      SELECT DISTINCT g.slug, g.title, g.type, g.depth
      FROM graph g
      ORDER BY g.depth, g.slug
    `).all(slug, depth) as Record<string, unknown>[];

    return rows.map(r => {
      const links = this.conn.query(`
        SELECT p.slug as to_slug, l.link_type
        FROM links l JOIN pages p ON p.id = l.to_page_id
        WHERE l.from_page_id = (SELECT id FROM pages WHERE slug = ?)
      `).all(r.slug as string) as { to_slug: string; link_type: string }[];

      return {
        slug: r.slug as string,
        title: r.title as string,
        type: r.type as PageType,
        depth: r.depth as number,
        links,
      };
    });
  }

  // Tags
  async addTag(slug: string, tag: string): Promise<void> {
    this.conn.query(`
      INSERT INTO tags (page_id, tag)
      SELECT id, ? FROM pages WHERE slug = ?
      ON CONFLICT (page_id, tag) DO NOTHING
    `).run(tag, slug);
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    this.conn.query(`
      DELETE FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ?) AND tag = ?
    `).run(slug, tag);
  }

  async getTags(slug: string): Promise<string[]> {
    const rows = this.conn.query(`
      SELECT tag FROM tags
      WHERE page_id = (SELECT id FROM pages WHERE slug = ?) ORDER BY tag
    `).all(slug) as { tag: string }[];
    return rows.map(r => r.tag);
  }

  // Timeline
  async addTimelineEntry(slug: string, entry: TimelineInput): Promise<void> {
    this.conn.query(`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail)
      SELECT id, ?, ?, ?, ? FROM pages WHERE slug = ?
    `).run(entry.date, entry.source || '', entry.summary, entry.detail || '', slug);
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const limit = opts?.limit || 100;
    let rows: Record<string, unknown>[];

    if (opts?.after && opts?.before) {
      rows = this.conn.query(`
        SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ? AND te.date >= ? AND te.date <= ?
        ORDER BY te.date DESC LIMIT ?
      `).all(slug, opts.after, opts.before, limit) as Record<string, unknown>[];
    } else if (opts?.after) {
      rows = this.conn.query(`
        SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ? AND te.date >= ?
        ORDER BY te.date DESC LIMIT ?
      `).all(slug, opts.after, limit) as Record<string, unknown>[];
    } else {
      rows = this.conn.query(`
        SELECT te.* FROM timeline_entries te JOIN pages p ON p.id = te.page_id
        WHERE p.slug = ? ORDER BY te.date DESC LIMIT ?
      `).all(slug, limit) as Record<string, unknown>[];
    }
    return rows as unknown as TimelineEntry[];
  }

  // Raw data
  async putRawData(slug: string, source: string, data: object): Promise<void> {
    this.conn.query(`
      INSERT INTO raw_data (page_id, source, data)
      SELECT id, ?, ? FROM pages WHERE slug = ?
      ON CONFLICT (page_id, source) DO UPDATE SET
        data = excluded.data, fetched_at = datetime('now')
    `).run(source, JSON.stringify(data), slug);
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    if (source) {
      return this.conn.query(`
        SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
        JOIN pages p ON p.id = rd.page_id WHERE p.slug = ? AND rd.source = ?
      `).all(slug, source).map(r => ({ ...r as any, data: JSON.parse((r as any).data) }));
    }
    return this.conn.query(`
      SELECT rd.source, rd.data, rd.fetched_at FROM raw_data rd
      JOIN pages p ON p.id = rd.page_id WHERE p.slug = ?
    `).all(slug).map(r => ({ ...r as any, data: JSON.parse((r as any).data) }));
  }

  // Versions
  async createVersion(slug: string): Promise<PageVersion> {
    this.conn.query(`
      INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
      SELECT id, compiled_truth, frontmatter FROM pages WHERE slug = ?
    `).run(slug);

    const row = this.conn.query(`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ? ORDER BY pv.id DESC LIMIT 1
    `).get(slug) as Record<string, unknown>;
    return row as unknown as PageVersion;
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    return this.conn.query(`
      SELECT pv.* FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ? ORDER BY pv.snapshot_at DESC
    `).all(slug) as unknown as PageVersion[];
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    this.conn.query(`
      UPDATE pages SET
        compiled_truth = (SELECT compiled_truth FROM page_versions WHERE id = ?),
        frontmatter = (SELECT frontmatter FROM page_versions WHERE id = ?),
        updated_at = datetime('now')
      WHERE slug = ?
    `).run(versionId, versionId, slug);
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const s = this.conn.query(`
      SELECT
        (SELECT count(*) FROM pages) as page_count,
        (SELECT count(*) FROM content_chunks) as chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) as embedded_count,
        (SELECT count(*) FROM links) as link_count,
        (SELECT count(DISTINCT tag) FROM tags) as tag_count,
        (SELECT count(*) FROM timeline_entries) as timeline_entry_count
    `).get() as Record<string, number>;

    const types = this.conn.query(
      'SELECT type, count(*) as count FROM pages GROUP BY type ORDER BY count DESC'
    ).all() as { type: string; count: number }[];

    const pages_by_type: Record<string, number> = {};
    for (const t of types) pages_by_type[t.type] = t.count;

    return { ...s, pages_by_type } as unknown as BrainStats;
  }

  async getHealth(): Promise<BrainHealth> {
    const h = this.conn.query(`
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

    return h as unknown as BrainHealth;
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    this.conn.query(`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
      VALUES (?, ?, ?, ?)
    `).run(entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary);
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 50;
    const rows = this.conn.query(
      'SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ?'
    ).all(limit) as Record<string, unknown>[];
    return rows.map(r => ({
      ...r,
      pages_updated: JSON.parse(r.pages_updated as string),
    })) as unknown as IngestLogEntry[];
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    validateSlug(newSlug);
    this.conn.query("UPDATE pages SET slug = ?, updated_at = datetime('now') WHERE slug = ?").run(newSlug, oldSlug);
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Links use integer FKs — already correct after updateSlug.
    // Textual [[wiki-links]] in compiled_truth are NOT rewritten here.
  }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const row = this.conn.query('SELECT value FROM config WHERE key = ?').get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.conn.query(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value
    `).run(key, value);
  }
}

// Helpers
function validateSlug(slug: string): void {
  if (!slug || /\.\./.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
}

function contentHash(compiledTruth: string, timeline: string): string {
  return createHash('sha256').update(compiledTruth + '\n---\n' + timeline).digest('hex');
}

function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: row.id as number,
    slug: row.slug as string,
    type: row.type as PageType,
    title: row.title as string,
    compiled_truth: row.compiled_truth as string,
    timeline: row.timeline as string,
    frontmatter: JSON.parse(row.frontmatter as string || '{}'),
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
    embedding: null,
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
    chunk_text: row.chunk_text as string || '',
    chunk_source: row.chunk_source as 'compiled_truth' | 'timeline' || 'compiled_truth',
    score: Number(row.score),
    stale: Boolean(row.stale),
  };
}
