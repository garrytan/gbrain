# Contributing to GBrain

## Setup

```bash
git clone https://github.com/garrytan/gbrain.git
cd gbrain
bun install
bun test
```

Requires Bun 1.0+.

## Project structure

```
src/
  cli.ts                  CLI entry point
  commands/               CLI-only commands (init, upgrade, import, export, etc.)
  core/
    operations.ts         Contract-first operation definitions (the foundation)
    engine.ts             BrainEngine interface
    postgres-engine.ts    Postgres implementation
    db.ts                 Connection management + schema loader
    import-file.ts        Import pipeline (chunk + embed + tags)
    types.ts              TypeScript types
    markdown.ts           Frontmatter parsing
    config.ts             Config file management
    storage.ts            Pluggable storage interface
    storage/              Storage backends (S3, Supabase, local)
    supabase-admin.ts     Supabase admin API
    file-resolver.ts      MIME detection + content hashing
    migrate.ts            Migration helpers
    yaml-lite.ts          Lightweight YAML parser
    chunkers/             3-tier chunking (recursive, semantic, llm)
    search/               Hybrid search (vector, keyword, hybrid, expansion, dedup)
    embedding.ts          OpenAI embedding service
  mcp/
    server.ts             MCP stdio server (generated from operations)
  action-brain/           Action Brain extension (commitment/obligation tracking)
    types.ts              Shared types (ActionItem, CommitmentBatch, ExtractionResult, ActionDraft)
    action-schema.ts      PGLite DDL + schema init for action_items/action_history/action_drafts tables
    action-engine.ts      Storage layer: CRUD, priority scoring, draft CRUD, atomic status helpers
    extractor.ts          LLM commitment extraction with prompt injection defense
    brief.ts              Morning priority brief with inline draft/failure rendering
    draft-generator.ts    Draft generation: context hash validation, trust-boundary, two-tier LLM
    context-source.ts     Bounded draft context sourcing (caps message count, scopes entity history)
    context.ts            Shared context snapshot types
    sanitize.ts           Input sanitization for LLM prompts (strips control/XML chars, length caps)
    operations.ts         Action Brain CLI + MCP ops: list/brief/resolve/mark-fp/ingest + draft subcommands
  schema.sql              Postgres DDL
skills/                   Fat markdown skills for AI agents
test/                     Unit tests (bun test, no DB required)
test/e2e/                 E2E tests (requires DATABASE_URL, real Postgres+pgvector)
  fixtures/               Miniature realistic brain corpus (16 files)
  helpers.ts              DB lifecycle, fixture import, timing
  mechanical.test.ts      All operations against real DB
  mcp.test.ts             MCP tool generation verification
  skills.test.ts          Tier 2 skill tests (requires OpenClaw + API keys)
docs/                     Architecture docs
```

## Running tests

```bash
bun test                          # all tests (unit + E2E skipped without DB)
bun test test/markdown.test.ts    # specific unit test
bun test test/action-brain/gold-set.test.ts       # Action Brain recall gate (GIT-175)
bun test test/action-brain/draft-gold-set.test.ts # Draft quality gold-set gate (GIT-1064)

# E2E tests (requires Postgres with pgvector)
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# Or use your own Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

### Action Brain private gold-set contract

`test/action-brain/gold-set.test.ts` always runs a checked-in 13-message fixture and
enforces recall `>= 0.90` for the extractor path. For local validation against the
private 50+ message corpus, set:

```bash
ACTION_BRAIN_PRIVATE_GOLD_SET_PATH=/absolute/path/to/private-gold-set.jsonl
```

Contract for that private file:
- JSONL format with one object per line
- each row includes `id`, `message`, `expectedCommitments`, `baselineCommitments`
- at least 50 rows (kept outside this repository; never committed)

## Building

```bash
bun build --compile --outfile bin/gbrain src/cli.ts
```

## Adding a new operation

GBrain uses a contract-first architecture. Add your operation to one file and it
automatically appears in the CLI, MCP server, and tools-json:

1. Add your operation to `src/core/operations.ts` (define params, handler, cliHints)
2. Add tests
3. That's it. The CLI, MCP server, and tools-json are generated from operations.

For CLI-only commands (init, upgrade, import, export, files, embed, doctor, sync):
1. Create `src/commands/mycommand.ts`
2. Add the case to `src/cli.ts`

Parity tests (`test/parity.test.ts`) verify CLI/MCP/tools-json stay in sync.

## Adding a new engine

See `docs/ENGINES.md` for the full guide. In short:

1. Create `src/core/myengine-engine.ts` implementing `BrainEngine`
2. Add to engine factory in `src/core/engine.ts`
3. Run the test suite against your engine
4. Document in `docs/`

The SQLite engine is designed and ready for implementation. See `docs/SQLITE_ENGINE.md`.

## Welcome PRs

- SQLite engine implementation
- Docker Compose for self-hosted Postgres
- Additional migration sources
- New enrichment API integrations
- Performance optimizations
