import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import { dirname, join } from 'path';
import type { BrainEngine } from './engine.ts';
import { LATEST_VERSION } from './migrate.ts';
import { ensurePageChunks } from './page-chunks.ts';
import { buildPageCentroid } from './services/page-embedding.ts';
import { selectLocalVectorChunkIds, selectLocalVectorPageIds } from './search/vector-prefilter.ts';
import { searchLocalVectors } from './search/vector-local.ts';
import { slugifyPath } from './sync.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  NoteManifestEntry,
  NoteManifestEntryInput,
  NoteManifestFilters,
  NoteManifestHeading,
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
  MemoryCandidateEntryInput,
  MemoryCandidateFilters,
  MemoryCandidateStatusPatch,
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
  page_embedding BLOB,
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

CREATE TABLE IF NOT EXISTS task_threads (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  title TEXT NOT NULL,
  goal TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL,
  repo_path TEXT,
  branch_name TEXT,
  current_summary TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_task_threads_status_updated ON task_threads(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_task_threads_scope_updated ON task_threads(scope, updated_at DESC);

CREATE TABLE IF NOT EXISTS task_working_sets (
  task_id TEXT PRIMARY KEY REFERENCES task_threads(id) ON DELETE CASCADE,
  active_paths TEXT NOT NULL DEFAULT '[]',
  active_symbols TEXT NOT NULL DEFAULT '[]',
  blockers TEXT NOT NULL DEFAULT '[]',
  open_questions TEXT NOT NULL DEFAULT '[]',
  next_steps TEXT NOT NULL DEFAULT '[]',
  verification_notes TEXT NOT NULL DEFAULT '[]',
  last_verified_at TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS task_attempts (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  outcome TEXT NOT NULL,
  applicability_context TEXT NOT NULL DEFAULT '{}',
  evidence TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_task_attempts_task_created ON task_attempts(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS task_decisions (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
  summary TEXT NOT NULL,
  rationale TEXT NOT NULL DEFAULT '',
  consequences TEXT NOT NULL DEFAULT '[]',
  validity_context TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_task_decisions_task_created ON task_decisions(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS retrieval_traces (
  id TEXT PRIMARY KEY,
  task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
  scope TEXT NOT NULL,
  route TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  verification TEXT NOT NULL DEFAULT '[]',
  outcome TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_retrieval_traces_task_created ON retrieval_traces(task_id, created_at DESC);

CREATE TABLE IF NOT EXISTS note_manifest_entries (
  scope_id TEXT NOT NULL,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  path TEXT NOT NULL,
  page_type TEXT NOT NULL,
  title TEXT NOT NULL,
  frontmatter TEXT NOT NULL DEFAULT '{}',
  aliases TEXT NOT NULL DEFAULT '[]',
  tags TEXT NOT NULL DEFAULT '[]',
  outgoing_wikilinks TEXT NOT NULL DEFAULT '[]',
  outgoing_urls TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  heading_index TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope_id, page_id)
);
CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_slug
  ON note_manifest_entries(scope_id, slug);
CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_indexed
  ON note_manifest_entries(scope_id, last_indexed_at DESC);

CREATE TABLE IF NOT EXISTS note_section_entries (
  scope_id TEXT NOT NULL,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  page_slug TEXT NOT NULL,
  page_path TEXT NOT NULL,
  section_id TEXT NOT NULL,
  parent_section_id TEXT,
  heading_slug TEXT NOT NULL,
  heading_path TEXT NOT NULL DEFAULT '[]',
  heading_text TEXT NOT NULL,
  depth INTEGER NOT NULL,
  line_start INTEGER NOT NULL,
  line_end INTEGER NOT NULL,
  section_text TEXT NOT NULL,
  outgoing_wikilinks TEXT NOT NULL DEFAULT '[]',
  outgoing_urls TEXT NOT NULL DEFAULT '[]',
  source_refs TEXT NOT NULL DEFAULT '[]',
  content_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  last_indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  PRIMARY KEY (scope_id, section_id)
);
CREATE INDEX IF NOT EXISTS idx_note_sections_scope_page
  ON note_section_entries(scope_id, page_slug, line_start);
CREATE INDEX IF NOT EXISTS idx_note_sections_scope_indexed
  ON note_section_entries(scope_id, last_indexed_at DESC);

CREATE TABLE IF NOT EXISTS context_map_entries (
  id TEXT PRIMARY KEY,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  build_mode TEXT NOT NULL,
  status TEXT NOT NULL,
  source_set_hash TEXT NOT NULL,
  extractor_version TEXT NOT NULL,
  node_count INTEGER NOT NULL,
  edge_count INTEGER NOT NULL,
  community_count INTEGER NOT NULL DEFAULT 0,
  graph_json TEXT NOT NULL DEFAULT '{}',
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  stale_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_context_map_scope_generated
  ON context_map_entries(scope_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_map_scope_kind
  ON context_map_entries(scope_id, kind);

CREATE TABLE IF NOT EXISTS context_atlas_entries (
  id TEXT PRIMARY KEY,
  map_id TEXT NOT NULL REFERENCES context_map_entries(id) ON DELETE CASCADE,
  scope_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  freshness TEXT NOT NULL,
  entrypoints TEXT NOT NULL DEFAULT '[]',
  budget_hint INTEGER NOT NULL,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_generated
  ON context_atlas_entries(scope_id, generated_at DESC);
CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_kind
  ON context_atlas_entries(scope_id, kind);

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
      throw new MBrainError(
        'No database path',
        'database_path is missing',
        'Set database_path in ~/.mbrain/config.json before using engine="sqlite"',
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
    ensurePageEmbeddingColumn(db);
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

    this.backfillMissingPageEmbeddingsFromChunks();

    // Rebuild FTS index after schema migration. On a fresh database at baseline
    // version (no migrations needed), the FTS triggers maintain the index for all
    // subsequent CRUD — no rebuild is required. If FTS corruption is ever suspected,
    // re-running `mbrain init --local` triggers a migration version bump and rebuild.
    if (migrated) {
      db.exec(`INSERT INTO pages_fts(pages_fts) VALUES ('rebuild')`);
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    const db = this.database;
    const depth = this.transactionDepth;
    const savepoint = `mbrain_sp_${depth}`;
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
    const candidatePageIds = this.getLocalVectorPrefilterPageIds(embedding, limit, opts);
    const shortlistedRows = this.queryLocalVectorChunkRows(opts, candidatePageIds);
    const omittedChunkIds = this.getOmittedLocalVectorChunkIds(embedding, limit, opts, candidatePageIds);
    const omittedRows = this.queryLocalVectorChunkRowsByIds(omittedChunkIds);

    return searchLocalVectors(
      embedding,
      [...shortlistedRows, ...omittedRows].map(rowToLocalVectorCandidate),
      limit,
    );
  }

  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const pageId = this.getPageIdOrThrow(slug);
    const db = this.database;

    if (chunks.length === 0) {
      db.run(`DELETE FROM content_chunks WHERE page_id = ?`, [pageId]);
      this.refreshPageEmbeddingFromChunks(pageId);
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

    this.refreshPageEmbeddingFromChunks(pageId);
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
    this.refreshPageEmbeddingFromChunks(pageId);
  }

  async getPageEmbeddings(type?: PageType): Promise<Array<{
    page_id: number;
    slug: string;
    embedding: Float32Array | null;
  }>> {
    const params: unknown[] = [];
    let sql = `
      SELECT id AS page_id, slug, page_embedding
      FROM pages
    `;

    if (type) {
      sql += ` WHERE type = ?`;
      params.push(type);
    }

    sql += ` ORDER BY slug`;

    return this.database.query(sql).all(...params).map((row) => ({
      page_id: Number((row as Record<string, unknown>).page_id),
      slug: String((row as Record<string, unknown>).slug),
      embedding: blobToFloat32((row as Record<string, unknown>).page_embedding),
    }));
  }

  async updatePageEmbedding(slug: string, embedding: Float32Array | null): Promise<void> {
    const pageId = this.getPageIdOrThrow(slug);
    this.database.run(
      `UPDATE pages SET page_embedding = ? WHERE id = ?`,
      [embedding ? float32ToBlob(embedding) : null, pageId],
    );
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

  async createTaskThread(input: TaskThreadInput): Promise<TaskThread> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO task_threads (
        id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id,
      input.scope,
      input.title,
      input.goal ?? '',
      input.status,
      input.repo_path ?? null,
      input.branch_name ?? null,
      input.current_summary ?? '',
      timestamp,
      timestamp,
    ]);

    const thread = await this.getTaskThread(input.id);
    if (!thread) throw new Error(`Task thread not found after insert: ${input.id}`);
    return thread;
  }

  async updateTaskThread(id: string, patch: TaskThreadPatch): Promise<TaskThread> {
    const current = await this.getTaskThread(id);
    if (!current) throw new Error(`Task thread not found: ${id}`);

    this.database.run(`
      UPDATE task_threads
      SET scope = ?, title = ?, goal = ?, status = ?, repo_path = ?, branch_name = ?, current_summary = ?, updated_at = ?
      WHERE id = ?
    `, [
      patch.scope ?? current.scope,
      patch.title ?? current.title,
      patch.goal ?? current.goal,
      patch.status ?? current.status,
      patch.repo_path === undefined ? current.repo_path : patch.repo_path,
      patch.branch_name === undefined ? current.branch_name : patch.branch_name,
      patch.current_summary ?? current.current_summary,
      nowIso(),
      id,
    ]);

    const thread = await this.getTaskThread(id);
    if (!thread) throw new Error(`Task thread not found after update: ${id}`);
    return thread;
  }

  async listTaskThreads(filters?: TaskThreadFilters): Promise<TaskThread[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope) {
      clauses.push('scope = ?');
      params.push(filters.scope);
    }
    if (filters?.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }

    params.push(filters?.limit ?? 50);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
      FROM task_threads
      ${where}
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];

    return rows.map(rowToTaskThread);
  }

  async getTaskThread(id: string): Promise<TaskThread | null> {
    const row = this.database.query(`
      SELECT id, scope, title, goal, status, repo_path, branch_name, current_summary, created_at, updated_at
      FROM task_threads
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    return row ? rowToTaskThread(row) : null;
  }

  async getTaskWorkingSet(taskId: string): Promise<TaskWorkingSet | null> {
    const row = this.database.query(`
      SELECT task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
      FROM task_working_sets
      WHERE task_id = ?
    `).get(taskId) as Record<string, unknown> | null;
    return row ? rowToTaskWorkingSet(row) : null;
  }

  async upsertTaskWorkingSet(input: TaskWorkingSetInput): Promise<TaskWorkingSet> {
    const timestamp = nowIso();
    const lastVerifiedAt = input.last_verified_at instanceof Date
      ? input.last_verified_at.toISOString()
      : input.last_verified_at ?? null;

    this.database.run(`
      INSERT INTO task_working_sets (
        task_id, active_paths, active_symbols, blockers, open_questions, next_steps, verification_notes, last_verified_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(task_id) DO UPDATE SET
        active_paths = excluded.active_paths,
        active_symbols = excluded.active_symbols,
        blockers = excluded.blockers,
        open_questions = excluded.open_questions,
        next_steps = excluded.next_steps,
        verification_notes = excluded.verification_notes,
        last_verified_at = excluded.last_verified_at,
        updated_at = excluded.updated_at
    `, [
      input.task_id,
      JSON.stringify(input.active_paths ?? []),
      JSON.stringify(input.active_symbols ?? []),
      JSON.stringify(input.blockers ?? []),
      JSON.stringify(input.open_questions ?? []),
      JSON.stringify(input.next_steps ?? []),
      JSON.stringify(input.verification_notes ?? []),
      lastVerifiedAt,
      timestamp,
    ]);

    const workingSet = await this.getTaskWorkingSet(input.task_id);
    if (!workingSet) throw new Error(`Task working set not found after upsert: ${input.task_id}`);
    return workingSet;
  }

  async recordTaskAttempt(input: TaskAttemptInput): Promise<TaskAttempt> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO task_attempts (
        id, task_id, summary, outcome, applicability_context, evidence, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id,
      input.task_id,
      input.summary,
      input.outcome,
      JSON.stringify(input.applicability_context ?? {}),
      JSON.stringify(input.evidence ?? []),
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, task_id, summary, outcome, applicability_context, evidence, created_at
      FROM task_attempts
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Task attempt not found after insert: ${input.id}`);
    return rowToTaskAttempt(row);
  }

  async listTaskAttempts(taskId: string, opts?: { limit?: number }): Promise<TaskAttempt[]> {
    const rows = this.database.query(`
      SELECT id, task_id, summary, outcome, applicability_context, evidence, created_at
      FROM task_attempts
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(taskId, opts?.limit ?? 20) as Record<string, unknown>[];
    return rows.map(rowToTaskAttempt);
  }

  async recordTaskDecision(input: TaskDecisionInput): Promise<TaskDecision> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO task_decisions (
        id, task_id, summary, rationale, consequences, validity_context, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id,
      input.task_id,
      input.summary,
      input.rationale,
      JSON.stringify(input.consequences ?? []),
      JSON.stringify(input.validity_context ?? {}),
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, task_id, summary, rationale, consequences, validity_context, created_at
      FROM task_decisions
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Task decision not found after insert: ${input.id}`);
    return rowToTaskDecision(row);
  }

  async listTaskDecisions(taskId: string, opts?: { limit?: number }): Promise<TaskDecision[]> {
    const rows = this.database.query(`
      SELECT id, task_id, summary, rationale, consequences, validity_context, created_at
      FROM task_decisions
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(taskId, opts?.limit ?? 20) as Record<string, unknown>[];
    return rows.map(rowToTaskDecision);
  }

  async putRetrievalTrace(input: RetrievalTraceInput): Promise<RetrievalTrace> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO retrieval_traces (
        id, task_id, scope, route, source_refs, verification, outcome, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id,
      input.task_id ?? null,
      input.scope,
      JSON.stringify(input.route ?? []),
      JSON.stringify(input.source_refs ?? []),
      JSON.stringify(input.verification ?? []),
      input.outcome,
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, task_id, scope, route, source_refs, verification, outcome, created_at
      FROM retrieval_traces
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Retrieval trace not found after insert: ${input.id}`);
    return rowToRetrievalTrace(row);
  }

  async listRetrievalTraces(taskId: string, opts?: { limit?: number }): Promise<RetrievalTrace[]> {
    const rows = this.database.query(`
      SELECT id, task_id, scope, route, source_refs, verification, outcome, created_at
      FROM retrieval_traces
      WHERE task_id = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `).all(taskId, opts?.limit ?? 20) as Record<string, unknown>[];
    return rows.map(rowToRetrievalTrace);
  }

  async upsertProfileMemoryEntry(input: ProfileMemoryEntryInput): Promise<ProfileMemoryEntry> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO profile_memory_entries (
        id, scope_id, profile_type, subject, content, source_refs, sensitivity,
        export_status, last_confirmed_at, superseded_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope_id = excluded.scope_id,
        profile_type = excluded.profile_type,
        subject = excluded.subject,
        content = excluded.content,
        source_refs = excluded.source_refs,
        sensitivity = excluded.sensitivity,
        export_status = excluded.export_status,
        last_confirmed_at = excluded.last_confirmed_at,
        superseded_by = excluded.superseded_by,
        updated_at = excluded.updated_at
    `, [
      input.id,
      input.scope_id,
      input.profile_type,
      input.subject,
      input.content,
      JSON.stringify(input.source_refs ?? []),
      input.sensitivity,
      input.export_status,
      toNullableIso(input.last_confirmed_at),
      input.superseded_by ?? null,
      timestamp,
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, scope_id, profile_type, subject, content, source_refs, sensitivity,
             export_status, last_confirmed_at, superseded_by, created_at, updated_at
      FROM profile_memory_entries
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Profile memory entry not found after upsert: ${input.id}`);
    return rowToProfileMemoryEntry(row);
  }

  async getProfileMemoryEntry(id: string): Promise<ProfileMemoryEntry | null> {
    const row = this.database.query(`
      SELECT id, scope_id, profile_type, subject, content, source_refs, sensitivity,
             export_status, last_confirmed_at, superseded_by, created_at, updated_at
      FROM profile_memory_entries
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    return row ? rowToProfileMemoryEntry(row) : null;
  }

  async listProfileMemoryEntries(filters?: ProfileMemoryFilters): Promise<ProfileMemoryEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.subject) {
      clauses.push('subject = ?');
      params.push(filters.subject);
    }
    if (filters?.profile_type) {
      clauses.push('profile_type = ?');
      params.push(filters.profile_type);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT id, scope_id, profile_type, subject, content, source_refs, sensitivity,
             export_status, last_confirmed_at, superseded_by, created_at, updated_at
      FROM profile_memory_entries
      ${whereClause}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
      OFFSET ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToProfileMemoryEntry);
  }

  async deleteProfileMemoryEntry(id: string): Promise<void> {
    this.database.run(`DELETE FROM profile_memory_entries WHERE id = ?`, [id]);
  }

  async createPersonalEpisodeEntry(input: PersonalEpisodeEntryInput): Promise<PersonalEpisodeEntry> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO personal_episode_entries (
        id, scope_id, title, start_time, end_time, source_kind, summary,
        source_refs, candidate_ids, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      input.id,
      input.scope_id,
      input.title,
      toNullableIso(input.start_time),
      toNullableIso(input.end_time),
      input.source_kind,
      input.summary,
      JSON.stringify(input.source_refs ?? []),
      JSON.stringify(input.candidate_ids ?? []),
      timestamp,
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, scope_id, title, start_time, end_time, source_kind, summary,
             source_refs, candidate_ids, created_at, updated_at
      FROM personal_episode_entries
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Personal episode entry not found after create: ${input.id}`);
    return rowToPersonalEpisodeEntry(row);
  }

  async getPersonalEpisodeEntry(id: string): Promise<PersonalEpisodeEntry | null> {
    const row = this.database.query(`
      SELECT id, scope_id, title, start_time, end_time, source_kind, summary,
             source_refs, candidate_ids, created_at, updated_at
      FROM personal_episode_entries
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    return row ? rowToPersonalEpisodeEntry(row) : null;
  }

  async listPersonalEpisodeEntries(filters?: PersonalEpisodeFilters): Promise<PersonalEpisodeEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.title) {
      clauses.push('title = ?');
      params.push(filters.title);
    }
    if (filters?.source_kind) {
      clauses.push('source_kind = ?');
      params.push(filters.source_kind);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT id, scope_id, title, start_time, end_time, source_kind, summary,
             source_refs, candidate_ids, created_at, updated_at
      FROM personal_episode_entries
      ${whereClause}
      ORDER BY start_time DESC, id ASC
      LIMIT ?
      OFFSET ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToPersonalEpisodeEntry);
  }

  async deletePersonalEpisodeEntry(id: string): Promise<void> {
    this.database.run(`DELETE FROM personal_episode_entries WHERE id = ?`, [id]);
  }

  async createMemoryCandidateEntry(input: MemoryCandidateEntryInput): Promise<MemoryCandidateEntry> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO memory_candidate_entries (
        id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
        extraction_kind, confidence_score, importance_score, recurrence_score,
        sensitivity, status, target_object_type, target_object_id, reviewed_at,
        review_reason, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
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
      input.status,
      input.target_object_type ?? null,
      input.target_object_id ?? null,
      toNullableIso(input.reviewed_at),
      input.review_reason ?? null,
      timestamp,
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
             extraction_kind, confidence_score, importance_score, recurrence_score,
             sensitivity, status, target_object_type, target_object_id, reviewed_at,
             review_reason, created_at, updated_at
      FROM memory_candidate_entries
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Memory candidate entry not found after create: ${input.id}`);
    return rowToMemoryCandidateEntry(row);
  }

  async getMemoryCandidateEntry(id: string): Promise<MemoryCandidateEntry | null> {
    const row = this.database.query(`
      SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
             extraction_kind, confidence_score, importance_score, recurrence_score,
             sensitivity, status, target_object_type, target_object_id, reviewed_at,
             review_reason, created_at, updated_at
      FROM memory_candidate_entries
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    return row ? rowToMemoryCandidateEntry(row) : null;
  }

  async listMemoryCandidateEntries(filters?: MemoryCandidateFilters): Promise<MemoryCandidateEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.status) {
      clauses.push('status = ?');
      params.push(filters.status);
    }
    if (filters?.candidate_type) {
      clauses.push('candidate_type = ?');
      params.push(filters.candidate_type);
    }
    if (filters?.target_object_type) {
      clauses.push('target_object_type = ?');
      params.push(filters.target_object_type);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
             extraction_kind, confidence_score, importance_score, recurrence_score,
             sensitivity, status, target_object_type, target_object_id, reviewed_at,
             review_reason, created_at, updated_at
      FROM memory_candidate_entries
      ${whereClause}
      ORDER BY updated_at DESC, id ASC
      LIMIT ?
      OFFSET ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToMemoryCandidateEntry);
  }

  async updateMemoryCandidateEntryStatus(id: string, patch: MemoryCandidateStatusPatch): Promise<MemoryCandidateEntry> {
    const timestamp = nowIso();
    this.database.run(`
      UPDATE memory_candidate_entries
      SET status = ?,
          reviewed_at = ?,
          review_reason = ?,
          updated_at = ?
      WHERE id = ?
    `, [
      patch.status,
      toNullableIso(patch.reviewed_at),
      patch.review_reason ?? null,
      timestamp,
      id,
    ]);

    const row = this.database.query(`
      SELECT id, scope_id, candidate_type, proposed_content, source_refs, generated_by,
             extraction_kind, confidence_score, importance_score, recurrence_score,
             sensitivity, status, target_object_type, target_object_id, reviewed_at,
             review_reason, created_at, updated_at
      FROM memory_candidate_entries
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Memory candidate entry not found after status update: ${id}`);
    return rowToMemoryCandidateEntry(row);
  }

  async deleteMemoryCandidateEntry(id: string): Promise<void> {
    this.database.run(`DELETE FROM memory_candidate_entries WHERE id = ?`, [id]);
  }

  async upsertNoteManifestEntry(input: NoteManifestEntryInput): Promise<NoteManifestEntry> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO note_manifest_entries (
        scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
        outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
        extractor_version, last_indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(scope_id, page_id) DO UPDATE SET
        slug = excluded.slug,
        path = excluded.path,
        page_type = excluded.page_type,
        title = excluded.title,
        frontmatter = excluded.frontmatter,
        aliases = excluded.aliases,
        tags = excluded.tags,
        outgoing_wikilinks = excluded.outgoing_wikilinks,
        outgoing_urls = excluded.outgoing_urls,
        source_refs = excluded.source_refs,
        heading_index = excluded.heading_index,
        content_hash = excluded.content_hash,
        extractor_version = excluded.extractor_version,
        last_indexed_at = excluded.last_indexed_at
    `, [
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
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
             outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
             extractor_version, last_indexed_at
      FROM note_manifest_entries
      WHERE scope_id = ? AND page_id = ?
    `).get(input.scope_id, input.page_id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Note manifest entry not found after upsert: ${input.scope_id}:${input.page_id}`);
    return rowToNoteManifestEntry(row);
  }

  async getNoteManifestEntry(scopeId: string, slug: string): Promise<NoteManifestEntry | null> {
    const row = this.database.query(`
      SELECT scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
             outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
             extractor_version, last_indexed_at
      FROM note_manifest_entries
      WHERE scope_id = ? AND slug = ?
    `).get(scopeId, validateSlug(slug)) as Record<string, unknown> | null;
    return row ? rowToNoteManifestEntry(row) : null;
  }

  async listNoteManifestEntries(filters?: NoteManifestFilters): Promise<NoteManifestEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.slug) {
      clauses.push('slug = ?');
      params.push(validateSlug(filters.slug));
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT scope_id, page_id, slug, path, page_type, title, frontmatter, aliases, tags,
             outgoing_wikilinks, outgoing_urls, source_refs, heading_index, content_hash,
             extractor_version, last_indexed_at
      FROM note_manifest_entries
      ${whereClause}
      ORDER BY last_indexed_at DESC, slug ASC
      LIMIT ?
      OFFSET ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToNoteManifestEntry);
  }

  async deleteNoteManifestEntry(scopeId: string, slug: string): Promise<void> {
    this.database.run(
      `DELETE FROM note_manifest_entries WHERE scope_id = ? AND slug = ?`,
      [scopeId, validateSlug(slug)],
    );
  }

  async replaceNoteSectionEntries(
    scopeId: string,
    pageSlug: string,
    entries: NoteSectionEntryInput[],
  ): Promise<NoteSectionEntry[]> {
    const normalizedSlug = validateSlug(pageSlug);
    this.database.run(
      `DELETE FROM note_section_entries WHERE scope_id = ? AND page_slug = ?`,
      [scopeId, normalizedSlug],
    );

    const insert = this.database.query(`
      INSERT INTO note_section_entries (
        scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
        heading_path, heading_text, depth, line_start, line_end, section_text,
        outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const timestamp = nowIso();

    for (const entry of entries) {
      insert.run([
        scopeId,
        entry.page_id,
        validateSlug(entry.page_slug),
        entry.page_path,
        entry.section_id,
        entry.parent_section_id,
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
      ]);
    }

    return this.listNoteSectionEntries({
      scope_id: scopeId,
      page_slug: normalizedSlug,
      limit: Math.max(entries.length, 1),
    });
  }

  async getNoteSectionEntry(scopeId: string, sectionId: string): Promise<NoteSectionEntry | null> {
    const row = this.database.query(`
      SELECT scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
             heading_path, heading_text, depth, line_start, line_end, section_text,
             outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
      FROM note_section_entries
      WHERE scope_id = ? AND section_id = ?
    `).get(scopeId, sectionId) as Record<string, unknown> | null;
    return row ? rowToNoteSectionEntry(row) : null;
  }

  async listNoteSectionEntries(filters?: NoteSectionFilters): Promise<NoteSectionEntry[]> {
    const limit = filters?.limit ?? 100;
    const offset = filters?.offset ?? 0;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.page_slug) {
      clauses.push('page_slug = ?');
      params.push(validateSlug(filters.page_slug));
    }
    if (filters?.section_id) {
      clauses.push('section_id = ?');
      params.push(filters.section_id);
    }

    params.push(limit);
    params.push(offset);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT scope_id, page_id, page_slug, page_path, section_id, parent_section_id, heading_slug,
             heading_path, heading_text, depth, line_start, line_end, section_text,
             outgoing_wikilinks, outgoing_urls, source_refs, content_hash, extractor_version, last_indexed_at
      FROM note_section_entries
      ${whereClause}
      ORDER BY page_slug ASC, line_start ASC, section_id ASC
      LIMIT ?
      OFFSET ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToNoteSectionEntry);
  }

  async deleteNoteSectionEntries(scopeId: string, pageSlug: string): Promise<void> {
    this.database.run(
      `DELETE FROM note_section_entries WHERE scope_id = ? AND page_slug = ?`,
      [scopeId, validateSlug(pageSlug)],
    );
  }

  async upsertContextMapEntry(input: ContextMapEntryInput): Promise<ContextMapEntry> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO context_map_entries (
        id, scope_id, kind, title, build_mode, status, source_set_hash,
        extractor_version, node_count, edge_count, community_count, graph_json,
        generated_at, stale_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        scope_id = excluded.scope_id,
        kind = excluded.kind,
        title = excluded.title,
        build_mode = excluded.build_mode,
        status = excluded.status,
        source_set_hash = excluded.source_set_hash,
        extractor_version = excluded.extractor_version,
        node_count = excluded.node_count,
        edge_count = excluded.edge_count,
        community_count = excluded.community_count,
        graph_json = excluded.graph_json,
        generated_at = excluded.generated_at,
        stale_reason = excluded.stale_reason
    `, [
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
      timestamp,
      input.stale_reason ?? null,
    ]);

    const row = this.database.query(`
      SELECT id, scope_id, kind, title, build_mode, status, source_set_hash,
             extractor_version, node_count, edge_count, community_count, graph_json,
             generated_at, stale_reason
      FROM context_map_entries
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Context map entry not found after upsert: ${input.id}`);
    return rowToContextMapEntry(row);
  }

  async getContextMapEntry(id: string): Promise<ContextMapEntry | null> {
    const row = this.database.query(`
      SELECT id, scope_id, kind, title, build_mode, status, source_set_hash,
             extractor_version, node_count, edge_count, community_count, graph_json,
             generated_at, stale_reason
      FROM context_map_entries
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    return row ? rowToContextMapEntry(row) : null;
  }

  async listContextMapEntries(filters?: ContextMapFilters): Promise<ContextMapEntry[]> {
    const limit = filters?.limit ?? 100;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.kind) {
      clauses.push('kind = ?');
      params.push(filters.kind);
    }

    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT id, scope_id, kind, title, build_mode, status, source_set_hash,
             extractor_version, node_count, edge_count, community_count, graph_json,
             generated_at, stale_reason
      FROM context_map_entries
      ${whereClause}
      ORDER BY generated_at DESC, id ASC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToContextMapEntry);
  }

  async deleteContextMapEntry(id: string): Promise<void> {
    this.database.run(`DELETE FROM context_map_entries WHERE id = ?`, [id]);
  }

  async upsertContextAtlasEntry(input: ContextAtlasEntryInput): Promise<ContextAtlasEntry> {
    const timestamp = nowIso();
    this.database.run(`
      INSERT INTO context_atlas_entries (
        id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        map_id = excluded.map_id,
        scope_id = excluded.scope_id,
        kind = excluded.kind,
        title = excluded.title,
        freshness = excluded.freshness,
        entrypoints = excluded.entrypoints,
        budget_hint = excluded.budget_hint,
        generated_at = excluded.generated_at
    `, [
      input.id,
      input.map_id,
      input.scope_id,
      input.kind,
      input.title,
      input.freshness,
      JSON.stringify(input.entrypoints ?? []),
      input.budget_hint,
      timestamp,
    ]);

    const row = this.database.query(`
      SELECT id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      FROM context_atlas_entries
      WHERE id = ?
    `).get(input.id) as Record<string, unknown> | null;
    if (!row) throw new Error(`Context atlas entry not found after upsert: ${input.id}`);
    return rowToContextAtlasEntry(row);
  }

  async getContextAtlasEntry(id: string): Promise<ContextAtlasEntry | null> {
    const row = this.database.query(`
      SELECT id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      FROM context_atlas_entries
      WHERE id = ?
    `).get(id) as Record<string, unknown> | null;
    return row ? rowToContextAtlasEntry(row) : null;
  }

  async listContextAtlasEntries(filters?: ContextAtlasFilters): Promise<ContextAtlasEntry[]> {
    const limit = filters?.limit ?? 100;
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.scope_id) {
      clauses.push('scope_id = ?');
      params.push(filters.scope_id);
    }
    if (filters?.kind) {
      clauses.push('kind = ?');
      params.push(filters.kind);
    }

    params.push(limit);
    const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const rows = this.database.query(`
      SELECT id, map_id, scope_id, kind, title, freshness, entrypoints, budget_hint, generated_at
      FROM context_atlas_entries
      ${whereClause}
      ORDER BY generated_at DESC, id ASC
      LIMIT ?
    `).all(...params) as Record<string, unknown>[];
    return rows.map(rowToContextAtlasEntry);
  }

  async deleteContextAtlasEntry(id: string): Promise<void> {
    this.database.run(`DELETE FROM context_atlas_entries WHERE id = ?`, [id]);
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
        case 8:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS task_threads (
              id TEXT PRIMARY KEY,
              scope TEXT NOT NULL,
              title TEXT NOT NULL,
              goal TEXT NOT NULL DEFAULT '',
              status TEXT NOT NULL,
              repo_path TEXT,
              branch_name TEXT,
              current_summary TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_task_threads_status_updated
              ON task_threads(status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_task_threads_scope_updated
              ON task_threads(scope, updated_at DESC);

            CREATE TABLE IF NOT EXISTS task_working_sets (
              task_id TEXT PRIMARY KEY REFERENCES task_threads(id) ON DELETE CASCADE,
              active_paths TEXT NOT NULL DEFAULT '[]',
              active_symbols TEXT NOT NULL DEFAULT '[]',
              blockers TEXT NOT NULL DEFAULT '[]',
              open_questions TEXT NOT NULL DEFAULT '[]',
              next_steps TEXT NOT NULL DEFAULT '[]',
              verification_notes TEXT NOT NULL DEFAULT '[]',
              last_verified_at TEXT,
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );

            CREATE TABLE IF NOT EXISTS task_attempts (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
              summary TEXT NOT NULL,
              outcome TEXT NOT NULL,
              applicability_context TEXT NOT NULL DEFAULT '{}',
              evidence TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_task_attempts_task_created
              ON task_attempts(task_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS task_decisions (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES task_threads(id) ON DELETE CASCADE,
              summary TEXT NOT NULL,
              rationale TEXT NOT NULL DEFAULT '',
              consequences TEXT NOT NULL DEFAULT '[]',
              validity_context TEXT NOT NULL DEFAULT '{}',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_task_decisions_task_created
              ON task_decisions(task_id, created_at DESC);

            CREATE TABLE IF NOT EXISTS retrieval_traces (
              id TEXT PRIMARY KEY,
              task_id TEXT REFERENCES task_threads(id) ON DELETE SET NULL,
              scope TEXT NOT NULL,
              route TEXT NOT NULL DEFAULT '[]',
              source_refs TEXT NOT NULL DEFAULT '[]',
              verification TEXT NOT NULL DEFAULT '[]',
              outcome TEXT NOT NULL DEFAULT '',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_retrieval_traces_task_created
              ON retrieval_traces(task_id, created_at DESC);
          `);
          break;
        case 9:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS note_manifest_entries (
              scope_id TEXT NOT NULL,
              page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
              slug TEXT NOT NULL,
              path TEXT NOT NULL,
              page_type TEXT NOT NULL,
              title TEXT NOT NULL,
              frontmatter TEXT NOT NULL DEFAULT '{}',
              aliases TEXT NOT NULL DEFAULT '[]',
              tags TEXT NOT NULL DEFAULT '[]',
              outgoing_wikilinks TEXT NOT NULL DEFAULT '[]',
              outgoing_urls TEXT NOT NULL DEFAULT '[]',
              source_refs TEXT NOT NULL DEFAULT '[]',
              heading_index TEXT NOT NULL DEFAULT '[]',
              content_hash TEXT NOT NULL,
              extractor_version TEXT NOT NULL,
              last_indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              PRIMARY KEY (scope_id, page_id)
            );
            CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_slug
              ON note_manifest_entries(scope_id, slug);
            CREATE INDEX IF NOT EXISTS idx_note_manifest_scope_indexed
              ON note_manifest_entries(scope_id, last_indexed_at DESC);
          `);
          break;
        case 10:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS note_section_entries (
              scope_id TEXT NOT NULL,
              page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
              page_slug TEXT NOT NULL,
              page_path TEXT NOT NULL,
              section_id TEXT NOT NULL,
              parent_section_id TEXT,
              heading_slug TEXT NOT NULL,
              heading_path TEXT NOT NULL DEFAULT '[]',
              heading_text TEXT NOT NULL,
              depth INTEGER NOT NULL,
              line_start INTEGER NOT NULL,
              line_end INTEGER NOT NULL,
              section_text TEXT NOT NULL,
              outgoing_wikilinks TEXT NOT NULL DEFAULT '[]',
              outgoing_urls TEXT NOT NULL DEFAULT '[]',
              source_refs TEXT NOT NULL DEFAULT '[]',
              content_hash TEXT NOT NULL,
              extractor_version TEXT NOT NULL,
              last_indexed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              PRIMARY KEY (scope_id, section_id)
            );
            CREATE INDEX IF NOT EXISTS idx_note_sections_scope_page
              ON note_section_entries(scope_id, page_slug, line_start);
            CREATE INDEX IF NOT EXISTS idx_note_sections_scope_indexed
              ON note_section_entries(scope_id, last_indexed_at DESC);
          `);
          break;
        case 11:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS context_map_entries (
              id TEXT PRIMARY KEY,
              scope_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              build_mode TEXT NOT NULL,
              status TEXT NOT NULL,
              source_set_hash TEXT NOT NULL,
              extractor_version TEXT NOT NULL,
              node_count INTEGER NOT NULL,
              edge_count INTEGER NOT NULL,
              community_count INTEGER NOT NULL DEFAULT 0,
              graph_json TEXT NOT NULL DEFAULT '{}',
              generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              stale_reason TEXT
            );
            CREATE INDEX IF NOT EXISTS idx_context_map_scope_generated
              ON context_map_entries(scope_id, generated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_context_map_scope_kind
              ON context_map_entries(scope_id, kind);
          `);
          break;
        case 12:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS context_atlas_entries (
              id TEXT PRIMARY KEY,
              map_id TEXT NOT NULL REFERENCES context_map_entries(id) ON DELETE CASCADE,
              scope_id TEXT NOT NULL,
              kind TEXT NOT NULL,
              title TEXT NOT NULL,
              freshness TEXT NOT NULL,
              entrypoints TEXT NOT NULL DEFAULT '[]',
              budget_hint INTEGER NOT NULL,
              generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_generated
              ON context_atlas_entries(scope_id, generated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_context_atlas_scope_kind
              ON context_atlas_entries(scope_id, kind);
          `);
          break;
        case 13:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS profile_memory_entries (
              id TEXT PRIMARY KEY,
              scope_id TEXT NOT NULL,
              profile_type TEXT NOT NULL,
              subject TEXT NOT NULL,
              content TEXT NOT NULL,
              source_refs TEXT NOT NULL DEFAULT '[]',
              sensitivity TEXT NOT NULL,
              export_status TEXT NOT NULL,
              last_confirmed_at TEXT,
              superseded_by TEXT,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_profile_memory_scope_subject
              ON profile_memory_entries(scope_id, subject);
            CREATE INDEX IF NOT EXISTS idx_profile_memory_scope_type
              ON profile_memory_entries(scope_id, profile_type, updated_at DESC);
          `);
          break;
        case 14:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS personal_episode_entries (
              id TEXT PRIMARY KEY,
              scope_id TEXT NOT NULL,
              title TEXT NOT NULL,
              start_time TEXT NOT NULL,
              end_time TEXT,
              source_kind TEXT NOT NULL,
              summary TEXT NOT NULL,
              source_refs TEXT NOT NULL DEFAULT '[]',
              candidate_ids TEXT NOT NULL DEFAULT '[]',
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_personal_episode_scope_start
              ON personal_episode_entries(scope_id, start_time DESC);
            CREATE INDEX IF NOT EXISTS idx_personal_episode_scope_title
              ON personal_episode_entries(scope_id, title);
          `);
          break;
        case 15:
          this.database.exec(`
            CREATE TABLE IF NOT EXISTS memory_candidate_entries (
              id TEXT PRIMARY KEY,
              scope_id TEXT NOT NULL,
              candidate_type TEXT NOT NULL CHECK (candidate_type IN ('fact', 'relationship', 'note_update', 'procedure', 'profile_update', 'open_question', 'rationale')),
              proposed_content TEXT NOT NULL,
              source_refs TEXT NOT NULL DEFAULT '[]',
              generated_by TEXT NOT NULL CHECK (generated_by IN ('agent', 'map_analysis', 'dream_cycle', 'manual', 'import')),
              extraction_kind TEXT NOT NULL CHECK (extraction_kind IN ('extracted', 'inferred', 'ambiguous', 'manual')),
              confidence_score REAL NOT NULL,
              importance_score REAL NOT NULL,
              recurrence_score REAL NOT NULL,
              sensitivity TEXT NOT NULL CHECK (sensitivity IN ('public', 'work', 'personal', 'secret', 'unknown')),
              status TEXT NOT NULL CHECK (status IN ('captured', 'candidate', 'staged_for_review')),
              target_object_type TEXT CHECK (target_object_type IS NULL OR target_object_type IN ('curated_note', 'procedure', 'profile_memory', 'personal_episode', 'other')),
              target_object_id TEXT,
              reviewed_at TEXT,
              review_reason TEXT,
              created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
              updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
            );
            CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_status
              ON memory_candidate_entries(scope_id, status, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_candidates_scope_type
              ON memory_candidate_entries(scope_id, candidate_type, updated_at DESC);
            CREATE INDEX IF NOT EXISTS idx_memory_candidates_target
              ON memory_candidate_entries(target_object_type, target_object_id);
          `);
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

  private getLocalVectorPrefilterPageIds(
    embedding: Float32Array,
    limit: number,
    opts?: SearchOpts,
  ): number[] {
    const params: unknown[] = [];
    let sql = `
      SELECT DISTINCT p.id AS page_id, p.slug, p.page_embedding
      FROM pages p
      JOIN content_chunks cc ON cc.page_id = p.id
      WHERE cc.embedding IS NOT NULL AND p.page_embedding IS NOT NULL
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
    if (rows.length === 0) return [];

    const candidates = rows.map((row) => ({
      page_id: Number(row.page_id),
      embedding: blobToFloat32(row.page_embedding),
    }));
    return selectLocalVectorPageIds(embedding, candidates, limit);
  }

  private queryLocalVectorChunkRows(
    opts?: SearchOpts,
    pageIds?: number[],
  ): Record<string, unknown>[] {
    if (pageIds && pageIds.length === 0) return [];

    const params: unknown[] = [];
    let sql = `
      SELECT
        cc.id AS chunk_id,
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

    if (pageIds && pageIds.length > 0) {
      sql += ` AND cc.page_id IN (${pageIds.map(() => '?').join(', ')})`;
      params.push(...pageIds);
    }

    return this.database.query(sql).all(...params) as Record<string, unknown>[];
  }

  private getOmittedLocalVectorChunkIds(
    embedding: Float32Array,
    limit: number,
    opts?: SearchOpts,
    pageIds?: number[],
  ): number[] {
    const params: unknown[] = [];
    let sql = `
      SELECT
        cc.id AS chunk_id,
        cc.embedding
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

    if (pageIds && pageIds.length > 0) {
      sql += ` AND cc.page_id NOT IN (${pageIds.map(() => '?').join(', ')})`;
      params.push(...pageIds);
    }

    const rows = this.database.query(sql).all(...params) as Record<string, unknown>[];
    return selectLocalVectorChunkIds(
      embedding,
      rows.map((row) => ({
        chunk_id: Number(row.chunk_id),
        embedding: blobToFloat32(row.embedding),
      })),
      limit,
    );
  }

  private queryLocalVectorChunkRowsByIds(chunkIds: number[]): Record<string, unknown>[] {
    if (chunkIds.length === 0) return [];

    return this.database.query(`
      SELECT
        cc.id AS chunk_id,
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
      WHERE cc.id IN (${chunkIds.map(() => '?').join(', ')})
    `).all(...chunkIds) as Record<string, unknown>[];
  }

  private refreshPageEmbeddingFromChunks(pageId: number): void {
    const rows = this.database.query(`
      SELECT embedding
      FROM content_chunks
      WHERE page_id = ? AND embedding IS NOT NULL
      ORDER BY chunk_index
    `).all(pageId) as Record<string, unknown>[];
    const centroid = buildPageCentroid(rows.map((row) => blobToFloat32(row.embedding)));
    this.database.run(
      `UPDATE pages SET page_embedding = ? WHERE id = ?`,
      [centroid ? float32ToBlob(centroid) : null, pageId],
    );
  }

  private backfillMissingPageEmbeddingsFromChunks(): void {
    const rows = this.database.query(`
      SELECT DISTINCT p.id AS page_id
      FROM pages p
      JOIN content_chunks cc ON cc.page_id = p.id
      WHERE p.page_embedding IS NULL
        AND cc.embedding IS NOT NULL
    `).all() as Array<{ page_id: number }>;

    for (const row of rows) {
      this.refreshPageEmbeddingFromChunks(Number(row.page_id));
    }
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

function toNullableIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  return value instanceof Date ? value.toISOString() : String(value);
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

function ensurePageEmbeddingColumn(db: Database): void {
  const columns = db.query(`PRAGMA table_info(pages)`).all() as Array<{ name: string }>;
  if (!columns.some((column) => column.name === 'page_embedding')) {
    db.exec(`ALTER TABLE pages ADD COLUMN page_embedding BLOB`);
  }
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

function rowToTaskThread(row: Record<string, unknown>): TaskThread {
  return {
    id: String(row.id),
    scope: row.scope as TaskThread['scope'],
    title: String(row.title),
    goal: String(row.goal ?? ''),
    status: row.status as TaskThread['status'],
    repo_path: row.repo_path == null ? null : String(row.repo_path),
    branch_name: row.branch_name == null ? null : String(row.branch_name),
    current_summary: String(row.current_summary ?? ''),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

function rowToTaskWorkingSet(row: Record<string, unknown>): TaskWorkingSet {
  return {
    task_id: String(row.task_id),
    active_paths: parseJsonArray(row.active_paths),
    active_symbols: parseJsonArray(row.active_symbols),
    blockers: parseJsonArray(row.blockers),
    open_questions: parseJsonArray(row.open_questions),
    next_steps: parseJsonArray(row.next_steps),
    verification_notes: parseJsonArray(row.verification_notes),
    last_verified_at: row.last_verified_at ? new Date(String(row.last_verified_at)) : null,
    updated_at: new Date(String(row.updated_at)),
  };
}

function rowToTaskAttempt(row: Record<string, unknown>): TaskAttempt {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    summary: String(row.summary),
    outcome: row.outcome as TaskAttempt['outcome'],
    applicability_context: parseJsonObject(row.applicability_context),
    evidence: parseJsonArray(row.evidence),
    created_at: new Date(String(row.created_at)),
  };
}

function rowToTaskDecision(row: Record<string, unknown>): TaskDecision {
  return {
    id: String(row.id),
    task_id: String(row.task_id),
    summary: String(row.summary),
    rationale: String(row.rationale ?? ''),
    consequences: parseJsonArray(row.consequences),
    validity_context: parseJsonObject(row.validity_context),
    created_at: new Date(String(row.created_at)),
  };
}

function rowToRetrievalTrace(row: Record<string, unknown>): RetrievalTrace {
  return {
    id: String(row.id),
    task_id: row.task_id == null ? null : String(row.task_id),
    scope: row.scope as RetrievalTrace['scope'],
    route: parseJsonArray(row.route),
    source_refs: parseJsonArray(row.source_refs),
    verification: parseJsonArray(row.verification),
    outcome: String(row.outcome ?? ''),
    created_at: new Date(String(row.created_at)),
  };
}

function rowToNoteManifestEntry(row: Record<string, unknown>): NoteManifestEntry {
  return {
    scope_id: String(row.scope_id),
    page_id: Number(row.page_id),
    slug: String(row.slug),
    path: String(row.path),
    page_type: row.page_type as PageType,
    title: String(row.title),
    frontmatter: parseJsonObject(row.frontmatter),
    aliases: parseJsonArray(row.aliases),
    tags: parseJsonArray(row.tags),
    outgoing_wikilinks: parseJsonArray(row.outgoing_wikilinks),
    outgoing_urls: parseJsonArray(row.outgoing_urls),
    source_refs: parseJsonArray(row.source_refs),
    heading_index: parseNoteManifestHeadingArray(row.heading_index),
    content_hash: String(row.content_hash),
    extractor_version: String(row.extractor_version),
    last_indexed_at: new Date(String(row.last_indexed_at)),
  };
}

function rowToNoteSectionEntry(row: Record<string, unknown>): NoteSectionEntry {
  return {
    scope_id: String(row.scope_id),
    page_id: Number(row.page_id),
    page_slug: String(row.page_slug),
    page_path: String(row.page_path),
    section_id: String(row.section_id),
    parent_section_id: row.parent_section_id == null ? null : String(row.parent_section_id),
    heading_slug: String(row.heading_slug),
    heading_path: parseJsonArray(row.heading_path),
    heading_text: String(row.heading_text),
    depth: Number(row.depth),
    line_start: Number(row.line_start),
    line_end: Number(row.line_end),
    section_text: String(row.section_text),
    outgoing_wikilinks: parseJsonArray(row.outgoing_wikilinks),
    outgoing_urls: parseJsonArray(row.outgoing_urls),
    source_refs: parseJsonArray(row.source_refs),
    content_hash: String(row.content_hash),
    extractor_version: String(row.extractor_version),
    last_indexed_at: new Date(String(row.last_indexed_at)),
  };
}

function rowToContextMapEntry(row: Record<string, unknown>): ContextMapEntry {
  return {
    id: String(row.id),
    scope_id: String(row.scope_id),
    kind: String(row.kind),
    title: String(row.title),
    build_mode: String(row.build_mode),
    status: String(row.status),
    source_set_hash: String(row.source_set_hash),
    extractor_version: String(row.extractor_version),
    node_count: Number(row.node_count),
    edge_count: Number(row.edge_count),
    community_count: Number(row.community_count ?? 0),
    graph_json: parseJsonObject(row.graph_json),
    generated_at: new Date(String(row.generated_at)),
    stale_reason: row.stale_reason == null ? null : String(row.stale_reason),
  };
}

function rowToContextAtlasEntry(row: Record<string, unknown>): ContextAtlasEntry {
  return {
    id: String(row.id),
    map_id: String(row.map_id),
    scope_id: String(row.scope_id),
    kind: String(row.kind),
    title: String(row.title),
    freshness: String(row.freshness),
    entrypoints: parseJsonArray(row.entrypoints),
    budget_hint: Number(row.budget_hint),
    generated_at: new Date(String(row.generated_at)),
  };
}

function rowToProfileMemoryEntry(row: Record<string, unknown>): ProfileMemoryEntry {
  return {
    id: String(row.id),
    scope_id: String(row.scope_id),
    profile_type: row.profile_type as ProfileMemoryEntry['profile_type'],
    subject: String(row.subject),
    content: String(row.content),
    source_refs: parseJsonArray(row.source_refs),
    sensitivity: row.sensitivity as ProfileMemoryEntry['sensitivity'],
    export_status: row.export_status as ProfileMemoryEntry['export_status'],
    last_confirmed_at: row.last_confirmed_at == null ? null : new Date(String(row.last_confirmed_at)),
    superseded_by: row.superseded_by == null ? null : String(row.superseded_by),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

function rowToPersonalEpisodeEntry(row: Record<string, unknown>): PersonalEpisodeEntry {
  return {
    id: String(row.id),
    scope_id: String(row.scope_id),
    title: String(row.title),
    start_time: new Date(String(row.start_time)),
    end_time: row.end_time == null ? null : new Date(String(row.end_time)),
    source_kind: row.source_kind as PersonalEpisodeEntry['source_kind'],
    summary: String(row.summary),
    source_refs: parseJsonArray(row.source_refs),
    candidate_ids: parseJsonArray(row.candidate_ids),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
  };
}

function rowToMemoryCandidateEntry(row: Record<string, unknown>): MemoryCandidateEntry {
  return {
    id: String(row.id),
    scope_id: String(row.scope_id),
    candidate_type: row.candidate_type as MemoryCandidateEntry['candidate_type'],
    proposed_content: String(row.proposed_content),
    source_refs: parseJsonArray(row.source_refs),
    generated_by: row.generated_by as MemoryCandidateEntry['generated_by'],
    extraction_kind: row.extraction_kind as MemoryCandidateEntry['extraction_kind'],
    confidence_score: Number(row.confidence_score),
    importance_score: Number(row.importance_score),
    recurrence_score: Number(row.recurrence_score),
    sensitivity: row.sensitivity as MemoryCandidateEntry['sensitivity'],
    status: row.status as MemoryCandidateEntry['status'],
    target_object_type: row.target_object_type == null ? null : row.target_object_type as MemoryCandidateEntry['target_object_type'],
    target_object_id: row.target_object_id == null ? null : String(row.target_object_id),
    reviewed_at: row.reviewed_at == null ? null : new Date(String(row.reviewed_at)),
    review_reason: row.review_reason == null ? null : String(row.review_reason),
    created_at: new Date(String(row.created_at)),
    updated_at: new Date(String(row.updated_at)),
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

function parseNoteManifestHeadingArray(value: unknown): NoteManifestHeading[] {
  if (Array.isArray(value)) {
    return value.map((heading) => normalizeNoteManifestHeading(heading as Record<string, unknown>));
  }
  if (typeof value === 'string' && value.length > 0) {
    return (JSON.parse(value) as Array<Record<string, unknown>>).map(normalizeNoteManifestHeading);
  }
  return [];
}

function normalizeNoteManifestHeading(heading: Record<string, unknown>): NoteManifestHeading {
  return {
    slug: String(heading.slug ?? ''),
    text: String(heading.text ?? ''),
    depth: Number(heading.depth ?? 0),
    line_start: Number(heading.line_start ?? 0),
  };
}
