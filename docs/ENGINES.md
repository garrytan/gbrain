# Pluggable Engine Architecture

## The idea

Every MBrain operation goes through `BrainEngine`. The engine is the contract between "what the brain can do" and "how it's stored." Swap the engine, keep everything else.

`PostgresEngine` remains the full cloud-backed path. `SQLiteEngine` and `PGLiteEngine` are current local-path contract engines, and the same interface is designed so a `DuckDBEngine` or `TursoEngine` could slot in without touching the CLI, MCP server, skills, or any consumer code.

## Why this matters

Different users have different constraints:

| User | Needs | Best engine |
|------|-------|-------------|
| Single-user personal brain | Single file, no server, local/offline operation | SQLiteEngine |
| Managed large brain | pgvector at scale, remote MCP deployment, cloud file/storage workflows | PostgresEngine + Supabase or self-hosted Postgres |
| Team/enterprise | Multi-user, RLS, audit trail | PostgresEngine + self-hosted |
| Researcher | Analytics, bulk exports, embeddings | DuckDBEngine (someday) |
| Edge/mobile | Offline-first with sync later | TursoEngine/libSQL (someday) |

The engine interface means we do not have to choose a single storage story. Postgres remains the full cloud path, while SQLite and PGLite already cover honest local-path usage and still leave room for more engines later.

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

**Embedding is NOT in the engine.** The engine stores embeddings and searches by vector, but it doesn't generate embeddings. `src/core/embedding.ts` handles that through the configured provider: local Ollama-compatible runtimes for SQLite/local mode, or hosted providers when configured. All engines share the same embedding service.

**Chunking is NOT in the engine.** Same logic. `src/core/chunkers/` handles chunking. The engine stores and retrieves chunks. All engines share the same chunkers.

**Search returns `SearchResult[]`, not raw rows.** The engine is responsible for its own search implementation (tsvector vs FTS5, pgvector HNSW vs stored vectors + local cosine scan) but must return a uniform result type. RRF fusion and dedup happen above the engine, in `src/core/search/hybrid.ts`.

**`traverseGraph` exists but is engine-specific.** Postgres uses recursive CTEs. SQLite uses a loop with depth tracking. The interface is the same: give me a slug and max depth, return the graph.

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
| tsvector +    |  | FTS5 +    |   | pgvector  |  | stored      |
| ts_rank +     |  | bm25      |   | HNSW      |  | vectors +   |
| websearch_to_ |  |           |   | cosine    |  | local       |
| tsquery       |  |           |   |           |  | cosine scan |
+---------------+  +-----------+   +-----------+  +-------------+
```

RRF fusion, multi-query expansion, and 4-layer dedup are engine-agnostic. They operate on `SearchResult[]` arrays. Only the raw keyword and vector searches are engine-specific.

## Optional Managed/Remote Postgres Path

**Dependencies:** `postgres` (porsager/postgres), `pgvector`

**Postgres-specific features used:**
- `tsvector` + `GIN` index for full-text search with `ts_rank` weighting
- `pgvector` HNSW index for cosine similarity vector search
- `pg_trgm` + `GIN` for fuzzy slug resolution
- Recursive CTEs for graph traversal
- Trigger-based search_vector (spans pages + timeline_entries)
- JSONB for frontmatter with GIN index
- Connection pooling through managed providers such as Supabase Supavisor

**Hosting:** Supabase is one managed option; self-hosted Postgres also works when the required extensions and schema are available. Use this path when you need managed scale, remote MCP deployment, or cloud file/storage workflows.

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
3. Store engine type in `~/.mbrain/config.json`: `{ "engine": "sqlite", ... }`
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

| Capability | PostgresEngine | SQLiteEngine | Notes |
|-----------|---------------|----------------------|-------|
| CRUD | Full | Full | |
| Keyword search | tsvector + ts_rank | FTS5 + bm25 | Different ranking algorithms |
| Vector search | pgvector HNSW | stored vectors + local cosine scan | SQLite avoids extension dependencies for local/offline installs |
| Fuzzy slug | pg_trgm similarity (`%` operator) | case-insensitive LIKE pattern | Postgres matches fuzzy typos; SQLite requires substring match |
| Graph traversal | Recursive CTE | Loop with depth tracking | Same interface |
| Transactions | Full ACID | Full ACID | Both support this |
| JSONB queries | GIN index | json_extract | Postgres is richer |
| Concurrent access | Connection pooling | Single writer | SQLite limitation |
| Hosting | Supabase, self-hosted, Docker | Local file | |

## Current local paths and future engine ideas

**SQLiteEngine.** Current shipped local/offline engine for a single-user personal brain. It stores the brain in one SQLite database, uses FTS5 for keyword search, stores page/chunk embeddings, and performs vector recall with a local cosine scan. Single file, no server, git-friendly.

**PGLiteEngine.** Current embedded-Postgres local-path engine. It keeps local execution on-device while preserving more Postgres semantics than SQLite.

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

## Phase 0 execution envelope

The redesign's Phase 0 contract is explicit:

- Markdown remains canonical across every engine.
- Derived artifacts remain regenerable.
- SQLite and PGLite are supported contract paths, not preview-only modes.
- Unsupported surfaces such as cloud file storage in sqlite mode must be exposed honestly in diagnostics.
