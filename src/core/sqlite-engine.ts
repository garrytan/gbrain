// SQLite engine implementation for gbrain's BrainEngine contract.

import { Database } from 'bun:sqlite';
import type { BrainEngine, LinkBatchInput, TimelineBatchInput } from './engine.ts';
import { MAX_SEARCH_LIMIT, clampSearchLimit } from './engine.ts';
import { runMigrations } from './migrate.ts';
import { SQLITE_SCHEMA_SQL } from './schema-sqlite.ts';
import type {
  Page, PageInput, PageFilters, PageType,
  Chunk, ChunkInput,
  SearchResult, SearchOpts,
  Link, GraphNode, GraphPath,
  TimelineEntry, TimelineInput, TimelineOpts,
  RawData,
  PageVersion,
  BrainStats, BrainHealth,
  IngestLogEntry, IngestLogInput,
  EngineConfig,
} from './types.ts';
import { validateSlug, contentHash, rowToPage, rowToChunk, rowToSearchResult } from './utils.ts';

const DEFAULT_SQLITE_PATH = ':memory:';

function nowIso(): string {
  return new Date().toISOString();
}

function maybeParseJSON<T>(value: unknown, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
  return value as T;
}

function embeddingToBlob(embedding: Float32Array): Uint8Array {
  const bytes = new Uint8Array(embedding.byteLength);
  bytes.set(new Uint8Array(embedding.buffer, embedding.byteOffset, embedding.byteLength));
  return bytes;
}

function blobToEmbedding(value: unknown): Float32Array | null {
  if (!value) return null;
  if (value instanceof Float32Array) return value;
  if (value instanceof Uint8Array) {
    if (value.byteLength % 4 !== 0) return null;
    return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength % 4 !== 0) return null;
    return new Float32Array(value.slice(0));
  }
  return null;
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

function sqlInPlaceholders(count: number): string {
  return Array.from({ length: count }, () => '?').join(', ');
}

function normalizeDate(input: string): string {
  return input;
}

/**
 * Convert raw user input into a safe FTS5 MATCH query by stripping operators
 * and quoting each remaining token as a literal term.
 */
function escapeForFts5(query: string): string {
  const withoutOperators = query
    .replace(/["^:()]/g, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/[+\-]/g, ' ');
  // Preserve Unicode letters and digits. FTS5's default tokenizer (unicode61)
  // indexes them, so stripping to ASCII would drop valid queries like "José"
  // or "東京" even when the indexed content matches.
  const tokens = withoutOperators.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map(token => `"${token}"`).join(' ');
}

function rewritePortableSql(sql: string): string {
  return sql
    .replace(/\bnow\(\)/gi, `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`)
    .replace(/\$\d+/g, '?');
}

function detectUnsupportedPostgresFeature(sql: string): string | null {
  // Known callers that still use Postgres-only raw SQL on this path:
  // MinionQueue (jobs) and recursive CTE traversals if they rely on PG-only syntax.
  const checks: Array<{ label: string; re: RegExp }> = [
    { label: '::jsonb', re: /::jsonb\b/i },
    { label: '::int[]', re: /::int\[\]/i },
    { label: '::vector', re: /::vector\b/i },
    { label: 'ANY($...)', re: /\bANY\s*\(\s*(?:\$|\?)/i },
    { label: 'FOR UPDATE SKIP LOCKED', re: /FOR\s+UPDATE\s+SKIP\s+LOCKED/i },
    { label: 'gen_random_uuid()', re: /\bgen_random_uuid\s*\(\s*\)/i },
    { label: 'now()', re: /\bnow\(\)/i },
    { label: '@>', re: /@>/ },
    { label: '<@', re: /<@/ },
    { label: 'ts_rank', re: /\bts_rank\b/i },
    { label: 'to_tsvector', re: /\bto_tsvector\b/i },
    { label: 'websearch_to_tsquery', re: /\bwebsearch_to_tsquery\b/i },
  ];

  for (const check of checks) {
    if (check.re.test(sql)) return check.label;
  }
  return null;
}

export class SqliteEngine implements BrainEngine {
  private _db: Database | null = null;
  private _vecLoaded = false;
  private _txDepth = 0;

  get db(): Database {
    if (!this._db) throw new Error('SQLite not connected. Call connect() first.');
    return this._db;
  }

  private all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
    return this.db.query<T, unknown[]>(sql).all(...params as unknown[]);
  }

  private get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | null {
    return this.db.query<T, unknown[]>(sql).get(...params as unknown[]) ?? null;
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.query(sql).run(...params as unknown[]);
  }

  private hasColumn(table: string, column: string): boolean {
    const rows = this.all<{ name: string }>(`PRAGMA table_info(${table})`);
    return rows.some(r => r.name === column);
  }

  private loadOptionalVecExtension(): void {
    // Candidate resolution order:
    //   1. GBRAIN_SQLITE_VEC_PATH (explicit user override)
    //   2. sqlite-vec npm package getLoadablePath() (the installed dep)
    //   3. bare names for platforms where the extension is on SQLite's search path
    const candidates: string[] = [];
    if (process.env.GBRAIN_SQLITE_VEC_PATH) {
      candidates.push(process.env.GBRAIN_SQLITE_VEC_PATH);
    }
    try {
      // Lazy-require so missing sqlite-vec does not break SQLite users who
      // do not care about vector search.
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const sqliteVec = require('sqlite-vec');
      if (typeof sqliteVec?.getLoadablePath === 'function') {
        const resolved = sqliteVec.getLoadablePath();
        if (resolved) candidates.push(resolved);
      }
    } catch {
      // sqlite-vec not installed; fall through to bare-name candidates.
    }
    candidates.push('sqlite_vec', 'vec0');

    for (const candidate of candidates) {
      try {
        this.db.loadExtension(candidate);
        this._vecLoaded = true;
        return;
      } catch {
        // continue trying candidates
      }
    }
  }

  private ensureVecTable(): void {
    if (!this._vecLoaded) return;
    try {
      this.run(`
        CREATE VIRTUAL TABLE IF NOT EXISTS content_chunks_vec
        USING vec0(
          chunk_id INTEGER PRIMARY KEY,
          embedding FLOAT[1536]
        )
      `);
    } catch {
      // Extension loaded but vec0 table creation failed; keep engine operational.
      this._vecLoaded = false;
    }
  }

  // Lifecycle
  async connect(config: EngineConfig): Promise<void> {
    const path = config.database_path || DEFAULT_SQLITE_PATH;
    this._db = new Database(path, { create: true, strict: true });
    this.run('PRAGMA foreign_keys = ON');
    this.run('PRAGMA journal_mode = WAL');
    this.run('PRAGMA synchronous = NORMAL');

    this.loadOptionalVecExtension();
    this.ensureVecTable();
  }

  async disconnect(): Promise<void> {
    if (this._db) {
      this._db.close();
      this._db = null;
      this._vecLoaded = false;
      this._txDepth = 0;
    }
  }

  async initSchema(): Promise<void> {
    this.db.exec(SQLITE_SCHEMA_SQL);

    // Backfill FTS from pre-existing rows.
    this.run(`INSERT INTO content_chunks_fts(content_chunks_fts) VALUES ('rebuild')`);

    const { applied } = await runMigrations(this);
    if (applied > 0) {
      console.log(`  ${applied} migration(s) applied`);
    }
  }

  async transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T> {
    if (this._txDepth > 0) {
      const savepoint = `sp_${this._txDepth}`;
      this.run(`SAVEPOINT ${savepoint}`);
      this._txDepth++;
      try {
        const result = await fn(this);
        this._txDepth--;
        this.run(`RELEASE SAVEPOINT ${savepoint}`);
        return result;
      } catch (error) {
        this._txDepth--;
        this.run(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        this.run(`RELEASE SAVEPOINT ${savepoint}`);
        throw error;
      }
    }

    this.run('BEGIN IMMEDIATE');
    this._txDepth = 1;
    try {
      const result = await fn(this);
      this._txDepth = 0;
      this.run('COMMIT');
      return result;
    } catch (error) {
      this._txDepth = 0;
      this.run('ROLLBACK');
      throw error;
    }
  }

  // Pages CRUD
  async getPage(slug: string): Promise<Page | null> {
    const row = this.get<Record<string, unknown>>(
      `SELECT id, slug, type, title, compiled_truth, timeline, frontmatter, content_hash, created_at, updated_at
       FROM pages WHERE slug = ?`,
      [slug],
    );
    if (!row) return null;
    return rowToPage(row);
  }

  async putPage(slug: string, page: PageInput): Promise<Page> {
    const normalizedSlug = validateSlug(slug);
    const hash = page.content_hash || contentHash(page);
    const frontmatter = JSON.stringify(page.frontmatter || {});

    this.run(
      `INSERT INTO pages (slug, type, title, compiled_truth, timeline, frontmatter, content_hash, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(slug) DO UPDATE SET
         type = excluded.type,
         title = excluded.title,
         compiled_truth = excluded.compiled_truth,
         timeline = excluded.timeline,
         frontmatter = excluded.frontmatter,
         content_hash = excluded.content_hash,
         updated_at = excluded.updated_at`,
      [
        normalizedSlug,
        page.type,
        page.title,
        page.compiled_truth,
        page.timeline || '',
        frontmatter,
        hash,
        nowIso(),
      ],
    );

    const out = await this.getPage(normalizedSlug);
    if (!out) throw new Error(`Failed to upsert page: ${normalizedSlug}`);
    return out;
  }

  async deletePage(slug: string): Promise<void> {
    this.run(`DELETE FROM pages WHERE slug = ?`, [slug]);
  }

  async listPages(filters?: PageFilters): Promise<Page[]> {
    const limit = filters?.limit || 100;
    const offset = filters?.offset || 0;

    const where: string[] = [];
    const params: unknown[] = [];
    let join = '';

    if (filters?.type) {
      where.push('p.type = ?');
      params.push(filters.type);
    }
    if (filters?.tag) {
      join = 'JOIN tags t ON t.page_id = p.id';
      where.push('t.tag = ?');
      params.push(filters.tag);
    }
    if (filters?.updated_after) {
      where.push('p.updated_at > ?');
      params.push(filters.updated_after);
    }

    const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
    const sql = `
      SELECT p.*
      FROM pages p
      ${join}
      ${whereSql}
      ORDER BY p.updated_at DESC
      LIMIT ? OFFSET ?
    `;
    params.push(limit, offset);

    const rows = this.all<Record<string, unknown>>(sql, params);
    return rows.map(rowToPage);
  }

  async resolveSlugs(partial: string): Promise<string[]> {
    const exact = this.get<{ slug: string }>('SELECT slug FROM pages WHERE slug = ?', [partial]);
    if (exact) return [exact.slug];

    const pattern = `%${partial.toLowerCase()}%`;
    const rows = this.all<{ slug: string }>(
      `SELECT slug
       FROM pages
       WHERE lower(title) LIKE ? OR lower(slug) LIKE ?
       ORDER BY
         CASE WHEN lower(title) = lower(?) THEN 0 ELSE 1 END,
         updated_at DESC
       LIMIT 5`,
      [pattern, pattern, partial],
    );
    return rows.map(r => r.slug);
  }

  async getAllSlugs(): Promise<Set<string>> {
    const rows = this.all<{ slug: string }>('SELECT slug FROM pages');
    return new Set(rows.map(r => r.slug));
  }

  // Search
  async searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]> {
    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailFilter = opts?.detail === 'low' ? `AND cc.chunk_source = 'compiled_truth'` : '';
    const ftsQuery = escapeForFts5(query);

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }
    if (!ftsQuery) return [];

    const rows = this.all<Record<string, unknown>>(
      `SELECT
         p.slug,
         p.id AS page_id,
         p.title,
         p.type,
         cc.id AS chunk_id,
         cc.chunk_index,
         cc.chunk_text,
         cc.chunk_source,
         (1.0 / (1.0 + abs(bm25(content_chunks_fts)))) AS score,
         CASE WHEN p.updated_at < (
           SELECT ifnull(max(te.created_at), p.updated_at)
           FROM timeline_entries te
           WHERE te.page_id = p.id
         ) THEN 1 ELSE 0 END AS stale
       FROM content_chunks_fts
       JOIN content_chunks cc ON cc.id = content_chunks_fts.rowid
       JOIN pages p ON p.id = cc.page_id
       WHERE content_chunks_fts MATCH ? ${detailFilter}
       ORDER BY bm25(content_chunks_fts)
       LIMIT ? OFFSET ?`,
      [ftsQuery, limit, offset],
    );

    return rows.map(rowToSearchResult);
  }

  async searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]> {
    if (!this._vecLoaded) {
      throw new Error(
        "SQLite vector search is unavailable. Bun's bundled sqlite3 does not " +
        "support dynamic extension loading (sqlite-vec), so vector search " +
        "works only on PGLite or Postgres today. Keyword search (FTS5) is " +
        "fully supported on SQLite. Use `gbrain migrate --to pglite` or " +
        "`--to postgres` for semantic search, or rebuild gbrain against " +
        "better-sqlite3 if you need vector search on SQLite."
      );
    }

    const limit = clampSearchLimit(opts?.limit);
    const offset = opts?.offset || 0;
    const detailLow = opts?.detail === 'low';

    if (opts?.limit && opts.limit > MAX_SEARCH_LIMIT) {
      console.warn(`[gbrain] Warning: search limit clamped from ${opts.limit} to ${MAX_SEARCH_LIMIT}`);
    }

    const rows = this.all<Record<string, unknown>>(
      `SELECT
         p.slug,
         p.id AS page_id,
         p.title,
         p.type,
         cc.id AS chunk_id,
         cc.chunk_index,
         cc.chunk_text,
         cc.chunk_source,
         cc.embedding,
         CASE WHEN p.updated_at < (
           SELECT ifnull(max(te.created_at), p.updated_at)
           FROM timeline_entries te
           WHERE te.page_id = p.id
         ) THEN 1 ELSE 0 END AS stale
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE cc.embedding IS NOT NULL
       ${detailLow ? `AND cc.chunk_source = 'compiled_truth'` : ''}`,
      [],
    );

    const scored = rows
      .map((row) => {
        const emb = blobToEmbedding(row.embedding);
        if (!emb) return null;
        const score = cosineSimilarity(embedding, emb);
        return {
          ...row,
          score,
        };
      })
      .filter((r): r is Record<string, unknown> => !!r)
      .sort((a, b) => Number(b.score) - Number(a.score))
      .slice(offset, offset + limit);

    return scored.map(rowToSearchResult);
  }

  async getEmbeddingsByChunkIds(ids: number[]): Promise<Map<number, Float32Array>> {
    const out = new Map<number, Float32Array>();
    if (ids.length === 0) return out;

    const placeholders = sqlInPlaceholders(ids.length);
    const rows = this.all<{ id: number; embedding: Uint8Array | null }>(
      `SELECT id, embedding FROM content_chunks WHERE id IN (${placeholders}) AND embedding IS NOT NULL`,
      ids,
    );

    for (const row of rows) {
      const emb = blobToEmbedding(row.embedding);
      if (emb) out.set(Number(row.id), emb);
    }

    return out;
  }

  // Chunks
  async upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void> {
    const page = this.get<{ id: number }>('SELECT id FROM pages WHERE slug = ?', [slug]);
    if (!page) throw new Error(`Page not found: ${slug}`);

    if (chunks.length === 0) {
      this.run('DELETE FROM content_chunks WHERE page_id = ?', [page.id]);
      return;
    }

    const indices = chunks.map(c => c.chunk_index);
    const placeholders = sqlInPlaceholders(indices.length);
    this.run(
      `DELETE FROM content_chunks
       WHERE page_id = ?
         AND chunk_index NOT IN (${placeholders})`,
      [page.id, ...indices],
    );

    for (const chunk of chunks) {
      const embeddingBlob = chunk.embedding ? embeddingToBlob(chunk.embedding) : null;
      const embeddedAt = chunk.embedding ? nowIso() : null;
      this.run(
        `INSERT INTO content_chunks
           (page_id, chunk_index, chunk_text, chunk_source, embedding, model, token_count, embedded_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(page_id, chunk_index) DO UPDATE SET
           chunk_text = excluded.chunk_text,
           chunk_source = excluded.chunk_source,
           embedding = CASE
             WHEN excluded.chunk_text != content_chunks.chunk_text THEN excluded.embedding
             ELSE COALESCE(excluded.embedding, content_chunks.embedding)
           END,
           model = COALESCE(excluded.model, content_chunks.model),
           token_count = excluded.token_count,
           embedded_at = COALESCE(excluded.embedded_at, content_chunks.embedded_at)`,
        [
          page.id,
          chunk.chunk_index,
          chunk.chunk_text,
          chunk.chunk_source,
          embeddingBlob,
          chunk.model || 'text-embedding-3-large',
          chunk.token_count ?? null,
          embeddedAt,
        ],
      );

      if (this._vecLoaded && embeddingBlob) {
        try {
          this.run(
            `INSERT INTO content_chunks_vec (chunk_id, embedding)
             VALUES (?, ?)
             ON CONFLICT(chunk_id) DO UPDATE SET embedding = excluded.embedding`,
            [
              this.get<{ id: number }>(
                `SELECT id FROM content_chunks WHERE page_id = ? AND chunk_index = ?`,
                [page.id, chunk.chunk_index],
              )?.id,
              embeddingBlob,
            ],
          );
        } catch {
          // Optional vec sidecar table; keep core writes successful.
        }
      }
    }
  }

  async getChunks(slug: string): Promise<Chunk[]> {
    const rows = this.all<Record<string, unknown>>(
      `SELECT cc.*
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = ?
       ORDER BY cc.chunk_index`,
      [slug],
    );
    return rows.map((r) => rowToChunk(r));
  }

  async deleteChunks(slug: string): Promise<void> {
    this.run(
      `DELETE FROM content_chunks
       WHERE page_id = (SELECT id FROM pages WHERE slug = ?)`,
      [slug],
    );
  }

  // Links
  async addLink(
    from: string,
    to: string,
    context?: string,
    linkType?: string,
    linkSource?: string,
    originSlug?: string,
    originField?: string,
  ): Promise<void> {
    const src = linkSource ?? 'markdown';
    this.run(
      `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
       SELECT f.id, t.id, ?, ?, ?, o.id, ?
       FROM pages f
       JOIN pages t ON t.slug = ?
       LEFT JOIN pages o ON o.slug = ?
       WHERE f.slug = ?
       ON CONFLICT(from_page_id, to_page_id, link_type, ifnull(link_source, ''), ifnull(origin_page_id, -1))
       DO UPDATE SET
         context = excluded.context,
         origin_field = excluded.origin_field`,
      [
        linkType || '',
        context || '',
        src,
        originField ?? null,
        to,
        originSlug ?? null,
        from,
      ],
    );
  }

  async addLinksBatch(links: LinkBatchInput[]): Promise<number> {
    if (links.length === 0) return 0;

    let inserted = 0;
    for (const link of links) {
      this.run(
        `INSERT INTO links (from_page_id, to_page_id, link_type, context, link_source, origin_page_id, origin_field)
         SELECT f.id, t.id, ?, ?, ?, o.id, ?
         FROM pages f
         JOIN pages t ON t.slug = ?
         LEFT JOIN pages o ON o.slug = ?
         WHERE f.slug = ?
         ON CONFLICT(from_page_id, to_page_id, link_type, ifnull(link_source, ''), ifnull(origin_page_id, -1)) DO NOTHING`,
        [
          link.link_type || '',
          link.context || '',
          link.link_source || 'markdown',
          link.origin_field || null,
          link.to_slug,
          link.origin_slug || null,
          link.from_slug,
        ],
      );
      inserted += this.get<{ n: number }>('SELECT changes() AS n')?.n ?? 0;
    }

    return inserted;
  }

  async removeLink(from: string, to: string, linkType?: string, linkSource?: string): Promise<void> {
    let sql = `
      DELETE FROM links
      WHERE from_page_id = (SELECT id FROM pages WHERE slug = ?)
        AND to_page_id = (SELECT id FROM pages WHERE slug = ?)
    `;
    const params: unknown[] = [from, to];

    if (linkType !== undefined) {
      sql += ' AND link_type = ?';
      params.push(linkType);
    }
    if (linkSource !== undefined) {
      sql += ' AND ((link_source = ?) OR (link_source IS NULL AND ? IS NULL))';
      params.push(linkSource, linkSource);
    }

    this.run(sql, params);
  }

  async getLinks(slug: string): Promise<Link[]> {
    const rows = this.all<Link>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug,
              l.link_type, l.context, l.link_source,
              o.slug AS origin_slug, l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE f.slug = ?`,
      [slug],
    );
    return rows;
  }

  async getBacklinks(slug: string): Promise<Link[]> {
    const rows = this.all<Link>(
      `SELECT f.slug AS from_slug, t.slug AS to_slug,
              l.link_type, l.context, l.link_source,
              o.slug AS origin_slug, l.origin_field
       FROM links l
       JOIN pages f ON f.id = l.from_page_id
       JOIN pages t ON t.id = l.to_page_id
       LEFT JOIN pages o ON o.id = l.origin_page_id
       WHERE t.slug = ?`,
      [slug],
    );
    return rows;
  }

  async findByTitleFuzzy(
    name: string,
    dirPrefix?: string,
    minSimilarity: number = 0.55,
  ): Promise<{ slug: string; similarity: number } | null> {
    const pattern = `%${name.toLowerCase()}%`;
    const prefixPattern = dirPrefix ? `${dirPrefix.toLowerCase()}/%` : '%';
    const row = this.get<{ slug: string; title: string }>(
      `SELECT slug, title
       FROM pages
       WHERE lower(slug) LIKE ?
         AND (lower(title) LIKE ? OR lower(slug) LIKE ?)
       ORDER BY updated_at DESC
       LIMIT 1`,
      [prefixPattern, pattern, pattern],
    );
    if (!row) return null;

    const lhs = row.title.toLowerCase();
    const rhs = name.toLowerCase();
    const overlap = rhs.split(/\s+/).filter(Boolean).filter(part => lhs.includes(part)).length;
    const similarity = rhs.length > 0 ? overlap / rhs.split(/\s+/).filter(Boolean).length : 0;
    if (similarity < minSimilarity) return null;

    return { slug: row.slug, similarity };
  }

  async traverseGraph(slug: string, depth: number = 5): Promise<GraphNode[]> {
    const rows = this.all<Record<string, unknown>>(
      `WITH RECURSIVE graph AS (
         SELECT p.id, p.slug, p.title, p.type, 0 AS depth, ',' || p.id || ',' AS visited
         FROM pages p
         WHERE p.slug = ?
         UNION ALL
         SELECT p2.id, p2.slug, p2.title, p2.type, g.depth + 1,
                g.visited || p2.id || ','
         FROM graph g
         JOIN links l ON l.from_page_id = g.id
         JOIN pages p2 ON p2.id = l.to_page_id
         WHERE g.depth < ?
           AND instr(g.visited, ',' || p2.id || ',') = 0
       )
       SELECT g.slug, g.title, g.type, g.depth,
         ifnull(
           (
             SELECT json_group_array(json_object('to_slug', p3.slug, 'link_type', l2.link_type))
             FROM links l2
             JOIN pages p3 ON p3.id = l2.to_page_id
             WHERE l2.from_page_id = g.id
           ),
           '[]'
         ) AS links
       FROM graph g
       ORDER BY g.depth, g.slug`,
      [slug, depth],
    );

    return rows.map((r) => ({
      slug: r.slug as string,
      title: r.title as string,
      type: r.type as PageType,
      depth: Number(r.depth),
      links: maybeParseJSON<{ to_slug: string; link_type: string }[]>(r.links, []),
    }));
  }

  async traversePaths(
    slug: string,
    opts?: { depth?: number; linkType?: string; direction?: 'in' | 'out' | 'both' },
  ): Promise<GraphPath[]> {
    const depth = opts?.depth ?? 5;
    const direction = opts?.direction ?? 'out';
    const linkType = opts?.linkType;

    const rows: Record<string, unknown>[] = [];
    if (direction === 'out' || direction === 'both') {
      const params: unknown[] = [slug, depth];
      let whereType = '';
      if (linkType) {
        whereType = 'AND l.link_type = ?';
        params.push(linkType);
      }
      rows.push(...this.all<Record<string, unknown>>(
        `WITH RECURSIVE walk AS (
           SELECT p.id, p.slug, 0 AS depth, ',' || p.id || ',' AS visited
           FROM pages p WHERE p.slug = ?
           UNION ALL
           SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id || ','
           FROM walk w
           JOIN links l ON l.from_page_id = w.id
           JOIN pages p2 ON p2.id = l.to_page_id
           WHERE w.depth < ?
             ${whereType}
             AND instr(w.visited, ',' || p2.id || ',') = 0
         )
         SELECT w.slug AS from_slug, p2.slug AS to_slug,
                l.link_type, l.context, w.depth + 1 AS depth
         FROM walk w
         JOIN links l ON l.from_page_id = w.id
         JOIN pages p2 ON p2.id = l.to_page_id
         WHERE w.depth < ?
           ${whereType}`,
        linkType ? [slug, depth, linkType, depth, linkType] : [slug, depth, depth],
      ));
    }

    if (direction === 'in' || direction === 'both') {
      rows.push(...this.all<Record<string, unknown>>(
        `WITH RECURSIVE walk AS (
           SELECT p.id, p.slug, 0 AS depth, ',' || p.id || ',' AS visited
           FROM pages p WHERE p.slug = ?
           UNION ALL
           SELECT p2.id, p2.slug, w.depth + 1, w.visited || p2.id || ','
           FROM walk w
           JOIN links l ON l.to_page_id = w.id
           JOIN pages p2 ON p2.id = l.from_page_id
           WHERE w.depth < ?
             ${linkType ? 'AND l.link_type = ?' : ''}
             AND instr(w.visited, ',' || p2.id || ',') = 0
         )
         SELECT p2.slug AS from_slug, w.slug AS to_slug,
                l.link_type, l.context, w.depth + 1 AS depth
         FROM walk w
         JOIN links l ON l.to_page_id = w.id
         JOIN pages p2 ON p2.id = l.from_page_id
         WHERE w.depth < ?
           ${linkType ? 'AND l.link_type = ?' : ''}`,
        linkType ? [slug, depth, linkType, depth, linkType] : [slug, depth, depth],
      ));
    }

    const seen = new Set<string>();
    const deduped: GraphPath[] = [];
    for (const row of rows) {
      const key = `${row.from_slug}|${row.to_slug}|${row.link_type}|${row.depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push({
        from_slug: row.from_slug as string,
        to_slug: row.to_slug as string,
        link_type: row.link_type as string,
        context: (row.context as string) || '',
        depth: Number(row.depth),
      });
    }

    deduped.sort((a, b) => a.depth - b.depth || a.from_slug.localeCompare(b.from_slug) || a.to_slug.localeCompare(b.to_slug));
    return deduped;
  }

  async getBacklinkCounts(slugs: string[]): Promise<Map<string, number>> {
    const out = new Map<string, number>();
    for (const slug of slugs) out.set(slug, 0);
    if (slugs.length === 0) return out;

    const placeholders = sqlInPlaceholders(slugs.length);
    const rows = this.all<{ slug: string; cnt: number }>(
      `SELECT p.slug AS slug, count(l.id) AS cnt
       FROM pages p
       LEFT JOIN links l ON l.to_page_id = p.id
       WHERE p.slug IN (${placeholders})
       GROUP BY p.slug`,
      slugs,
    );

    for (const row of rows) {
      out.set(row.slug, Number(row.cnt));
    }

    return out;
  }

  // Tags
  async addTag(slug: string, tag: string): Promise<void> {
    this.run(
      `INSERT INTO tags (page_id, tag)
       SELECT id, ? FROM pages WHERE slug = ?
       ON CONFLICT(page_id, tag) DO NOTHING`,
      [tag, slug],
    );
  }

  async removeTag(slug: string, tag: string): Promise<void> {
    this.run(
      `DELETE FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = ?)
         AND tag = ?`,
      [slug, tag],
    );
  }

  async getTags(slug: string): Promise<string[]> {
    const rows = this.all<{ tag: string }>(
      `SELECT tag FROM tags
       WHERE page_id = (SELECT id FROM pages WHERE slug = ?)
       ORDER BY tag`,
      [slug],
    );
    return rows.map(r => r.tag);
  }

  // Timeline
  async addTimelineEntry(
    slug: string,
    entry: TimelineInput,
    opts?: { skipExistenceCheck?: boolean },
  ): Promise<void> {
    if (!opts?.skipExistenceCheck) {
      const exists = this.get<{ ok: number }>('SELECT 1 AS ok FROM pages WHERE slug = ?', [slug]);
      if (!exists) throw new Error(`Page not found: ${slug}`);
    }

    this.run(
      `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
       SELECT id, ?, ?, ?, ?
       FROM pages WHERE slug = ?
       ON CONFLICT(page_id, date, summary) DO NOTHING`,
      [normalizeDate(entry.date), entry.source || '', entry.summary, entry.detail || '', slug],
    );
  }

  async addTimelineEntriesBatch(entries: TimelineBatchInput[]): Promise<number> {
    if (entries.length === 0) return 0;

    let inserted = 0;
    for (const entry of entries) {
      this.run(
        `INSERT INTO timeline_entries (page_id, date, source, summary, detail)
         SELECT id, ?, ?, ?, ?
         FROM pages WHERE slug = ?
         ON CONFLICT(page_id, date, summary) DO NOTHING`,
        [
          normalizeDate(entry.date),
          entry.source || '',
          entry.summary,
          entry.detail || '',
          entry.slug,
        ],
      );
      inserted += this.get<{ n: number }>('SELECT changes() AS n')?.n ?? 0;
    }

    return inserted;
  }

  async getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]> {
    const limit = opts?.limit || 100;
    const where: string[] = ['p.slug = ?'];
    const params: unknown[] = [slug];

    if (opts?.after) {
      where.push('te.date >= ?');
      params.push(normalizeDate(opts.after));
    }
    if (opts?.before) {
      where.push('te.date <= ?');
      params.push(normalizeDate(opts.before));
    }

    const rows = this.all<TimelineEntry>(
      `SELECT te.*
       FROM timeline_entries te
       JOIN pages p ON p.id = te.page_id
       WHERE ${where.join(' AND ')}
       ORDER BY te.date DESC
       LIMIT ?`,
      [...params, limit],
    );

    return rows;
  }

  // Raw data
  async putRawData(slug: string, source: string, data: object): Promise<void> {
    this.run(
      `INSERT INTO raw_data (page_id, source, data, fetched_at)
       SELECT id, ?, ?, ?
       FROM pages WHERE slug = ?
       ON CONFLICT(page_id, source) DO UPDATE SET
         data = excluded.data,
         fetched_at = excluded.fetched_at`,
      [source, JSON.stringify(data), nowIso(), slug],
    );
  }

  async getRawData(slug: string, source?: string): Promise<RawData[]> {
    const where = source ? 'WHERE p.slug = ? AND rd.source = ?' : 'WHERE p.slug = ?';
    const params = source ? [slug, source] : [slug];
    const rows = this.all<Record<string, unknown>>(
      `SELECT rd.source, rd.data, rd.fetched_at
       FROM raw_data rd
       JOIN pages p ON p.id = rd.page_id
       ${where}`,
      params,
    );

    return rows.map((row) => ({
      source: row.source as string,
      data: maybeParseJSON<Record<string, unknown>>(row.data, {}),
      fetched_at: new Date(row.fetched_at as string),
    }));
  }

  // Versions
  async createVersion(slug: string): Promise<PageVersion> {
    this.run(
      `INSERT INTO page_versions (page_id, compiled_truth, frontmatter)
       SELECT id, compiled_truth, frontmatter
       FROM pages WHERE slug = ?`,
      [slug],
    );

    const row = this.get<PageVersion>(
      `SELECT pv.*
       FROM page_versions pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = ?
       ORDER BY pv.id DESC
       LIMIT 1`,
      [slug],
    );

    if (!row) throw new Error(`Failed to create version for page: ${slug}`);
    return row;
  }

  async getVersions(slug: string): Promise<PageVersion[]> {
    return this.all<PageVersion>(
      `SELECT pv.*
       FROM page_versions pv
       JOIN pages p ON p.id = pv.page_id
       WHERE p.slug = ?
       ORDER BY pv.snapshot_at DESC`,
      [slug],
    );
  }

  async revertToVersion(slug: string, versionId: number): Promise<void> {
    this.run(
      `UPDATE pages
       SET compiled_truth = (
             SELECT pv.compiled_truth
             FROM page_versions pv
             WHERE pv.id = ? AND pv.page_id = pages.id
           ),
           frontmatter = (
             SELECT pv.frontmatter
             FROM page_versions pv
             WHERE pv.id = ? AND pv.page_id = pages.id
           ),
           updated_at = ?
       WHERE slug = ?`,
      [versionId, versionId, nowIso(), slug],
    );
  }

  // Stats + health
  async getStats(): Promise<BrainStats> {
    const stats = this.get<Record<string, unknown>>(
      `SELECT
         (SELECT count(*) FROM pages) AS page_count,
         (SELECT count(*) FROM content_chunks) AS chunk_count,
         (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) AS embedded_count,
         (SELECT count(*) FROM links) AS link_count,
         (SELECT count(DISTINCT tag) FROM tags) AS tag_count,
         (SELECT count(*) FROM timeline_entries) AS timeline_entry_count`,
    ) || {};

    const types = this.all<{ type: string; count: number }>(
      `SELECT type, count(*) AS count FROM pages GROUP BY type ORDER BY count DESC`,
    );

    const pages_by_type: Record<string, number> = {};
    for (const t of types) {
      pages_by_type[t.type] = Number(t.count);
    }

    return {
      page_count: Number(stats.page_count || 0),
      chunk_count: Number(stats.chunk_count || 0),
      embedded_count: Number(stats.embedded_count || 0),
      link_count: Number(stats.link_count || 0),
      tag_count: Number(stats.tag_count || 0),
      timeline_entry_count: Number(stats.timeline_entry_count || 0),
      pages_by_type,
    };
  }

  async getHealth(): Promise<BrainHealth> {
    const h = this.get<Record<string, unknown>>(
      `WITH entity_pages AS (
         SELECT id, slug FROM pages WHERE type IN ('person', 'company')
       )
       SELECT
         (SELECT count(*) FROM pages) AS page_count,
         (SELECT count(*) FROM content_chunks WHERE embedded_at IS NOT NULL) * 1.0 /
           CASE WHEN (SELECT count(*) FROM content_chunks) = 0 THEN 1 ELSE (SELECT count(*) FROM content_chunks) END AS embed_coverage,
         (SELECT count(*) FROM pages p
          WHERE p.updated_at < (
            SELECT ifnull(max(te.created_at), p.updated_at)
            FROM timeline_entries te
            WHERE te.page_id = p.id
          )) AS stale_pages,
         (SELECT count(*) FROM pages p
          WHERE NOT EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = p.id)
            AND NOT EXISTS (SELECT 1 FROM links l WHERE l.from_page_id = p.id)) AS orphan_pages,
         (SELECT count(*) FROM links l
          WHERE NOT EXISTS (SELECT 1 FROM pages p WHERE p.id = l.to_page_id)) AS dead_links,
         (SELECT count(*) FROM content_chunks WHERE embedded_at IS NULL) AS missing_embeddings,
         (SELECT count(*) FROM links) AS link_count,
         (SELECT count(DISTINCT page_id) FROM timeline_entries) AS pages_with_timeline,
         (SELECT count(*) FROM entity_pages e
          WHERE EXISTS (SELECT 1 FROM links l WHERE l.to_page_id = e.id)) * 1.0 /
           CASE WHEN (SELECT count(*) FROM entity_pages) = 0 THEN 1 ELSE (SELECT count(*) FROM entity_pages) END AS link_coverage,
         (SELECT count(*) FROM entity_pages e
          WHERE EXISTS (SELECT 1 FROM timeline_entries te WHERE te.page_id = e.id)) * 1.0 /
           CASE WHEN (SELECT count(*) FROM entity_pages) = 0 THEN 1 ELSE (SELECT count(*) FROM entity_pages) END AS timeline_coverage`,
    ) || {};

    const connected = this.all<{ slug: string; link_count: number }>(
      `SELECT p.slug,
              (SELECT count(*) FROM links l WHERE l.from_page_id = p.id OR l.to_page_id = p.id) AS link_count
       FROM pages p
       WHERE p.type IN ('person', 'company')
       ORDER BY link_count DESC
       LIMIT 5`,
    );

    const pageCount = Number(h.page_count || 0);
    const embedCoverage = Number(h.embed_coverage || 0);
    const orphanPages = Number(h.orphan_pages || 0);
    const deadLinks = Number(h.dead_links || 0);
    const linkCount = Number(h.link_count || 0);
    const pagesWithTimeline = Number(h.pages_with_timeline || 0);

    const linkDensity = pageCount > 0 ? Math.min(linkCount / pageCount, 1) : 0;
    const timelineCoverageDensity = pageCount > 0 ? Math.min(pagesWithTimeline / pageCount, 1) : 0;
    const noOrphans = pageCount > 0 ? 1 - (orphanPages / pageCount) : 1;
    const noDeadLinks = pageCount > 0 ? 1 - Math.min(deadLinks / pageCount, 1) : 1;

    const embedCoverageScore = pageCount === 0 ? 0 : Math.round(embedCoverage * 35);
    const linkDensityScore = pageCount === 0 ? 0 : Math.round(linkDensity * 25);
    const timelineCoverageScore = pageCount === 0 ? 0 : Math.round(timelineCoverageDensity * 15);
    const noOrphansScore = pageCount === 0 ? 0 : Math.round(noOrphans * 15);
    const noDeadLinksScore = pageCount === 0 ? 0 : Math.round(noDeadLinks * 10);

    return {
      page_count: pageCount,
      embed_coverage: embedCoverage,
      stale_pages: Number(h.stale_pages || 0),
      orphan_pages: orphanPages,
      missing_embeddings: Number(h.missing_embeddings || 0),
      brain_score: embedCoverageScore + linkDensityScore + timelineCoverageScore + noOrphansScore + noDeadLinksScore,
      dead_links: deadLinks,
      link_coverage: Number(h.link_coverage || 0),
      timeline_coverage: Number(h.timeline_coverage || 0),
      most_connected: connected.map(c => ({ slug: c.slug, link_count: Number(c.link_count) })),
      embed_coverage_score: embedCoverageScore,
      link_density_score: linkDensityScore,
      timeline_coverage_score: timelineCoverageScore,
      no_orphans_score: noOrphansScore,
      no_dead_links_score: noDeadLinksScore,
    };
  }

  // Ingest log
  async logIngest(entry: IngestLogInput): Promise<void> {
    this.run(
      `INSERT INTO ingest_log (source_type, source_ref, pages_updated, summary)
       VALUES (?, ?, ?, ?)`,
      [entry.source_type, entry.source_ref, JSON.stringify(entry.pages_updated), entry.summary],
    );
  }

  async getIngestLog(opts?: { limit?: number }): Promise<IngestLogEntry[]> {
    const limit = opts?.limit || 50;
    const rows = this.all<Record<string, unknown>>(
      `SELECT * FROM ingest_log ORDER BY created_at DESC LIMIT ?`,
      [limit],
    );

    return rows.map((row) => ({
      id: Number(row.id),
      source_type: row.source_type as string,
      source_ref: row.source_ref as string,
      pages_updated: maybeParseJSON<string[]>(row.pages_updated, []),
      summary: row.summary as string,
      created_at: new Date(row.created_at as string),
    }));
  }

  // Sync
  async updateSlug(oldSlug: string, newSlug: string): Promise<void> {
    const normalized = validateSlug(newSlug);
    this.run('UPDATE pages SET slug = ?, updated_at = ? WHERE slug = ?', [normalized, nowIso(), oldSlug]);
  }

  async rewriteLinks(_oldSlug: string, _newSlug: string): Promise<void> {
    // Links use page IDs. Updating page slug keeps FK relations intact.
  }

  // Config
  async getConfig(key: string): Promise<string | null> {
    const row = this.get<{ value: string }>('SELECT value FROM config WHERE key = ?', [key]);
    return row ? row.value : null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    this.run(
      `INSERT INTO config (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      [key, value],
    );
  }

  // Migration support
  async runMigration(version: number, _sql: string): Promise<void> {
    switch (version) {
      case 2:
        // Handled by the migration handler (slugify_existing_pages).
        return;
      case 3:
        this.run(`
          DELETE FROM content_chunks
          WHERE id IN (
            SELECT a.id
            FROM content_chunks a
            JOIN content_chunks b
              ON a.page_id = b.page_id
             AND a.chunk_index = b.chunk_index
             AND a.id > b.id
          )
        `);
        this.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_chunks_page_index ON content_chunks(page_id, chunk_index)`);
        return;
      case 4:
        this.run(`
          CREATE TABLE IF NOT EXISTS access_tokens (
            id TEXT PRIMARY KEY,
            name TEXT NOT NULL,
            token_hash TEXT NOT NULL UNIQUE,
            scopes TEXT,
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            last_used_at TEXT,
            revoked_at TEXT
          )
        `);
        this.run(`CREATE INDEX IF NOT EXISTS idx_access_tokens_hash ON access_tokens(token_hash)`);
        this.run(`
          CREATE TABLE IF NOT EXISTS mcp_request_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            token_name TEXT,
            operation TEXT NOT NULL,
            latency_ms INTEGER,
            status TEXT NOT NULL DEFAULT 'success',
            created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
          )
        `);
        return;
      case 5:
      case 6:
      case 7:
      case 13:
        // Base schema already contains these structures in SQLite form.
        return;
      case 12:
        // Budget ledger + reservations. Not in base schema, port from the
        // Postgres migration (see src/core/migrate.ts v12). Type mappings:
        // NUMERIC -> REAL, DATE -> TEXT (ISO), TIMESTAMPTZ -> TEXT (ISO).
        this.run(`
          CREATE TABLE IF NOT EXISTS budget_ledger (
            scope          TEXT NOT NULL,
            resolver_id    TEXT NOT NULL,
            local_date     TEXT NOT NULL,
            reserved_usd   REAL NOT NULL DEFAULT 0,
            committed_usd  REAL NOT NULL DEFAULT 0,
            cap_usd        REAL,
            created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            PRIMARY KEY (scope, resolver_id, local_date)
          )
        `);
        this.run(`
          CREATE TABLE IF NOT EXISTS budget_reservations (
            reservation_id TEXT PRIMARY KEY,
            scope          TEXT NOT NULL,
            resolver_id    TEXT NOT NULL,
            local_date     TEXT NOT NULL,
            estimate_usd   REAL NOT NULL,
            reserved_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
            expires_at     TEXT NOT NULL,
            status         TEXT NOT NULL DEFAULT 'held'
          )
        `);
        this.run(`
          CREATE INDEX IF NOT EXISTS idx_budget_reservations_expires
            ON budget_reservations(expires_at) WHERE status = 'held'
        `);
        return;
      case 8:
        this.run(`DROP INDEX IF EXISTS idx_links_unique`);
        this.run(`
          DELETE FROM links
          WHERE id IN (
            SELECT a.id
            FROM links a
            JOIN links b
              ON a.from_page_id = b.from_page_id
             AND a.to_page_id = b.to_page_id
             AND a.link_type = b.link_type
             AND ifnull(a.link_source, '') = ifnull(b.link_source, '')
             AND ifnull(a.origin_page_id, -1) = ifnull(b.origin_page_id, -1)
             AND a.id > b.id
          )
        `);
        this.run(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_links_unique
          ON links(from_page_id, to_page_id, link_type, ifnull(link_source, ''), ifnull(origin_page_id, -1))
        `);
        return;
      case 9:
        this.run(`DROP INDEX IF EXISTS idx_timeline_dedup`);
        this.run(`
          DELETE FROM timeline_entries
          WHERE id IN (
            SELECT a.id
            FROM timeline_entries a
            JOIN timeline_entries b
              ON a.page_id = b.page_id
             AND a.date = b.date
             AND a.summary = b.summary
             AND a.id > b.id
          )
        `);
        this.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_timeline_dedup ON timeline_entries(page_id, date, summary)`);
        return;
      case 10:
        return;
      case 11:
        if (!this.hasColumn('links', 'link_source')) {
          this.run(`ALTER TABLE links ADD COLUMN link_source TEXT`);
        }
        if (!this.hasColumn('links', 'origin_page_id')) {
          this.run(`ALTER TABLE links ADD COLUMN origin_page_id INTEGER REFERENCES pages(id) ON DELETE SET NULL`);
        }
        if (!this.hasColumn('links', 'origin_field')) {
          this.run(`ALTER TABLE links ADD COLUMN origin_field TEXT`);
        }
        this.run(`UPDATE links SET link_source = 'markdown' WHERE link_source IS NULL`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_links_source ON links(link_source)`);
        this.run(`CREATE INDEX IF NOT EXISTS idx_links_origin ON links(origin_page_id)`);
        return;
      default:
        return;
    }
  }

  async getChunksWithEmbeddings(slug: string): Promise<Chunk[]> {
    const rows = this.all<Record<string, unknown>>(
      `SELECT cc.*
       FROM content_chunks cc
       JOIN pages p ON p.id = cc.page_id
       WHERE p.slug = ?
       ORDER BY cc.chunk_index`,
      [slug],
    );
    const hydratedRows = rows.map((row) => {
      const emb = blobToEmbedding(row.embedding);
      if (!emb) return row;
      return { ...row, embedding: Array.from(emb) };
    });
    return hydratedRows.map(r => rowToChunk(r, true));
  }

  async executeRaw<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]> {
    const rewritten = rewritePortableSql(sql);
    const unsupported = detectUnsupportedPostgresFeature(rewritten);
    if (unsupported) {
      throw new Error(
        `SQLite engine does not support this Postgres feature: ${unsupported}.\n` +
        'The calling module (MinionQueue / extract / etc.) uses raw Postgres SQL that has not been ported.\n' +
        'Fix: use the Postgres or PGLite engine for workflows that depend on this feature, or contribute a SQLite-native implementation.',
      );
    }

    return this.all<T>(rewritten, params ?? []);
  }
}
