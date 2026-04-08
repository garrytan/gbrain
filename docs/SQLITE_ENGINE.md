# SQLite Engine Design

## Status: Built. See `src/core/sqlite-engine.ts`.

The pluggable engine interface (`docs/ENGINES.md`) means anyone can add a SQLite backend without touching the CLI, MCP server, or skills. This document is the full plan.

## Why SQLite

Postgres is the right choice for the primary user (7K+ pages, production RAG, zero-ops via Supabase). But a lot of people want something simpler:

- **No server.** One file. `brain.db`. Done.
- **Git-friendly.** You can (with care) commit a SQLite database alongside your notes.
- **Offline.** Works on a plane, in a coffee shop, wherever.
- **Zero cost.** No Supabase subscription. No hosting. No API keys for search (keyword-only mode works without OpenAI).
- **Portable.** Copy the file to another machine. That's it.

Tools like Khoj, Obsidian plugins, and various "local-first AI" projects already use SQLite with vector extensions. The patterns exist. This is well-trodden ground.

## What it gives up

Compared to PostgresEngine:

| Feature | Postgres | SQLite | Impact |
|---------|----------|--------|--------|
| Full-text search quality | tsvector + ts_rank (excellent) | FTS5 + bm25 (good) | Slightly less precise ranking |
| Fuzzy slug matching | pg_trgm (excellent) | LIKE + Levenshtein (ok) | Fuzzier matching, more false positives |
| Vector search | pgvector HNSW (fast, accurate) | sqlite-vss or vec0 (good enough) | Slower at scale, good for <50K chunks |
| Concurrent access | Connection pooling, many readers/writers | Single writer, many readers | Not an issue for single-user CLI |
| JSONB queries | GIN index, rich operators | json_extract, no index | Slower frontmatter queries |
| Graph traversal | Recursive CTE (native) | Recursive CTE (supported since 3.8.3) | Same |
| Hosted option | Supabase, RDS, etc. | Turso (libSQL), Cloudflare D1 | SQLite has cloud options too |

For a single user with <10K pages and no concurrent access needs, these tradeoffs are fine.

## Schema

SQLite equivalent of the Postgres schema. Key differences called out.

```sql
-- Enable WAL mode for better read concurrency
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;

-- ============================================================
-- pages
-- ============================================================
CREATE TABLE pages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT    NOT NULL UNIQUE,
  type          TEXT    NOT NULL,
  title         TEXT    NOT NULL,
  compiled_truth TEXT   NOT NULL DEFAULT '',
  timeline      TEXT    NOT NULL DEFAULT '',
  frontmatter   TEXT    NOT NULL DEFAULT '{}',  -- JSON string, not JSONB
  content_hash  TEXT,                            -- SHA-256 for import idempotency
  created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_pages_type ON pages(type);

-- ============================================================
-- Full-text search via FTS5 (replaces tsvector)
-- ============================================================
CREATE VIRTUAL TABLE pages_fts USING fts5(
  title,
  compiled_truth,
  timeline,
  content='pages',
  content_rowid='id',
  tokenize='porter unicode61'
);

-- Triggers to keep FTS5 in sync
CREATE TRIGGER pages_fts_insert AFTER INSERT ON pages BEGIN
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline)
  VALUES (new.id, new.title, new.compiled_truth, new.timeline);
END;

CREATE TRIGGER pages_fts_update AFTER UPDATE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline)
  VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline);
  INSERT INTO pages_fts(rowid, title, compiled_truth, timeline)
  VALUES (new.id, new.title, new.compiled_truth, new.timeline);
END;

CREATE TRIGGER pages_fts_delete AFTER DELETE ON pages BEGIN
  INSERT INTO pages_fts(pages_fts, rowid, title, compiled_truth, timeline)
  VALUES ('delete', old.id, old.title, old.compiled_truth, old.timeline);
END;

-- ============================================================
-- content_chunks
-- ============================================================
CREATE TABLE content_chunks (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id       INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  chunk_index   INTEGER NOT NULL,
  chunk_text    TEXT    NOT NULL,
  chunk_source  TEXT    NOT NULL DEFAULT 'compiled_truth',
  embedding     BLOB,                              -- Float32Array as raw bytes
  model         TEXT    NOT NULL DEFAULT 'text-embedding-3-large',
  token_count   INTEGER,
  embedded_at   TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_chunks_page ON content_chunks(page_id);

-- Vector search index created separately via sqlite-vss or vec0
-- See "Vector search options" section below

-- ============================================================
-- links
-- ============================================================
CREATE TABLE links (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  from_page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  to_page_id   INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  link_type    TEXT    NOT NULL DEFAULT '',
  context      TEXT    NOT NULL DEFAULT '',
  created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(from_page_id, to_page_id)
);

CREATE INDEX idx_links_from ON links(from_page_id);
CREATE INDEX idx_links_to   ON links(to_page_id);

-- ============================================================
-- tags
-- ============================================================
CREATE TABLE tags (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  tag     TEXT    NOT NULL,
  UNIQUE(page_id, tag)
);

CREATE INDEX idx_tags_tag     ON tags(tag);
CREATE INDEX idx_tags_page_id ON tags(page_id);

-- ============================================================
-- raw_data
-- ============================================================
CREATE TABLE raw_data (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id    INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  source     TEXT    NOT NULL,
  data       TEXT    NOT NULL,  -- JSON string
  fetched_at TEXT    NOT NULL DEFAULT (datetime('now')),
  UNIQUE(page_id, source)
);

CREATE INDEX idx_raw_data_page ON raw_data(page_id);

-- ============================================================
-- timeline_entries
-- ============================================================
CREATE TABLE timeline_entries (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id  INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  date     TEXT    NOT NULL,  -- ISO date string
  source   TEXT    NOT NULL DEFAULT '',
  summary  TEXT    NOT NULL,
  detail   TEXT    NOT NULL DEFAULT '',
  created_at TEXT  NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_timeline_page ON timeline_entries(page_id);
CREATE INDEX idx_timeline_date ON timeline_entries(date);

-- ============================================================
-- page_versions
-- ============================================================
CREATE TABLE page_versions (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  page_id        INTEGER NOT NULL REFERENCES pages(id) ON DELETE CASCADE,
  compiled_truth TEXT    NOT NULL,
  frontmatter    TEXT    NOT NULL DEFAULT '{}',
  snapshot_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_versions_page ON page_versions(page_id);

-- ============================================================
-- ingest_log
-- ============================================================
CREATE TABLE ingest_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  source_type   TEXT    NOT NULL,
  source_ref    TEXT    NOT NULL,
  pages_updated TEXT    NOT NULL DEFAULT '[]',  -- JSON array
  summary       TEXT    NOT NULL DEFAULT '',
  created_at    TEXT    NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- config
-- ============================================================
CREATE TABLE config (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

INSERT INTO config (key, value) VALUES
  ('version', '1'),
  ('engine', 'sqlite'),
  ('embedding_model', 'text-embedding-3-large'),
  ('embedding_dimensions', '1536'),
  ('chunk_strategy', 'semantic');
```

### Key differences from Postgres schema

| Feature | Postgres | SQLite |
|---------|----------|--------|
| Types | `SERIAL`, `TIMESTAMPTZ`, `JSONB`, `vector(1536)` | `INTEGER`, `TEXT`, `TEXT` (JSON), `BLOB` |
| Full-text search | `tsvector` generated column + GIN | FTS5 virtual table + triggers |
| Vector storage | `vector(1536)` column type | `BLOB` (raw Float32Array bytes) |
| Vector index | HNSW via pgvector | Separate via sqlite-vss or vec0 |
| Fuzzy search | `pg_trgm` GIN index | LIKE queries or Levenshtein UDF |
| JSON queries | `JSONB` + GIN index | `json_extract()` function |
| Timestamps | `TIMESTAMPTZ` (native) | `TEXT` with ISO format |

## Vector search options

Two main choices for vector search in SQLite:

### Option A: sqlite-vss (Alex Garcia)

```sql
-- Load extension
.load ./vector0
.load ./vss0

-- Create virtual table linked to content_chunks
CREATE VIRTUAL TABLE chunks_vss USING vss0(
  embedding(1536)
);

-- Insert embeddings (linked by rowid to content_chunks)
INSERT INTO chunks_vss(rowid, embedding)
SELECT id, embedding FROM content_chunks WHERE embedding IS NOT NULL;

-- Search
SELECT rowid, distance
FROM chunks_vss
WHERE vss_search(embedding, :query_embedding)
LIMIT 20;
```

Pros: mature, well-documented, used by many projects.
Cons: requires loading native extensions (platform-specific binaries).

### Option B: vec0 (newer, from same author)

```sql
-- Create virtual table
CREATE VIRTUAL TABLE chunks_vec USING vec0(
  chunk_id INTEGER PRIMARY KEY,
  embedding float[1536]
);

-- Search
SELECT chunk_id, distance
FROM chunks_vec
WHERE embedding MATCH :query_embedding
ORDER BY distance
LIMIT 20;
```

Pros: simpler API, better integration with SQLite ecosystem.
Cons: newer, less battle-tested.

### Option C: No vector search (keyword only)

For users who don't want to deal with vector extensions or OpenAI API keys, the brain still works with keyword search only. FTS5 + bm25 is genuinely good for structured wiki content where you know the terms. `searchVector` returns `[]`, hybrid search degrades gracefully to keyword-only.

This is a valid configuration. Not everyone needs embeddings.

## Init flow for SQLite

```bash
gbrain init --sqlite
# or: gbrain init --sqlite --path ~/brain.db

# 1. Create database file at specified path (default: ~/.gbrain/brain.db)
# 2. Run schema (all CREATE TABLE + FTS5 + triggers)
# 3. Write config to ~/.gbrain/config.json:
#    { "engine": "sqlite", "database_path": "~/.gbrain/brain.db" }
# 4. Verify database is ready for import
# 5. "Brain ready. Run: gbrain import <your-repo>"
```

No Supabase account needed. No API keys needed (keyword-only mode). No server. Just a file.

For vector search, the user additionally needs:
- OpenAI API key in `~/.gbrain/config.json` or `OPENAI_API_KEY` env var
- sqlite-vss or vec0 extension binary for their platform

## Fuzzy slug resolution without pg_trgm

Postgres uses `pg_trgm` GIN index for fast fuzzy matching. SQLite doesn't have this. Options:

1. **LIKE with wildcards.** `WHERE slug LIKE '%dont%scale%'`. Simple, works for partial matches, but no ranking.
2. **Levenshtein distance via UDF.** Load a user-defined function (or implement in TS) that computes edit distance. Sort by distance. Slower but more accurate.
3. **Trigram simulation in TS.** Compute trigrams in TypeScript, store in a separate table, query by trigram overlap. Fast but requires maintaining the trigram index.

Recommendation: start with LIKE + fallback to Levenshtein UDF. Good enough for single-user, <10K pages.

## Implementation roadmap

If you're building this, here's the order:

1. **`src/core/sqlite-engine.ts`** implementing `BrainEngine`
2. **Schema migration** (the SQL above)
3. **CRUD operations** (getPage, putPage, listPages, deletePage). Straightforward SQL.
4. **FTS5 keyword search** (searchKeyword). Map `websearch_to_tsquery` semantics to FTS5 query syntax.
5. **Tags, links, timeline, raw_data, versions, config, ingest_log.** All straightforward.
6. **Graph traversal.** SQLite supports recursive CTEs since 3.8.3. Port the Postgres CTE with max depth.
7. **Vector search** (optional). Pick sqlite-vss or vec0, implement searchVector.
8. **Tests.** Port the Postgres test suite. Most tests should be engine-agnostic.

Steps 1-6 are purely mechanical. Step 7 is the only one that requires a native extension.

## Dependencies for SQLite engine

```json
{
  "better-sqlite3": "^11.0.0"
}
```

Or use Bun's built-in `bun:sqlite` driver (zero dependency).

For vector search, add one of:
- `sqlite-vss` (native extension, platform-specific)
- `vec0` (native extension, platform-specific)

## Testing strategy

Most test cases should be engine-agnostic. The test runner should parameterize by engine:

```typescript
const engines = [
  { name: 'postgres', factory: () => new PostgresEngine() },
  { name: 'sqlite', factory: () => new SQLiteEngine() },
];

for (const { name, factory } of engines) {
  describe(`BrainEngine (${name})`, () => {
    const engine = factory();

    test('putPage + getPage round-trip', async () => {
      await engine.putPage('test/slug', { title: 'Test', type: 'person', ... });
      const page = await engine.getPage('test/slug');
      expect(page.title).toBe('Test');
    });

    // ... all CRUD, search, link, tag, timeline tests
  });
}
```

Search tests may need engine-specific assertions (ranking differences between tsvector and FTS5 are expected). But the interface contract (returns SearchResult[], sorted by relevance) should hold across engines.

## File structure

```
brain.db                    # ~750MB for 7K pages with embeddings
                            # ~150MB without embeddings (keyword-only)
~/.gbrain/config.json       # { "engine": "sqlite", "database_path": "..." }
```

That's it. One file for the brain. One file for config.

## Migration between engines

Future work: `gbrain migrate --from postgres --to sqlite` (and vice versa). The engine interface makes this straightforward... export all data via one engine's methods, import via the other's. The data model is the same, only the storage format changes.

This is not built yet. For now, `gbrain export` to markdown and `gbrain import` into the other engine achieves the same result (with re-chunking and re-embedding).

## Contributing

If you want to build this:

1. Fork the repo
2. Create `src/core/sqlite-engine.ts`
3. Use the schema from this document
4. Run the existing test suite against your engine
5. PR it

The interface is well-defined. The schema is documented. The test suite exists. This should be a few days of focused work with CC, or a weekend project for a human.

We'd love to see it.
