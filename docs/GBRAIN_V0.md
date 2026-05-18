# GBrain v0: Postgres-Native Personal Knowledge Brain

## What this is

GBrain is a compiled intelligence system. Not a note-taking app. Not "chat with your notes."

Every page is an intelligence assessment. Above the line: compiled truth (your current best understanding, rewritten when evidence changes). Below the line: timeline (append-only evidence trail). AI agents maintain the brain. MCP clients query it. The intelligence lives in fat markdown skills, not application code.

The core insight: personal knowledge at scale is an intelligence problem, not a storage problem.

## Why it exists

A 7,471-file / 2.3GB markdown wiki is choking git. Git doesn't scale past ~5K files for wiki-style use. The compiled truth + timeline model (Karpathy-style knowledge pages) is right, but it needs a real database underneath.

There's already a production-grade RAG system (Ruby on Rails, Postgres + pgvector) with 3-tier chunking, hybrid search with RRF, multi-query expansion, and 4-layer dedup. GBrain ports these proven patterns to a standalone Bun + TypeScript tool.

## The knowledge model

```
+--------------------------------------------------+
|  Page: concepts/do-things-that-dont-scale         |
|                                                   |
|  --- frontmatter (YAML) ---                       |
|  type: concept                                    |
|  tags: [startups, growth, pg-essay]               |
|                                                   |
|  === COMPILED TRUTH ===                           |
|  Current best understanding.                      |
|  Rewritten on new evidence.                       |
|  This is the "what we know now" section.          |
|                                                   |
|  ---                                              |
|                                                   |
|  === TIMELINE ===                                 |
|  Append-only evidence trail.                      |
|  - 2013-07-01: Published on paulgraham.com        |
|  - 2024-11-15: Referenced in batch kickoff talk   |
|  Never edited, only appended.                     |
+--------------------------------------------------+
          |                    |
          v                    v
  [Semantic chunks]     [Recursive chunks]
  (best quality for     (predictable format
   compiled truth)       for timeline)
          |                    |
          v                    v
     [Embeddings: text-embedding-3-large, 1536 dims]
          |
          v
  [HNSW index + tsvector + pg_trgm]
          |
          v
  [Hybrid search: vector + keyword + RRF fusion]
```

## Architecture decisions

### v0 stack

| Layer | Choice | Why |
|-------|--------|-----|
| Database | Postgres + pgvector | Proven RAG patterns, production-tested. World-class hybrid search. |
| Hosting | Supabase Pro ($25/mo) | Zero-ops. Managed Postgres, pgvector, connection pooling. 8GB storage. |
| Runtime | Bun + TypeScript | Consistent with GStack ecosystem. Fast. Compiles to single binary. |
| Embeddings | OpenAI text-embedding-3-large | 1536 dims (reduced from 3072 via dimensions API). ~$0.13/1M tokens. |
| LLM (chunking/expansion) | Claude Haiku | Cheapest model for topic boundary detection and query expansion. |
| Background jobs | Trigger.dev | Serverless. Embed backfill, stale detection, orphan audit, tag consistency. |
| Distribution | npm package + compiled binary + MCP server | Library for OpenClaw, CLI for humans, MCP for agents. |

### What we chose and why

**Postgres over SQLite.** We have 3+ years of proven RAG patterns running on Postgres. tsvector for full-text search, pgvector HNSW for semantic search, pg_trgm for fuzzy slug matching. Porting these to SQLite would mean reimplementing search from scratch. SQLite is a future pluggable engine for lightweight open source users (see `docs/ENGINES.md`).

**Supabase over self-hosted.** Zero maintenance. The brain should be infrastructure that AI agents use, not something you administer. Free tier has pgvector but only 500MB (not enough for 7K+ pages with embeddings, which need ~750MB). Pro tier at $25/mo gives 8GB. No Docker, no self-hosted Postgres in v1.

**Full port over minimal viable.** The patterns are proven. The port is mechanical. Shipping the full 3-tier chunking + hybrid search + 4-layer dedup means world-class RAG from day one. "We'll add that later" means rebuilding everything later.

**Library-first distribution.** gbrain is an npm package. OpenClaw installs it as a dependency (`bun add gbrain`), imports the engine directly. Zero-overhead function calls, shared connection pool, TypeScript types. The CLI and MCP server are thin wrappers over the same engine.

**Trigger-based tsvector (not generated column).** To include timeline_entries content in full-text search, the tsvector needs to span multiple tables. Generated columns can't do cross-table references. A trigger on pages + timeline_entries updates the search_vector.

**Auto-embed during import.** No separate embed step. `gbrain import` chunks and embeds in one pass. Progress bar shows status. `--no-embed` flag for users who want to defer. `embedded_at` column enables `gbrain embed --stale` for backfill.

## Distribution model

```
+-------------------+     +-------------------+     +-------------------+
|   npm package     |     |  Compiled binary  |     |   MCP server      |
|   (library)       |     |  (CLI)            |     |   (stdio)         |
+-------------------+     +-------------------+     +-------------------+
|                   |     |                   |     |                   |
| bun add gbrain    |     | GitHub Releases   |     | gbrain serve      |
| import { Postgres |     | npx gbrain        |     | in mcp.json       |
|   Engine }        |     |                   |     |                   |
|                   |     |                   |     |                   |
| WHO: OpenClaw,    |     | WHO: Humans       |     | WHO: Claude Code,  |
| AlphaClaw         |     |                   |     | Cursor, etc.      |
+-------------------+     +-------------------+     +-------------------+
         |                         |                         |
         +-------------------------+-------------------------+
                                   |
                          +--------v--------+
                          |  BrainEngine    |
                          |  (pluggable     |
                          |   interface)    |
                          +-----------------+
                                   |
                     +-------------+-------------+
                     |                           |
              +------v------+            +-------v-------+
              | Postgres    |            | SQLite        |
              | Engine      |            | Engine        |
              | (v0, ships) |            | (future, see  |
              +-------------+            | ENGINES.md)   |
                                         +---------------+
```

package.json exports:
- Library: `src/core/index.ts` (BrainEngine interface, PostgresEngine, types)
- CLI binary: `src/cli.ts`

## First-time experience

### Path 1: OpenClaw user (primary)

OpenClaw is the AI orchestrator that uses gbrain as its knowledge backend. This is the most common install path.

```bash
# 1. Install gbrain as a ClawHub skill
clawhub install gbrain

# 2. The skill runs guided setup on first use:
#    - Detects if Supabase CLI is available
#    - If yes: auto-provisions a new Supabase project
#    - If no: prompts for connection URL
#    - Runs schema migration
#    - Scans for markdown repos and imports user's content
#    - Shows live entity/edge extraction animation
#    - Brain is ready

# 3. From OpenClaw, brain tools are now available:
#    "Search the brain for [topic from your data]"
#    "Ingest my meeting notes from today"
#    "How many pages are in the brain?"
```

Behind the scenes, `clawhub install gbrain`:
1. Installs the `gbrain` npm package
2. Ships SKILL.md files (ingest, query, maintain, enrich, briefing, migrate)
3. Registers brain tools with the orchestrator
4. Runs `gbrain init --supabase` on first use (guided wizard)

### Path 2: CLI user (standalone)

```bash
# 1. Install
npm install -g gbrain
# or: download binary from GitHub Releases

# 2. Initialize with Supabase
gbrain init --supabase
# Guided wizard:
#   Try 1: Supabase CLI auto-provision (npx supabase)
#   Try 2: If CLI not installed or not logged in, fallback:
#          "Enter your Supabase connection URL:"
#   Then: runs schema migration, verifies pgvector extension
#   Then: verifies database is ready for import
#   Output: "Brain ready. Run: gbrain import <your-repo>"

# 3. Import your data
gbrain import /path/to/markdown/wiki/
# Progress bar: 7,471 files, auto-chunk, auto-embed
# ~30s for text import, ~10-15 min for embedding

# 4. Query
gbrain query "what does PG say about doing things that don't scale?"
```

### Path 3: MCP user (Claude Code, Cursor)

```json
// ~/.config/claude/mcp.json
{
  "mcpServers": {
    "gbrain": {
      "command": "gbrain",
      "args": ["serve"]
    }
  }
}
```

Then in Claude Code: "Search my brain for people who know about robotics"

### The init wizard in detail

`gbrain init --supabase` runs through these steps:

```
Step 1: Database Setup
  ├── Check for Supabase CLI (npx supabase --version)
  │   ├── Found + logged in → auto-create project
  │   │   ├── Create project via supabase CLI
  │   │   ├── Wait for project to be ready
  │   │   └── Extract connection string
  │   ├── Found + not logged in →
  │   │   └── Error: "Supabase CLI found but not logged in."
  │   │         Cause: "You need to authenticate first."
  │   │         Fix: "Run: npx supabase login"
  │   │         Docs: "https://supabase.com/docs/guides/cli"
  │   └── Not found → fallback to manual
  │       └── Prompt: "Enter your Supabase connection URL:"
  │
Step 2: Schema Migration
  ├── Connect to database
  ├── CREATE EXTENSION IF NOT EXISTS vector
  ├── CREATE EXTENSION IF NOT EXISTS pg_trgm
  ├── Run src/schema.sql (all tables, indexes, triggers)
  └── Verify: test insert + vector query

Step 3: Config
  ├── Write ~/.gbrain/config.json (0600 permissions)
  │   { "database_url": "...", "service_role_key": "..." }
  └── Verify connection

Step 4: Kindling Import
  ├── Import 10 bundled PG essays as demo data
  ├── Chunk + embed each essay
  ├── Show live entity/edge extraction animation:
  │   "Extracting entities... Paul Graham (person), Y Combinator (company)..."
  │   "Creating links... Paul Graham → Y Combinator (founded)..."
  └── Output: "Brain ready. 10 pages imported."

Step 5: First Query
  └── "Try: gbrain query 'what does PG say about doing things that don't scale?'"
```

Every error follows the style guide: problem + cause + fix + docs link.

## CLI commands

```
gbrain init [--supabase|--url <conn>]     # create brain
gbrain get <slug>                          # read a page
gbrain put <slug> [< file.md]             # write/update a page
gbrain search <query>                      # keyword search (tsvector)
gbrain query <question>                    # hybrid search (RRF + expansion)
gbrain ingest <file> [--type ...]         # ingest a source document
gbrain link <from> <to> [--type <type>]   # create typed link
gbrain unlink <from> <to>                 # remove link
gbrain graph <slug> [--depth 5]           # traverse link graph (recursive CTE)
gbrain backlinks <slug>                    # incoming links
gbrain tags <slug>                         # list tags
gbrain tag <slug> <tag>                    # add tag
gbrain untag <slug> <tag>                  # remove tag
gbrain timeline [<slug>]                   # view timeline
gbrain timeline-add <slug> <date> <text>  # add timeline entry
gbrain list [--type] [--tag] [--limit]    # list with filters
gbrain stats                               # brain statistics
gbrain health                              # brain health dashboard
gbrain import <dir> [--no-embed]          # import from markdown directory
gbrain export [--dir ./export/]           # export to markdown (round-trip)
gbrain embed [<slug>|--all|--stale]       # generate/refresh embeddings
gbrain serve                               # MCP server (stdio)
gbrain call <tool> '<json>'               # raw tool invocation
gbrain upgrade                             # self-update (npm, binary, ClawHub)
gbrain version                             # version info
gbrain config [get|set] <key> [value]     # brain config
```

CLI and MCP expose identical operations. Drift tests assert identical results for all operations across both interfaces.

## Database schema

9 tables in Postgres + pgvector:

```
+------------------+     +-------------------+     +------------------+
|     pages        |---->|  content_chunks   |     |     links        |
|------------------|     |-------------------|     |------------------|
| id (PK)          |     | id (PK)           |     | id (PK)          |
| slug (UNIQUE)    |     | page_id (FK)      |     | from_page_id(FK) |
| type             |     | chunk_index       |     | to_page_id (FK)  |
| title            |     | chunk_text        |     | link_type        |
| compiled_truth   |     | chunk_source      |     | context          |
| timeline         |     | embedding (1536)  |     +------------------+
| frontmatter(JSONB)|    | model             |
| search_vector    |     | token_count       |     +------------------+
| created_at       |     | embedded_at       |     |     tags         |
| updated_at       |     +-------------------+     |------------------|
+------------------+                                | id (PK)          |
       |                                            | page_id (FK)     |
       +-----> +--------------------+               | tag              |
       |       | timeline_entries   |               +------------------+
       |       |--------------------|
       |       | id (PK)            |               +------------------+
       |       | page_id (FK)       |               |   page_versions  |
       |       | date               |               |------------------|
       |       | source             |               | id (PK)          |
       |       | summary            |               | page_id (FK)     |
       |       | detail (markdown)  |               | compiled_truth   |
       |       +--------------------+               | frontmatter      |
       |                                            | snapshot_at      |
       +-----> +--------------------+               +------------------+
       |       |    raw_data        |
       |       |--------------------|               +------------------+
       |       | id (PK)            |               |    config        |
       |       | page_id (FK)       |               |------------------|
       |       | source             |               | key (PK)         |
       |       | data (JSONB)       |               | value            |
       |       +--------------------+               +------------------+
       |
       +-----> +--------------------+
               |   ingest_log       |
               |--------------------|
               | id (PK)            |
               | source_type        |
               | source_ref         |
               | pages_updated      |
               | summary            |
               +--------------------+
```

Indexes:
- `pages.slug`: UNIQUE constraint (implicit B-tree)
- `pages.type`: B-tree
- `pages.search_vector`: GIN (full-text search)
- `pages.frontmatter`: GIN (JSONB queries)
- `pages.title`: GIN with pg_trgm (fuzzy slug resolution)
- `content_chunks.embedding`: HNSW with cosine ops (vector search)
- `content_chunks.page_id`: B-tree
- `links.from_page_id`, `links.to_page_id`: B-tree
- `tags.tag`, `tags.page_id`: B-tree
- `timeline_entries.page_id`, `timeline_entries.date`: B-tree

## Search architecture

```
Query: "when should you ignore conventional wisdom?"
           |
           v
+---------------------+
| Multi-query expansion|
| (Claude Haiku)       |
| "contrarian thinking"
| "going against the crowd"
+---------------------+
     |   |   |
     v   v   v
  [embed all 3 queries]
     |   |   |
     +---+---+
         |
    +----+----+
    |         |
    v         v
+--------+ +--------+
| Vector | | Keyword|
| Search | | Search |
| (HNSW  | | (tsv + |
| cosine)| | ts_rank)|
+--------+ +--------+
    |         |
    +----+----+
         |
         v
+------------------+
| RRF Fusion       |
| score = sum(     |
|   1/(60 + rank)) |
+------------------+
         |
         v
+------------------+
| 4-Layer Dedup    |
| 1. By source     |
| 2. Cosine > 0.85 |
| 3. Type cap 60%  |
| 4. Per-page max  |
+------------------+
         |
         v
+------------------+
| Stale alerts     |
| (compiled_truth  |
|  older than      |
|  latest timeline)|
+------------------+
         |
         v
     [Results]
```

## Chunking strategies

| Strategy | Input | Algorithm | When to use |
|----------|-------|-----------|-------------|
| Recursive | Any text | 5-level delimiter hierarchy (paragraphs > lines > sentences > clauses > whitespace). 300-word chunks, 50-word overlap. | Timeline (predictable format), bulk import |
| Semantic | Quality text | Embed each sentence, Savitzky-Golay filter for topic boundaries, cosine similarity minima. Falls back to recursive. | Compiled truth (intelligence assessments) |
| LLM-guided | High-value text | Pre-split to 128-word candidates, Claude Haiku finds topic shifts in sliding windows. 3 retries per window. | Explicitly requested via `--chunker llm` |

Dispatch: compiled_truth gets semantic chunker. Timeline gets recursive chunker. Override with `--chunker` flag or `chunk_strategy` in frontmatter.

## Skills (fat markdown, no code)

Each skill is a markdown file that AI agents (Claude Code, OpenClaw) read and follow. The skill contains the workflow, heuristics, and quality rules. No skill logic is in the binary.

| Skill | What it does |
|-------|-------------|
| `skills/ingest/SKILL.md` | Ingest meetings, docs, articles. Update compiled truth, append timeline, create links. |
| `skills/query/SKILL.md` | 3-layer search (FTS + vector + structured). Synthesize answer with citations. |
| `skills/maintain/SKILL.md` | Find contradictions, stale info, orphans, dead links, tag inconsistency. |
| `skills/enrich/SKILL.md` | Enrich from external APIs (Crustdata, Happenstance, Exa). Store raw data, distill to compiled truth. |
| `skills/briefing/SKILL.md` | Daily briefing: meetings with context, active deals, open threads. |
| `skills/migrate/SKILL.md` | Universal migration from Obsidian, Notion, Logseq, plain markdown, CSV, JSON, Roam. |

## CEO scope expansions (accepted for v0)

1. **CLI/MCP parity with drift tests.** Both interfaces are thin wrappers over the engine. Tests assert identical output.
2. **Smart slug resolution.** Fuzzy matching via pg_trgm for reads. Writes require exact slugs. `gbrain get "dont scale"` resolves to `concepts/do-things-that-dont-scale`.
3. **Brain health dashboard.** `gbrain health` shows page count, embed coverage, stale pages, orphans, dead links.
4. **Normalized timeline.** `timeline_entries` table only (no TEXT column). `detail` field supports markdown.
5. **Page version control.** `page_versions` table stores full snapshots (compiled_truth + frontmatter + links + tags). `gbrain history`, `gbrain diff`, `gbrain revert` commands. Revert re-chunks and re-embeds.
6. **Typed links + graph traversal.** `link_type` column (knows, invested_in, works_at, etc.). `gbrain graph` uses recursive CTE with max depth (default 5, configurable via `--depth`).
7. **Trigger.dev data cleanup jobs.** Daily embed backfill, weekly stale detection + orphan audit + tag consistency.
8. **Stale alert annotations.** Search results flag pages where compiled_truth is older than latest timeline entry.
9. **Timeline merge on ingest.** Same event created across all mentioned entities.

## Security model (v0)

Single-user, local-only:
- Supabase service role key in `~/.gbrain/config.json` (0600 permissions)
- MCP stdio transport is inherently local (client spawns `gbrain serve` as subprocess)
- No multi-user, no RLS, no OAuth in v0
- Multi-user path (future): Supabase RLS + per-user API keys

## Upgrade mechanism

`gbrain upgrade` detects the installation method and updates accordingly:

| Path | How |
|------|-----|
| npm | `bun update gbrain` (or npm equivalent) |
| Compiled binary | Download new binary to temp dir, atomic rename swap, exec new process |
| ClawHub | `clawhub update gbrain` |

Version check: compare local version against latest GitHub release tag.

## Storage and cost estimates

### Storage (~750MB for 7,471 pages)

| Component | Size |
|-----------|------|
| Page text (compiled_truth + timeline) | ~150MB |
| JSONB frontmatter | ~20MB |
| tsvector + GIN indexes | ~50MB |
| Content chunks (~22K, text) | ~80MB |
| Embeddings (22K x 1536 floats x 4 bytes) | ~134MB |
| HNSW index overhead (~2x embeddings) | ~270MB |
| Links, tags, timeline, raw_data, versions | ~50MB |
| **Total** | **~750MB** |

Supabase free tier (500MB) won't fit. Supabase Pro ($25/mo, 8GB) is the starting point.

### Embedding cost (~$4-5 for initial import)

| Step | Cost |
|------|------|
| Semantic chunker sentence embeddings (~374K sentences) | ~$1 |
| Chunk embeddings (~22K chunks) | ~$0.30 |
| Query expansion (per query, ~3 embeds) | negligible |
| **Total initial import** | **~$4-5** |

Budget alternative: `gbrain import --chunker recursive` skips sentence-level embeddings, then `gbrain embed --rechunk --chunker semantic` upgrades later.

## Serverless operations stack

```
+------------------+     +------------------+     +------------------+
|    Supabase      |     |    Vercel         |     |   Trigger.dev    |
|  (Postgres +     |     |  (web/API,        |     |  (background     |
|   pgvector)      |     |   optional)       |     |   jobs)          |
+------------------+     +------------------+     +------------------+
| Database         |     | Future web UI     |     | Embed backfill   |
| Connection pool  |     | API endpoints     |     | Stale detection  |
| pgvector HNSW    |     | Edge functions    |     | Orphan audit     |
| tsvector FTS     |     |                   |     | Tag consistency  |
| pg_trgm fuzzy    |     |                   |     | Daily briefing   |
+------------------+     +------------------+     +------------------+
```

The CLI connects directly to Supabase Postgres. Trigger.dev and Vercel are for async/scheduled work. The CLI works without them.

## Verification checklist

1. `gbrain import /data/brain/` migrates all 7,471 files losslessly
2. `gbrain export` round-trips to semantically identical markdown
3. `gbrain query "what does PG say about doing things that don't scale?"` returns relevant hybrid search results
4. `gbrain serve` starts MCP server connectable by Claude Code
5. All 3 chunkers produce correct output with test fixtures
6. `gbrain init --supabase` works end-to-end
7. `bun test` passes all tests
8. `clawhub install gbrain` installs the skill and runs guided setup
9. `bun add gbrain` + `import { PostgresEngine } from 'gbrain'` works in external project
10. Drift tests pass: CLI and MCP produce identical results
11. `gbrain health` outputs accurate brain health metrics
12. Migration skill successfully imports an Obsidian vault

## Future plans

See `docs/ENGINES.md` for the pluggable engine architecture and future backend plans.

### v1 candidates (deferred from v0)

- **`gbrain ask` natural language CLI alias.** Trivial to add. P1 TODO.
- **Intelligence compiler.** Treat every fact as a first-class claim with source span, entity links, validity window, confidence, and contradiction status. "What changed, why, and what evidence would flip it again?" From Codex review. Builds on compiled truth model.
- **Active skills via Trigger.dev.** Application-specific briefings, meeting prep. Belongs in OpenClaw, not generic brain infra.
- **Multi-user access.** Supabase RLS + per-user API keys. v0 is single-user.
- **SQLite engine.** Community PRs welcome. See `docs/SQLITE_ENGINE.md`.
- **Docker Compose for self-hosted Postgres.** Community PRs welcome.
- **Web UI.** Optional Vercel-hosted dashboard for browsing brain pages.

### Interface abstraction principle

All operations go through `BrainEngine`. The engine interface is the contract. Postgres-specific features (tsvector, pgvector HNSW, pg_trgm, recursive CTEs) are implementation details inside `PostgresEngine`. The interface exposes capabilities, not SQL.

This means:
- A SQLite engine can implement `searchKeyword` using FTS5 instead of tsvector
- A SQLite engine can implement `searchVector` using sqlite-vss instead of pgvector
- A future DuckDB engine could implement analytics-heavy workloads
- The CLI, MCP server, and library consumers never know which engine runs underneath

See `docs/ENGINES.md` for the full interface spec and `docs/SQLITE_ENGINE.md` for the SQLite implementation plan.

## Review history

| Review | Runs | Status | Key findings |
|--------|------|--------|-------------|
| /office-hours | 1 | APPROVED | Builder mode. Full port approach chosen. |
| /plan-ceo-review | 1 | CLEAR | 11 proposals, 10 accepted, 1 deferred. SCOPE EXPANSION mode. |
| /codex review | 1 | issues_found | 24 points challenged, 3 accepted (fuzzy slug, revert spec, tsvector). |
| /plan-eng-review | 2 | CLEAR | 3 issues (upgrade paths, import guardrails, init wizard), 0 critical gaps. |
| /plan-devex-review | 1 | CLEAR | DX score 5/10 to 7/10. TTHW 25min to 90s. Champion tier. |
