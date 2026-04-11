# Pluggable Engine Architecture

## The idea

Every GBrain operation goes through `BrainEngine`. The engine is the contract between "what the brain can do" and "how it's stored." Swap the engine, keep everything else.

v0 ships `PostgresEngine` backed by Supabase. The interface is designed so a `SQLiteEngine`, `DuckDBEngine`, or `TursoEngine` could slot in without touching the CLI, MCP server, skills, or any consumer code.

## Why this matters

Different users have different constraints:

| User | Needs | Best engine |
|------|-------|-------------|
| Power user (you) | World-class search, 7K+ pages, zero-ops | PostgresEngine + Supabase |
| Open source hacker | Single file, no server, git-friendly | SQLiteEngine (future) |
| Team/enterprise | Multi-user, RLS, audit trail | PostgresEngine + self-hosted |
| Researcher | Analytics, bulk exports, embeddings | DuckDBEngine (someday) |
| Edge/mobile | Offline-first, sync later | SQLiteEngine + sync (someday) |

The engine interface means we don't have to choose. Ship Postgres now, let the community build the rest.

## The interface

```typescript
// src/core/engine.ts

export interface BrainEngine {
  // Lifecycle
  connect(config: EngineConfig): Promise<void>;
  disconnect(): Promise<void>;
  initSchema(): Promise<void>;
  transaction<T>(fn: (engine: BrainEngine) => Promise<T>): Promise<T>;

  // Pages CRUD
  getPage(slug: string): Promise<Page | null>;
  putPage(slug: string, page: PageInput): Promise<Page>;
  deletePage(slug: string): Promise<void>;
  listPages(filters: PageFilters): Promise<Page[]>;

  // Search
  searchKeyword(query: string, opts?: SearchOpts): Promise<SearchResult[]>;
  searchVector(embedding: Float32Array, opts?: SearchOpts): Promise<SearchResult[]>;

  // Chunks
  upsertChunks(slug: string, chunks: ChunkInput[]): Promise<void>;
  getChunks(slug: string): Promise<Chunk[]>;

  // Links
  addLink(from: string, to: string, context?: string, linkType?: string): Promise<void>;
  removeLink(from: string, to: string): Promise<void>;
  getLinks(slug: string): Promise<Link[]>;
  getBacklinks(slug: string): Promise<Link[]>;
  traverseGraph(slug: string, depth?: number): Promise<GraphNode[]>;

  // Tags
  addTag(slug: string, tag: string): Promise<void>;
  removeTag(slug: string, tag: string): Promise<void>;
  getTags(slug: string): Promise<string[]>;

  // Timeline
  addTimelineEntry(slug: string, entry: TimelineInput): Promise<void>;
  getTimeline(slug: string, opts?: TimelineOpts): Promise<TimelineEntry[]>;

  // Raw data
  putRawData(slug: string, source: string, data: object): Promise<void>;
  getRawData(slug: string, source?: string): Promise<RawData[]>;

  // Versions
  createVersion(slug: string): Promise<PageVersion>;
  getVersions(slug: string): Promise<PageVersion[]>;
  revertToVersion(slug: string, versionId: number): Promise<void>;

  // Stats + health
  getStats(): Promise<BrainStats>;
  getHealth(): Promise<BrainHealth>;

  // Ingest log
  logIngest(entry: IngestLogInput): Promise<void>;
  getIngestLog(opts?: IngestLogOpts): Promise<IngestLogEntry[]>;

  // Config
  getConfig(key: string): Promise<string | null>;
  setConfig(key: string, value: string): Promise<void>;
}
```

### Key design choices

**Slug-based API, not ID-based.** Every method takes slugs, not numeric IDs. The engine resolves slugs to IDs internally. This keeps the interface portable... slugs are strings, IDs are database-specific.

**Embedding is NOT in the engine.** The engine stores embeddings and searches by vector, but it doesn't generate embeddings. `src/core/embedding.ts` handles that. This is intentional: embedding is an external API call (OpenAI), not a storage concern. All engines share the same embedding service.

**Chunking is NOT in the engine.** Same logic. `src/core/chunkers/` handles chunking. The engine stores and retrieves chunks. All engines share the same chunkers.

**Search returns `SearchResult[]`, not raw rows.** The engine is responsible for its own search implementation (tsvector vs FTS5, pgvector vs sqlite-vss) but must return a uniform result type. RRF fusion and dedup happen above the engine, in `src/core/search/hybrid.ts`.

**`traverseGraph` exists but is engine-specific.** Postgres uses recursive CTEs. SQLite would use a loop with depth tracking. The interface is the same: give me a slug and max depth, return the graph.

## How search works across engines

```
                        +-------------------+
                        |  hybrid.ts        |
                        |  (RRF fusion +    |
                        |   dedup, shared)  |
                        +--------+----------+
                                 |
                    +------------+------------+
                    |                         |
           +--------v--------+       +--------v--------+
           | engine.search   |       | engine.search   |
           |   Keyword()     |       |   Vector()      |
           +-----------------+       +-----------------+
                    |                         |
        +-----------+-----------+   +---------+---------+
        |                       |   |                   |
+-------v-------+  +-------v---+   +-------v---+  +----v--------+
| Postgres:     |  | SQLite:   |   | Postgres: |  | SQLite:     |
| tsvector +    |  | FTS5 +    |   | pgvector  |  | sqlite-vss  |
| ts_rank +     |  | bm25      |   | HNSW      |  | or vec0     |
| websearch_to_ |  |           |   | cosine    |  |             |
| tsquery       |  |           |   |           |  |             |
+---------------+  +-----------+   +-----------+  +-------------+
```

RRF fusion, multi-query expansion, and 4-layer dedup are engine-agnostic. They operate on `SearchResult[]` arrays. Only the raw keyword and vector searches are engine-specific.

## PostgresEngine (v0, ships)

**Dependencies:** `postgres` (porsager/postgres), `pgvector`

**Postgres-specific features used:**
- `tsvector` + `GIN` index for full-text search with `ts_rank` weighting
- `pgvector` HNSW index for cosine similarity vector search
- `pg_trgm` + `GIN` for fuzzy slug resolution
- Recursive CTEs for graph traversal
- Trigger-based search_vector (spans pages + timeline_entries)
- JSONB for frontmatter with GIN index
- Connection pooling via Supabase Supavisor (port 6543)

**Hosting:** Supabase Pro ($25/mo). Zero-ops. Managed Postgres with pgvector built in.

**Why not self-hosted for v0:** The brain should be infrastructure agents use, not something you maintain. Self-hosted Postgres with Docker is a welcome community PR, but v0 optimizes for zero ops.

## Adding a new engine

1. Create `src/core/<name>-engine.ts` implementing `BrainEngine`
2. Add to engine factory in `src/core/engine.ts`:
   ```typescript
   export function createEngine(type: string): BrainEngine {
     switch (type) {
       case 'postgres': return new PostgresEngine();
       case 'sqlite': return new SQLiteEngine();
       default: throw new Error(`Unknown engine: ${type}`);
     }
   }
   ```
3. Store engine type in `~/.gbrain/config.json`: `{ "engine": "sqlite", ... }`
4. Add tests. The test suite should be engine-agnostic where possible... same test cases, different engine constructor.
5. Document in this file + add a design doc in `docs/`

### What you DON'T need to touch

- `src/cli.ts` (dispatches to engine, doesn't know which one)
- `src/mcp/server.ts` (same)
- `src/core/chunkers/*` (shared across engines)
- `src/core/embedding.ts` (shared across engines)
- `src/core/search/hybrid.ts`, `expansion.ts`, `dedup.ts` (shared, operate on SearchResult[])
- `skills/*` (fat markdown, engine-agnostic)

### What you DO need to implement

Every method in `BrainEngine`. The full interface. No optional methods, no feature flags. If your engine can't do vector search (e.g., a pure-text engine), implement `searchVector` to return `[]` and document the limitation.

## Capability matrix

| Capability | PostgresEngine | SQLiteEngine (future) | Notes |
|-----------|---------------|----------------------|-------|
| CRUD | Full | Full | |
| Keyword search | tsvector + ts_rank | FTS5 + bm25 | Different ranking algorithms |
| Vector search | pgvector HNSW | sqlite-vss or vec0 | Different index types |
| Fuzzy slug | pg_trgm similarity (`%` operator) | case-insensitive LIKE pattern | Postgres matches fuzzy typos; SQLite requires substring match |
| Graph traversal | Recursive CTE | Loop with depth tracking | Same interface |
| Transactions | Full ACID | Full ACID | Both support this |
| JSONB queries | GIN index | json_extract | Postgres is richer |
| Concurrent access | Connection pooling | Single writer | SQLite limitation |
| Hosting | Supabase, self-hosted, Docker | Local file | |

## Future engine ideas

**SQLiteEngine** (most requested). See `docs/SQLITE_ENGINE.md` for the full plan. Single file, no server, git-friendly. Uses FTS5 for keyword search, sqlite-vss or vec0 for vector search. Great for open source users who want zero infrastructure.

**TursoEngine.** libSQL (SQLite fork) with embedded replicas and HTTP edge access. Would give SQLite's simplicity with cloud sync. Interesting for mobile/edge use cases.

**DuckDBEngine.** Analytical workloads. Bulk exports, embedding analysis, brain-wide statistics. Not for OLTP. Could be a secondary engine for analytics alongside Postgres for operations.

**Custom/Remote.** The interface is clean enough that someone could build an engine backed by any storage: Firestore, DynamoDB, a REST API, even a flat file system. The interface doesn't assume SQL.

## Known parity gaps

These behavioral differences between PostgresEngine and SQLiteEngine are intentional trade-offs, not bugs:

| Area | PostgresEngine | SQLiteEngine | Impact |
|------|---------------|-------------|--------|
| Fuzzy slug resolution | `pg_trgm` similarity scoring — tolerates typos and partial-word matches | Case-insensitive `LIKE` pattern — requires the query to be a substring of the slug or title | SQLite may miss typo-tolerant matches that Postgres would find. Workaround: use exact slugs when possible. |
| Keyword search chunk_text | JOINs `content_chunks` and returns the actual matching chunk text (~500 tokens) | Returns a ~300-char snippet window extracted from the matched page body around matching terms | Both return focused text; the extraction mechanism differs. |
| File storage | Full support (Postgres `files` table + cloud storage backends) | Not supported — the `files` command requires a Postgres backend | Local mode users store files via git or filesystem directly. |
