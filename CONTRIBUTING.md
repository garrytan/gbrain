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
# Recommended: full CI guard chain + tests (matches what CI runs)
bun run test                      # privacy + jsonb + progress + wasm + typecheck + bun test

# Just the test runner (skips CI guards)
bun test                          # all tests (unit + E2E skipped without DB)
bun test test/markdown.test.ts    # specific unit test

# E2E tests (requires Postgres with pgvector)
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# Or use your own Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

Use `bun run test` before pushing. The guard chain catches: banned fork-name leaks
(`scripts/check-privacy.sh`), `JSON.stringify(x)::jsonb` interpolation patterns
(`scripts/check-jsonb-pattern.sh`), `\r` progress bleed to stdout
(`scripts/check-progress-to-stdout.sh`), trailing-newline drift across tracked
files (`scripts/check-trailing-newline.sh`), and silent fallback to recursive
chunking in the compiled binary (`scripts/check-wasm-embedded.sh`).

### Local CI gate (recommended before pushing, v0.23.1+)

```bash
bun run ci:local         # full gate: gitleaks + unit + ALL 29 E2E files (sequential)
bun run ci:local:diff    # gate with diff-aware E2E selector
bun run ci:select-e2e    # print which E2E files the selector would run
```

`ci:local` spins up `pgvector/pgvector:pg16` + `oven/bun:1` via
`docker-compose.ci.yml`, runs everything PR CI runs plus the full E2E suite, then
tears down. Named volumes keep the install warm across runs (~16-20 min sequential
E2E after the first cold pull). Requires Docker (Docker Desktop, OrbStack, or
Colima) and `gitleaks` on host (`brew install gitleaks`). Override the postgres
host port with `GBRAIN_CI_PG_PORT=5435 bun run ci:local` if 5434 collides.

Fail-closed selector: an unmapped `src/` change runs all 29 E2E files. Hand-tune
narrower mappings via `scripts/e2e-test-map.ts`.

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
