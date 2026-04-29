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

# E2E tests (requires Postgres with pgvector)
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# Or use your own Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

`bun run test:e2e` runs through `scripts/run-e2e.sh`, which isolates `HOME` and
`GBRAIN_HOME` to a tmpdir so test paths that call gbrain init / saveConfig cannot
clobber your real `~/.gbrain/config.json`. The wrapper exits **2** (vs 1 for a normal
test failure) if it detects a write to your real config after the run. Do not
override `HOME` or `GBRAIN_HOME` when running this script. If you bypass the wrapper
and run a single E2E file with `bun test test/e2e/...` directly, set them to a
tmpdir yourself first.

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
