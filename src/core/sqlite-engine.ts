import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { BrainEngine } from './engine.ts';
import { LATEST_VERSION } from './migrate.ts';
import { ensurePageChunks } from './page-chunks.ts';
import { searchLocalVectors } from './search/vector-local.ts';
import { slugifyPath } from './sync.ts';
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
import { buildFrontmatterSearchText, expandTechnicalAliases } from './markdown.ts';
import { contentHash, importContentHash } from './utils.ts';

const DEFAULT_EMBEDDING_MODEL = 'nomic-embed-text';
const BASELINE_VERSION = 1;

const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  compiled_truth TEXT NOT NULL DEFAULT '',
  timeline TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT '',
  frontmatter TEXT NOT NULL DEFAULT '{}',
  content_hash TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_pages_type ON pages(type);

CREATE VIRTUAL TABLE IF NOT EXISTS pages_fts USING fts5(
  title,
  compiled_truth,
  timeline,
  search_text,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

CREATE TRIGGER IF NOT EXISTS pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline, search_text)
  VALUES (new.id, new.title, new.compiled_truth, new.timeline, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline, search_text)
  VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline, old.search_text);
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline, search_text)
  VALUES (new.id, new.title, new.compiled_truth, new.timeline, new.search_text);
END;

CREATE TRIGGER IF NOT EXISTS pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline, search_text)
  VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline, old.search_text);
END;

CREATE TABLE IF NOT EXISTS content_chunks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index INTEGER NOT NULL,
  chunk_text TEXT NOT NULL,
  chunk_source TEXT NOT NULL DEFAULT 'compiled_truth',
  embedding BLOB,
  model TEXT NOT NULL DEFAULT 'nomic-embed-text',
  token_count INTEGER,
  embedded_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(page_id, chunk_index)
);
CREATE INDEX IF NOT EXISTS idx_chunks_page ON content_chunks(page_id);

CREATE TABLE IF NOT EXISTS links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type TEXT NOT NULL DEFAULT '',
  context TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(from_page_id, to_page_id)
);
CREATE INDEX IF NOT EXISTS idx_links_from ON links(from_page_id);
CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_page_id);

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  UNIQUE(page_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_tags_page_id ON tags(page_id);

CREATE TABLE IF NOT EXISTS raw_data (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source TEXT NOT NULL,
  data TEXT NOT NULL,
  fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE(page_id, source)
);
CREATE INDEX IF NOT EXISTS idx_raw_data_page ON raw_data(page_id);

CREATE TABLE IF NOT EXISTS timeline_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX IF NOT EXISTS idx_timeline_date ON timeline_entries(date);

CREATE TABLE IF NOT EXISTS page_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT NOT NULL,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  snapshot_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_versions_page ON page_versions(page_id);

CREATE TABLE IF NOT EXISTS ingest_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type TEXT NOT NULL,
  source_ref TEXT NOT NULL,
  pages_updated TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS access_tokens (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  scopes TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_access_tokens_hash
  ON access_tokens (token_hash)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS mcp_request_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token_name TEXT,
  operation TEXT NOT NULL,
  latency_ms INTEGER,
  status TEXT NOT NULL DEFAULT 'success',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS config (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export class SQLiteEngine implements BrainEngine {
  private db: Database | null = null;
  private transactionDepth = 0;

  private get database(): Database {
    if (!this.db) throw new Error('SQLite engine is not connected');
    return this.db;
  }

  async connect(config: EngineConfig): Promise<void> {
    const databasePath = config.database_path;
    if (!databasePath) {
      throw new GBrainError(
        'No database path',
        'database_path is missing',
        'Set database_path in ~/.gbrain/config.json before using engine="sqlite"',
      );
    }

    const resolvedPath = resolveDatabasePath(databasePath);
    if (resolvedPath !== ':memory:') {
      mkdirSync(dirname(resolvedPath), { recursive: true });
    }

    const db = new Database(resolvedPath, { create: true });
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    this.db = db;
  }

  async disconnect(): Promise<void> {
    if (this.db) {
      this.db.close();
      this.db = null;
      this.transactionDepth = 0;
    }
  }

  async initSchema(): Promise<void> {
    const db = this.database;
    db.exec(SCHEMA_SQL);
    db.run(
      `INSERT OR IGNORE INTO config (key, value) VALUES
        ('version', ?),
        ('engine', 'sqlite'),
        ('embedding_model', ?),
        ('embedding_dimensions', '768'),
        ('chunk_strategy', 'semantic')`,
      [String(BASELINE_VERSION), DEFAULT_EMBEDDING_MODEL],
    );
    db.run(`UPDATE config SET value = 'sqlite' WHERE key = 'engine'`);

    const current = parseVersion(await this.getConfig('version'));
    let migrated = false;
    if (current < LATEST_VERSION) {
      await this.runSqliteMigrations(current);
      migrated = true;
    }

    // Rebuild FTS index after schema migration. On a fresh database at baseline
    // version (no migrations needed), the FTS triggers maintain the index for all
    // subsequent CRUD — no rebuild is required. If FTS corruption is ever suspected,
    // re-running `gbrain init --local` triggers a migration version bump and rebuild.
    if (migrated) {
      db.exec(`INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')`);
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const db = this.database;
    const depth = this.transactionDepth;
    const savepoint = `gbrain_sp_${depth}`;
    this.transactionDepth += 1;

    try {
      if (depth === 0) {
        db.exec('BEGIN IMMEDIATE');
      } else {
        db.exec(`SAVEPOINT ${savepoint}`);
      }

      const result = await fn(this);

      if (depth === 0) {
        db.exec('COMMIT');
      } else {
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      }
      return result;
    } catch (error) {
      try {
        if (depth === 0) {
          if (db.inTransaction) db.exec('ROLLBACK');
        } else {
          db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
          db.exec(`RELEASE SAVEPOINT ${savepoint}`);
        }
      } catch {
        // Best effort rollback.
      }
      throw error;
    } finally {
      this.transactionDepth -= 1;
    }
  }

  async getPage(slug: string): Promise<Page | null> {
    const row = this.database.query(`
      SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
      FROM pages
      WHERE slug = ?
    `).get(validateSlug(slug)) as Record<string, unknown> | null;
    return row ? rowToPage(row) : null;
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    const normalizedSlug = validateSlug(slug);
    const now = nowIso();
    const hash = page.content_hash || contentHash(page.compiled_truth, page.timeline || '');
    const frontmatterObject = page.frontmatter || {};
    const frontmatter = JSON.stringify(frontmatterObject);
    const searchText = buildFrontmatterSearchText(frontmatterObject);

    this.database.run(`
      INSERT INTO pages (slug, type, title, compiled_truth, timeline, search_text, frontmatter, content_hash, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(slug) DO UPDATE SET
        type = excluded.type,
        title = excluded.title,
        compiled_truth = excluded.compiled_truth,
        timeline = excluded.timeline,
        search_text = excluded.search_text,
        frontmatter = excluded.frontmatter,
        content_hash = excluded.content_hash,
        updated_at = excluded.updated_at
    `, [
      normalizedSlug,
      page.type,
      page.title,
      page.compiled_truth,
      page.timeline || '',
      searchText,
      frontmatter,
      hash,
      now,
      now,
    ]);

    return this.requirePage(normalizedSlug);
  }

  async deletePage(slug: string): Promise<void> {
    this.database.run(`DELETE FROM pages WHERE slug = ?`, [validateSlug(slug)]);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const conditions: string[] = [];
    const params: unknown[] = [];
    let sql = `
      SELECT DISTINCT p.*
      FROM pages p
    `;

    if (filters?.tag) {
      sql += ` JOIN tags t ON t.page_id = p.id `;
      conditions.push(`t.tag = ?`);
      params.push(filters.tag);
    }

    if (filters?.type) {
      conditions.push(`p.type = ?`);
      params.push(filters.type);
    }

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    sql += ` ORDER BY p.updated_at DESC, p.id DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);

    const rows = this.database.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToPage);
  }

  /**
   * Resolve partial slug input to matching page slugs.
   *
   * Parity note: PostgresEngine uses pg_trgm similarity scoring (the `%` operator),
   * which tolerates typos and fuzzy partial-word matches. SQLiteEngine uses
   * case-insensitive LIKE, which requires the query to be a substring of the slug
   * or title. This is the best available approach without a trigram extension.
   */
  async resolveSlugs(partial: string): Promise<string[]> {
    const normalized = partial.toLowerCase();
    const exact = this.database.query(`SELECT slug FROM pages WHERE slug = ?`).all(normalized) as { slug: string }[];
    if (exact.length > 0) return exact.map(row => row.slug);

    const like = `%${escapeLike(normalized)}%`;
    const prefix = `${escapeLike(normalized)}%`;
    const rows = this.database.query(`
      SELECT slug
      FROM pages
      WHERE lower(slug) LIKE ? ESCAPE '\\' OR lower(title) LIKE ? ESCAPE '\\'
      ORDER BY
        CASE
          WHEN lower(slug) LIKE ? ESCAPE '\\' THEN 0
          WHEN lower(title) LIKE ? ESCAPE '\\' THEN 1
          ELSE 2
        END,
        length(slug),
        slug
      LIMIT 5
    `).all(like, like, prefix, prefix) as { slug: string }[];

    return rows.map(row => row.slug);
  }

  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const prepared = prepareFtsQuery(query);
    if (!prepared) return [];

    const limit = opts?.limit ?? 20;
    const params: unknown[] = [prepared];
    let sql = `
      SELECT
        p.id AS page_id,
        p.slug,
        p.title,
        p.type,
        p.compiled_truth,
        p.timeline,
        p.search_text,
        bm25(pages_fts, 8.0, 3.0, 2.0, 2.5) AS rank,
        CASE WHEN EXISTS (
          SELECT 1 FROM timeline_entries te
          WHERE te.page_id = p.id AND p.updated_at < te.created_at
        ) THEN 1 ELSE 0 END AS stale
      FROM pages_fts
      JOIN pages p ON p.id = pages_fts.rowid
      WHERE pages_fts MATCH ?
    `;

    if (opts?.type) {
      sql += ` AND p.type = ?`;
      params.push(opts.type);
    }

    if (opts?.exclude_slugs?.length) {
      sql += ` AND p.slug NOT IN (${opts.exclude_slugs.map(() => '?').join(', ')})`;
      params.push(...opts.exclude_slugs.map(slug => validateSlug(slug)));
    }

    sql += ` ORDER BY rank ASC LIMIT ?`;
    params.push(limit);

    try {
      const rows = this.database.query(sql).all(...params) as Record<string, unknown>[];
      return rows.map(row => rowToSearchResult(row, query));
    } catch {
      // Malformed FTS5 queries (special chars, unmatched quotes) degrade to empty results
      return [];
    }
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = opts?.limit ?? 20;
    const params: unknown[] = [];
    let sql = `
      SELECT
        p.id AS page_id,
        p.slug,
        p.title,
        p.type,
        cc.chunk_text,
        cc.chunk_source,
        cc.embedding,
        CASE WHEN EXISTS (
          SELECT 1 FROM timeline_entries te
          WHERE te.page_id = p.id AND p.updated_at < te.created_at
        ) THEN 1 ELSE 0 END AS stale
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE cc.embedding IS NOT NULL
    `;

    if (opts?.type) {
      sql += ` AND p.type = ?`;
      params.push(opts.type);
    }

    if (opts?.exclude_slugs?.length) {
      sql += ` AND p.slug NOT IN (${opts.exclude_slugs.map(() => '?').join(', ')})`;
      params.push(...opts.exclude_slugs.map(slug => validateSlug(slug)));
    }

    const rows = this.database.query(sql).all(...params) as Record<string, unknown>[];

    return searchLocalVectors(
      embedding,
      rows.map(rowToLocalVectorCandidate),
      limit,
    );
  }

  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const pageId = this.getPageIdOrThrow(slug);
    const db = this.database;

    if (chunks.length === 0) {
      db.run(`DELETE FROM content_chunks WHERE page_id = ?`, [pageId]);
      return;
    }

    const indices = chunks.map(chunk => chunk.chunk_index);
    db.run(
      `DELETE FROM content_chunks WHERE page_id = ? AND chunk_index NOT IN (${indices.map(() => '?').join(', ')})`,
      [pageId, ...indices],
    );

    for (const chunk of chunks) {
      const embedding = chunk.embedding ? float32ToBlob(chunk.embedding) : null;
      db.run(`
        INSERT INTO content_chunks (
          page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(page_id, chunk_index) DO UPDATE SET
          chunk_text = excluded.chunk_text,
          chunk_source = excluded.chunk_source,
          embedding = COALESCE(excluded.embedding, content_chunks.embedding),
          model = excluded.model,
          token_count = excluded.token_count,
          embedded_at = CASE
            WHEN excluded.embedding IS NOT NULL THEN excluded.embedded_at
            ELSE content_chunks.embedded_at
          END
      `, [
        pageId,
        chunk.chunk_index,
        chunk.chunk_text,
        chunk.chunk_source,
        embedding,
        chunk.model || DEFAULT_EMBEDDING_MODEL,
        chunk.token_count ?? null,
        embedding ? nowIso() : null,
      ]);
    }
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const rows = this.database.query(`
      SELECT cc.*
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ?
      ORDER BY cc.chunk_index
    `).all(validateSlug(slug)) as Record<string, unknown>[];
    return rows.map(rowToChunk);
  }

  async getChunksWithEmbeddings(slug: string): Promise<Chunk[]> {
    const rows = this.database.query(`
      SELECT cc.*
      FROM content_chunks cc
      JOIN pages p ON p.id = cc.page_id
      WHERE p.slug = ?
      ORDER BY cc.chunk_index
    `).all(validateSlug(slug)) as Record<string, unknown>[];
    return rows.map(row => rowToChunk(row, true));
  }

  async deleteChunks(slug: string): Promise<void> {
    const pageId = this.getPageId(slug);
    if (pageId === null) return;
    this.database.run(`DELETE FROM content_chunks WHERE page_id = ?`, [pageId]);
  }

  async addLink(from: string, to: string, context?: string, linkType?: string): Promise<void> {
    const fromId = this.getPageId(from);
    const toId = this.getPageId(to);
    if (fromId === null || toId === null) return;

    this.database.run(`
      INSERT INTO links (from_page_id, to_page_id, link_type, context, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(from_page_id, to_page_id) DO UPDATE SET
        link_type = excluded.link_type,
        context = excluded.context
    `, [fromId, toId, linkType || '', context || '', nowIso()]);
  }

  async removeLink(from: string, to: string): Promise<void> {
    const fromId = this.getPageId(from);
    const toId = this.getPageId(to);
    if (fromId === null || toId === null) return;
    this.database.run(`DELETE FROM links WHERE from_page_id = ? AND to_page_id = ?`, [fromId, toId]);
  }

  async getLinks(slug: string): Promise<Link[]> {
    const rows = this.database.query(`
      SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE f.slug = ?
      ORDER BY t.slug
    `).all(validateSlug(slug)) as Record<string, unknown>[];
    return rows.map(rowToLink);
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const rows = this.database.query(`
      SELECT f.slug AS from_slug, t.slug AS to_slug, l.link_type, l.context
      FROM links l
      JOIN pages f ON f.id = l.from_page_id
      JOIN pages t ON t.id = l.to_page_id
      WHERE t.slug = ?
      ORDER BY f.slug
    `).all(validateSlug(slug)) as Record<string, unknown>[];
    return rows.map(rowToLink);
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const root = await this.getPage(slug);
    if (!root) return [];

    const visited = new Set<string>();
    const queue: Array<{ slug: string; depth: number }> = [{ slug: root.slug, depth: 0 }];
    const nodes: GraphNode[] = [];

    while (queue.length > 0) {
      const current = queue.shift()!;
      if (visited.has(current.slug)) continue;
      visited.add(current.slug);

      const page = await this.getPage(current.slug);
      if (!page) continue;
      const links = (await this.getLinks(page.slug))
        .map(link => ({ to_slug: link.to_slug, link_type: link.link_type }))
        .sort((a, b) => a.to_slug.localeCompare(b.to_slug));

      nodes.push({
        slug: page.slug,
        title: page.title,
        type: page.type,
        depth: current.depth,
        links,
      });

      if (current.depth >= depth) continue;
      for (const link of links) {
        if (!visited.has(link.to_slug)) {
          queue.push({ slug: link.to_slug, depth: current.depth + 1 });
        }
      }
    }

    return nodes;
  }

  async addTag(slug: string, tag: string): Promise<void> {
    const pageId = this.getPageId(slug);
    if (pageId === null) return;
    this.database.run(`INSERT OR IGNORE INTO tags (page_id, tag) VALUES (?, ?)`, [pageId, tag]);
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    const pageId = this.getPageId(slug);
    if (pageId === null) return;
    this.database.run(`DELETE FROM tags WHERE page_id = ? AND tag = ?`, [pageId, tag]);
  }

  async getTags(slug: string): Promise<string[]> {
    const pageId = this.getPageId(slug);
    if (pageId === null) return [];
    const rows = this.database.query(`SELECT tag FROM tags WHERE page_id = ? ORDER BY tag`).all(pageId) as { tag: string }[];
    return rows.map(row => row.tag);
  }

  async addTimelineEntry(slug: string, entry: TimelineInput): Promise<void> {
    const pageId = this.getPageId(slug);
    if (pageId === null) return;
    this.database.run(`
      INSERT INTO timeline_entries (page_id, date, source, summary, detail, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [pageId, entry.date, entry.source || '', entry.summary, entry.detail || '', nowIso()]);
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const params: unknown[] = [validateSlug(slug)];
    let sql = `
      SELECT te.*
      FROM timeline_entries te
      JOIN pages p ON p.id = te.page_id
      WHERE p.slug = ?
    `;

    if (opts?.after) {
      sql += ` AND te.date >= ?`;
      params.push(opts.after);
    }
    if (opts?.before) {
      sql += ` AND te.date <= ?`;
      params.push(opts.before);
    }

    sql += ` ORDER BY te.date DESC LIMIT ?`;
    params.push(opts?.limit ?? 100);

    const rows = this.database.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToTimelineEntry);
  }

  async putRawData(slug: string, source: string, data: object): Promise<void> {
    const pageId = this.getPageId(slug);
    if (pageId === null) return;
    this.database.run(`
      INSERT INTO raw_data (page_id, source, data, fetched_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(page_id, source) DO UPDATE SET
        data = excluded.data,
        fetched_at = excluded.fetched_at
    `, [pageId, source, JSON.stringify(data), nowIso()]);
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    const params: unknown[] = [validateSlug(slug)];
    let sql = `
      SELECT rd.source, rd.data, rd.fetched_at
      FROM raw_data rd
      JOIN pages p ON p.id = rd.page_id
      WHERE p.slug = ?
    `;

    if (source) {
      sql += ` AND rd.source = ?`;
      params.push(source);
    }

    sql += ` ORDER BY rd.source`;
    const rows = this.database.query(sql).all(...params) as Record<string, unknown>[];
    return rows.map(rowToRawData);
  }

  async createVersion(slug: string): Promise<PageVersion> {
    const page = await this.requirePage(validateSlug(slug));
    const now = nowIso();
    this.database.run(`
      INSERT INTO page_versions (page_id, compiled_truth, frontmatter, snapshot_at)
      VALUES (?, ?, ?, ?)
    `, [page.id, page.compiled_truth, JSON.stringify(page.frontmatter), now]);

    const row = this.database.query(`
      SELECT id, page_id, compiled_truth, frontmatter, snapshot_at
      FROM page_versions
      WHERE page_id = ?
      ORDER BY id DESC
      LIMIT 1
    `).get(page.id) as Record<string, unknown>;

    return rowToPageVersion(row);
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    const rows = this.database.query(`
      SELECT pv.id, pv.page_id, pv.compiled_truth, pv.frontmatter, pv.snapshot_at
      FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ?
      ORDER BY pv.snapshot_at DESC, pv.id DESC
    `).all(validateSlug(slug)) as Record<string, unknown>[];
    return rows.map(rowToPageVersion);
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    const normalizedSlug = validateSlug(slug);
    const row = this.database.query(`
      SELECT pv.compiled_truth, pv.frontmatter, p.title, p.type, p.timeline
      FROM page_versions pv
      JOIN pages p ON p.id = pv.page_id
      WHERE p.slug = ? AND pv.id = ?
      LIMIT 1
    `).get(normalizedSlug, versionId) as Record<string, unknown> | null;

    if (!row) return;
    const frontmatter = parseJsonObject(row.frontmatter);
    const tags = await this.getTags(normalizedSlug);
    const searchText = buildFrontmatterSearchText(frontmatter);
    const hash = importContentHash({
      title: String(row.title),
      type: String(row.type) as PageType,
      compiled_truth: String(row.compiled_truth),
      timeline: String(row.timeline ?? ''),
      frontmatter,
      tags,
    });
    this.database.run(`
      UPDATE pages
      SET compiled_truth = ?, search_text = ?, frontmatter = ?, content_hash = ?, updated_at = ?
      WHERE slug = ?
    `, [row.compiled_truth, searchText, JSON.stringify(frontmatter), hash, nowIso(), normalizedSlug]);

    const page = await this.requirePage(normalizedSlug);
    await ensurePageChunks(this, page);
  }

  async getStats(): Promise<BrainStats> {
    const stats = this.database.query(`
      SELECT
        (SELECT count(*) FROM pages) AS page_count,
        (SELECT count(*) FROM content_chunks) AS chunk_count,
        (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) AS embedded_count,
        (SELECT count(*) FROM links) AS link_count,
        (SELECT count(DISTINCT tag) FROM tags) AS tag_count,
        (SELECT count(*) FROM timeline_entries) AS timeline_entry_count
    `).get() as Record<string, unknown>;

    const types = this.database.query(`
      SELECT type, count(*) AS count
      FROM pages
      GROUP BY type
      ORDER BY type
    `).all() as Array<{ type: string; count: number }>;

    const pages_by_type: Record<string, number> = {};
    for (const row of types) {
      pages_by_type[row.type] = Number(row.count);
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
    const pageCount = Number((this.database.query(`SELECT count(*) AS count FROM pages`).get() as { count: number }).count);
    const chunkCount = Number((this.database.query(`SELECT count(*) AS count FROM content_chunks`).get() as { count: number }).count);
    const embeddedCount = Number((this.database.query(`SELECT count(*) AS count FROM content_chunks WHERE embedded_at IS NOT NULL`).get() as { count: number }).count);
    const stalePages = Number((this.database.query(`
      SELECT count(*) AS count
      FROM pages p
      WHERE EXISTS (
        SELECT 1 FROM timeline_entries te
        WHERE te.page_id = p.id AND p.updated_at < te.created_at
      )
    `).get() as { count: number }).count);
    const orphanPages = Number((this.database.query(`
      SELECT count(*) AS count
      FROM pages p
      WHERE NOT EXISTS (
        SELECT 1 FROM links l WHERE l.to_page_id = p.id
      )
    `).get() as { count: number }).count);
    const deadLinks = Number((this.database.query(`
      SELECT count(*) AS count
      FROM links l
      LEFT JOIN pages p ON p.id = l.to_page_id
      WHERE p.id IS NULL
    `).get() as { count: number }).count);

    return {
      page_count: pageCount,
      embed_coverage: chunkCount === 0 ? 0 : embeddedCount / chunkCount,
      stale_pages: stalePages,
      orphan_pages: orphanPages,
      dead_links: deadLinks,
      missing_embeddings: chunkCount - embeddedCount,
    };
  }

  async logIngest(entry: IngestLogInput): Promise<void> {
    this.database.run(`
      INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary, created_at)
      VALUES (?, ?, ?, ?, ?)
    `, [entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary, nowIso()]);
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const rows = this.database.query(`
      SELECT id, source_type, source_ref, pages_updated, summary, created_at
      FROM ingest_log
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(opts?.limit ?? 50) as Record<string, unknown>[];
    return rows.map(rowToIngestLog);
  }

  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    this.database.run(`UPDATE pages SET slug = ?, updated_at = ? WHERE slug = ? OR lower(slug) = ?`, [
      validateSlug(newSlug),
      nowIso(),
      oldSlug,
      oldSlug.toLowerCase(),
    ]);
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Links are stored by page_id, so slug updates do not require link rewrites.
  }

  async getConfig(key: string): Promise<string | null> {
    const row = this.database.query(`SELECT value FROM config WHERE key = ?`).get(key) as { value: string } | null;
    return row?.value ?? null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.database.run(`
      INSERT INTO config (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `, [key, value]);
  }

  private async runSqliteMigrations(current: number): Promise<void> {
    for (let version = current + 1; version <= LATEST_VERSION; version += 1) {
      switch (version) {
        case 2:
          await this.migrateLegacySlugs();
          break;
        case 3:
          this.database.exec(`
            DELETE FROM content_chunks
            WHERE id NOT IN (
              SELECT MIN(id) FROM content_chunks GROUP BY page_id, chunk_index
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index
              ON content_chunks(page_id, chunk_index);
          `);
          break;
        case 4:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS access_tokens (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              token_hash TEXT NOT NULL UNIQUE,
              scopes TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              last_used_at TEXT,
              revoked_at TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_access_tokens_hash
              ON access_tokens (token_hash)
              WHERE revoked_at IS NULL;
            CREATE TABLE IF NOT EXISTS mcp_request_log (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              token_name TEXT,
              operation TEXT NOT NULL,
              latency_ms INTEGER,
              status TEXT NOT NULL DEFAULT 'success',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
          `);
          break;
        case 6:
          {
            const columns = this.database.query(`PRAGMA table_info(pages)`).all() as Array<{ name: string }>;
            const hasSearchText = columns.some((column) => column.name === 'search_text');
            this.database.exec(`
              DROP TRIGGER IF EXISTS pages_fts_insert;
              DROP TRIGGER IF EXISTS pages_fts_update;
              DROP TRIGGER IF EXISTS pages_fts_delete;
              DROP TABLE IF EXISTS pages_fts;
            `);

            if (!hasSearchText) {
              this.database.exec(`ALTER TABLE pages ADD COLUMN search_text TEXT NOT NULL DEFAULT '';`);
            }

            for (const page of await this.listAllPages()) {
              const searchText = buildFrontmatterSearchText(page.frontmatter);
              this.database.run(`UPDATE pages SET search_text = ? WHERE id = ?`, [searchText, page.id]);
              await ensurePageChunks(this, page);
            }

            this.database.exec(`
              CREATE VIRTUAL TABLE pages_fts USING fts5(
                title,
                compiled_truth,
                timeline,
                search_text,
                content='pages',
                content_rowid='id',
                tokenize='porter unicode61'
              );

              CREATE TRIGGER pages_fts_insert AFTER INSERT ON pages BEGIN
                INSERT INTO pages_fts(rowid, title, compiled_truth, timeline, search_text)
                VALUES (new.id, new.title, new.compiled_truth, new.timeline, new.search_text);
              END;

              CREATE TRIGGER pages_fts_update AFTER UPDATE ON pages BEGIN
                INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline, search_text)
                VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline, old.search_text);
                INSERT INTO pages_fts(rowid, title, compiled_truth, timeline, search_text)
                VALUES (new.id, new.title, new.compiled_truth, new.timeline, new.search_text);
              END;

              CREATE TRIGGER pages_fts_delete AFTER DELETE ON pages BEGIN
                INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline, search_text)
                VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline, old.search_text);
              END;
            `);
          }
          break;
      }

      await this.setConfig('version', String(version));
    }
  }

  private async migrateLegacySlugs(): Promise<void> {
    const pages = await this.listAllPages();
    for (const page of pages) {
      const newSlug = slugifyPath(page.slug);
      if (newSlug !== page.slug) {
        try {
          await this.updateSlug(page.slug, newSlug);
          await this.rewriteLinks(page.slug, newSlug);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          console.error(`  Warning: could not rename "${page.slug}" → "${newSlug}": ${message}`);
        }
      }
    }
  }

  private async listAllPages(batchSize = 1000): Promise<Page[]> {
    const pages: Page[] = [];

    for (let offset = 0; ; offset += batchSize) {
      const batch = await this.listPages({ limit: batchSize, offset });
      pages.push(...batch);
      if (batch.length < batchSize) {
        break;
      }
    }

    return pages;
  }

  private async requirePage(slug: string): Promise<Page> {
    const page = await this.getPage(slug);
    if (!page) throw new Error(`Page not found: ${slug}`);
    return page;
  }

  private getPageId(slug: string): number | null {
    const row = this.database.query(`SELECT id FROM pages WHERE slug = ?`).get(validateSlug(slug)) as { id: number } | null;
    return row?.id ?? null;
  }

  private getPageIdOrThrow(slug: string): number {
    const pageId = this.getPageId(slug);
    if (pageId === null) throw new Error(`Page not found: ${validateSlug(slug)}`);
    return pageId;
  }
}

function resolveDatabasePath(databasePath: string): string {
  if (databasePath === ':memory:') return databasePath;
  if (databasePath === '~') return homedir();
  if (databasePath.startsWith('~/')) return join(homedir(), databasePath.slice(2));
  return databasePath;
}

function validateSlug(slug: string): string {
  if (!slug || /\.\./.test(slug) || /^\//.test(slug)) {
    throw new Error(`Invalid slug: "${slug}". Slugs cannot be empty, start with /, or contain path traversal.`);
  }
  return slug.toLowerCase();
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseVersion(value: string | null): number {
  const parsed = parseInt(value || String(BASELINE_VERSION), 10);
  if (!Number.isFinite(parsed) || parsed < BASELINE_VERSION) return BASELINE_VERSION;
  return parsed;
}

function escapeLike(value: string): string {
  return value.replace(/([\\%_])/g, '\\$1');
}

function prepareFtsQuery(query: string): string {
  const terms = extractSearchTerms(query);
  if (terms.length === 0) return '';
  return terms.map(term => `"${term}"*`).join(' AND ');
}

function float32ToBlob(value: Float32Array): Uint8Array {
  return new Uint8Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function blobToFloat32(value: unknown): Float32Array | null {
  if (!(value instanceof Uint8Array)) return null;
  if (value.byteLength === 0 || value.byteLength % Float32Array.BYTES_PER_ELEMENT !== 0) return null;
  return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

function rowToPage(row: Record<string, unknown>): Page {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    type: row.type as PageType,
    title: String(row.title),
    compiled_truth: String(row.compiled_truth),
    timeline: String(row.timeline),
    frontmatter: parseJsonObject(row.frontmatter),
    content_hash: row.content_hash ? String(row.content_hash) : undefined,
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

function rowToChunk(row: Record<string, unknown>, includeEmbedding = false): Chunk {
  return {
    id: Number(row.id),
    page_id: Number(row.page_id),
    chunk_index: Number(row.chunk_index),
    chunk_text: String(row.chunk_text),
    chunk_source: row.chunk_source as Chunk['chunk_source'],
    embedding: includeEmbedding ? blobToFloat32(row.embedding) : null,
    model: String(row.model),
    token_count: row.token_count === null || row.token_count === undefined ? null : Number(row.token_count),
    embedded_at: row.embedded_at ? new Date(String(row.embedded_at)) : null,
  };
}

function rowToLink(row: Record<string, unknown>): Link {
  return {
    from_slug: String(row.from_slug),
    to_slug: String(row.to_slug),
    link_type: String(row.link_type || ''),
    context: String(row.context || ''),
  };
}

function rowToTimelineEntry(row: Record<string, unknown>): TimelineEntry {
  return {
    id: Number(row.id),
    page_id: Number(row.page_id),
    date: String(row.date),
    source: String(row.source || ''),
    summary: String(row.summary),
    detail: String(row.detail || ''),
    created_at: new Date(String(row.created_at)),
  };
}

function rowToRawData(row: Record<string, unknown>): RawData {
  return {
    source: String(row.source),
    data: parseJsonObject(row.data),
    fetched_at: new Date(String(row.fetched_at)),
  };
}

function rowToPageVersion(row: Record<string, unknown>): PageVersion {
  return {
    id: Number(row.id),
    page_id: Number(row.page_id),
    compiled_truth: String(row.compiled_truth),
    frontmatter: parseJsonObject(row.frontmatter),
    snapshot_at: new Date(String(row.snapshot_at)),
  };
}

function rowToIngestLog(row: Record<string, unknown>): IngestLogEntry {
  return {
    id: Number(row.id),
    source_type: String(row.source_type),
    source_ref: String(row.source_ref),
    pages_updated: parseJsonArray(row.pages_updated),
    summary: String(row.summary),
    created_at: new Date(String(row.created_at)),
  };
}

/**
 * Extract a focused text snippet around matching query terms.
 * Returns ~300-char window centered on the first match, with ellipsis markers.
 */
function extractSnippet(text: string, queryTerms: string[], windowSize: number = 300): string {
  if (text.length <= windowSize) return text;

  const lower = text.toLowerCase();
  let firstMatch = -1;
  for (const term of queryTerms) {
    const idx = lower.indexOf(term.toLowerCase());
    if (idx !== -1) {
      firstMatch = idx;
      break;
    }
  }

  if (firstMatch === -1) {
    // No term match found; return the beginning of the text
    const end = Math.min(windowSize, text.length);
    const slice = text.slice(0, end);
    // Trim to last word boundary
    const lastSpace = slice.lastIndexOf(' ');
    return (lastSpace > windowSize * 0.6 ? slice.slice(0, lastSpace) : slice) + '...';
  }

  const half = Math.floor(windowSize / 2);
  let start = Math.max(0, firstMatch - half);
  let end = Math.min(text.length, start + windowSize);
  if (end - start < windowSize) start = Math.max(0, end - windowSize);

  let slice = text.slice(start, end);
  let trimmedStart = start;
  let trimmedEnd = end;

  // Trim to word boundaries
  const wordBoundaryTolerance = 40;
  if (start > 0) {
    const firstSpace = slice.indexOf(' ');
    if (firstSpace > 0 && firstSpace < wordBoundaryTolerance) {
      slice = slice.slice(firstSpace + 1);
      trimmedStart = start + firstSpace + 1;
    }
  }
  if (end < text.length) {
    const lastSpace = slice.lastIndexOf(' ');
    if (lastSpace > slice.length - wordBoundaryTolerance) {
      slice = slice.slice(0, lastSpace);
      trimmedEnd = trimmedStart + lastSpace;
    }
  }

  const prefix = trimmedStart > 0 ? '...' : '';
  const suffix = trimmedEnd < text.length ? '...' : '';
  return prefix + slice + suffix;
}

function rowToSearchResult(row: Record<string, unknown>, query: string): SearchResult {
  const compiled = String(row.compiled_truth || '');
  const timeline = String(row.timeline || '');
  const searchText = String(row.search_text || '');
  const normalizedTerms = extractSearchTerms(query).map(term => term.toLowerCase());
  const compiledMatch = normalizedTerms.some(term => compiled.toLowerCase().includes(term));
  const timelineMatch = normalizedTerms.some(term => timeline.toLowerCase().includes(term));
  const frontmatterMatch = normalizedTerms.some(term => searchText.toLowerCase().includes(term));
  const chunk_source = compiledMatch
    ? 'compiled_truth'
    : timelineMatch
      ? 'timeline'
      : frontmatterMatch
        ? 'frontmatter'
        : 'compiled_truth';
  const sourceText = chunk_source === 'compiled_truth'
    ? compiled || timeline || searchText || String(row.title)
    : chunk_source === 'timeline'
      ? timeline || compiled || searchText || String(row.title)
      : searchText || compiled || timeline || String(row.title);
  const chunk_text = extractSnippet(sourceText, normalizedTerms);
  const rawRank = Number(row.rank ?? 0);

  return {
    slug: String(row.slug),
    page_id: Number(row.page_id),
    title: String(row.title),
    type: row.type as PageType,
    chunk_text,
    chunk_source,
    score: Math.max(0, -rawRank),
    stale: Boolean(row.stale),
  };
}

function rowToLocalVectorCandidate(row: Record<string, unknown>) {
  return {
    slug: String(row.slug),
    page_id: Number(row.page_id),
    title: String(row.title),
    type: row.type as PageType,
    chunk_text: String(row.chunk_text),
    chunk_source: row.chunk_source as Chunk['chunk_source'],
    stale: Boolean(row.stale),
    embedding: blobToFloat32(row.embedding),
  };
}

function extractSearchTerms(query: string): string[] {
  const parts = query
    .trim()
    .split(/\s+/)
    .map(term => term.replace(/["']/g, '').trim())
    .flatMap((term) => {
      const aliases = expandTechnicalAliases(term);
      const normalized = term.split(/[^A-Za-z0-9]+/).filter(Boolean);
      const filteredNormalized = aliases.length > 0
        ? normalized.filter(piece => piece.length > 1)
        : normalized;
      return [...filteredNormalized, ...aliases];
    })
    .filter(Boolean);
  return Array.from(new Set(parts));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value === 'string' && value.length > 0) {
    return JSON.parse(value) as Record<string, unknown>;
  }
  return {};
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(item => String(item));
  if (typeof value === 'string' && value.length > 0) {
    return JSON.parse(value) as string[];
  }
  return [];
}
