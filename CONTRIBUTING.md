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
# Inner edit loop (~85s on a Mac dev box, 3700+ unit tests)
bun run test                      # parallel 8-shard fan-out + serial post-pass
bun test test/markdown.test.ts    # specific unit test

# Pre-push gate (matches what CI runs on shard 1 + typecheck)
bun run verify                    # privacy + jsonb + progress + test-isolation + wasm + admin-build + typecheck

# Pre-merge sanity (everything CI runs)
bun run test:full                 # verify + parallel unit + slow + smart e2e

# Slow / serial / e2e in isolation
bun run test:slow                 # *.slow.test.ts only (cold-path correctness)
bun run test:serial               # *.serial.test.ts only (--max-concurrency=1)
bun run test:e2e                  # real-Postgres E2E (requires DATABASE_URL)

# E2E setup (Postgres with pgvector)
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# Or use your own Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

Use `bun run verify` before pushing. The guard chain catches: banned fork-name
leaks (`scripts/check-privacy.sh`), `JSON.stringify(x)::jsonb` interpolation
patterns (`scripts/check-jsonb-pattern.sh`), `\r` progress bleed to stdout
(`scripts/check-progress-to-stdout.sh`), test-isolation rule violations
(`scripts/check-test-isolation.sh` — see "Writing tests that survive the parallel
loop" below), silent fallback to recursive chunking in the compiled binary
(`scripts/check-wasm-embedded.sh`), and stale admin-dashboard build artifacts
(`scripts/check-admin-build.sh`). `bun run check:all` runs the full historical
sweep including the trailing-newline and exports-count checks.

### Writing tests that survive the parallel loop

`bun run test` shards 92+ unit-test files across 8 worker processes. Files in the
same shard share a process, so process-global state leaks between them. Four
lint rules (`scripts/check-test-isolation.sh`, R1-R4) enforce isolation:

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | Direct `process.env.X = ...` mutation | Use `withEnv()` from `test/helpers/with-env.ts`, or rename to `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | Rename to `*.serial.test.ts` |
| **R3** | `new PGLiteEngine(` outside ~50 lines after `beforeAll(` | Use the canonical PGLite block (see below) |
| **R4** | `new PGLiteEngine(` without paired `afterAll(disconnect)` | Add the `afterAll(() => engine.disconnect())` |

Canonical PGLite block (R3 + R4 compliant — paste this verbatim):

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await resetPgliteState(engine); });
```

Env-touching tests:

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});
```

`withEnv` saves and restores keys via try/finally including when the callback
throws. Cross-test safe; **NOT** intra-file concurrent-safe (`process.env` is
process-global). Files using `withEnv` stay outside the future
`test.concurrent()` codemod's eligibility filter.

When to quarantine instead of fix: rename to `*.serial.test.ts` if the file
uses `mock.module(...)`, is genuinely env-coupled (module-load env readers +
ESM caching defeat dynamic-import-after-env tricks), or intentionally shares
state across `it()` boundaries. Quarantine count cap: 10 (informational).

Files that violated these rules at the v0.26.7 baseline are listed in
`scripts/check-test-isolation.allowlist`. **The allow-list MUST shrink over
time** ... never add new entries. v0.26.8 (env sweep) and v0.26.9 (PGLite sweep
+ codemod) remove entries as files get fixed.

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

## CONTRIBUTOR_MODE — turn on the dev loop

gbrain captures retrieval traffic so you can replay real queries against
your code changes before merging. **This is off by default** (production
users get a quiet brain, no surprise data accumulation). Contributors turn
it on with one shell rc line:

```bash
# In ~/.zshrc or ~/.bashrc:
export GBRAIN_CONTRIBUTOR_MODE=1
```

That's it. Every `query` / `search` you (or agents pointed at your dev
brain) run from that shell now writes a row to `eval_candidates`, and the
[replay tool](#running-real-world-eval-benchmarks-touching-retrieval-code)
has data to work against.

What CONTRIBUTOR_MODE actually does:

- Turns on `query`/`search` capture into the local `eval_candidates` table.
  Without it the gate is closed and capture is a no-op.
- That's all. PII scrubbing, retention, and replay are independent.

Resolution order (most explicit wins):

1. `eval.capture: true` in `~/.gbrain/config.json` → on
2. `eval.capture: false` in `~/.gbrain/config.json` → off
3. `GBRAIN_CONTRIBUTOR_MODE=1` → on
4. otherwise → off

Quick check that capture is actually running:

```bash
gbrain query "anything" >/dev/null
psql $DATABASE_URL -c 'SELECT count(*) FROM eval_candidates'
# (or `gbrain doctor` — surfaces silent capture failures cross-process)
```

To disable capture even with the env var set, write
`{"eval": {"capture": false}}` to `~/.gbrain/config.json` — explicit config
beats the env var both directions.

## Running real-world eval benchmarks (touching retrieval code)

If your PR touches retrieval — search ranking, RRF fusion, embeddings,
intent classification, query expansion, source boost, or the `query` /
`search` op handlers — run `gbrain eval replay` against a snapshot of
real traffic before merging. Requires `CONTRIBUTOR_MODE` (above) so you
have captured rows to replay against.

Quick loop:

```bash
gbrain eval export --since 7d > baseline.ndjson    # snapshot before your change
# ... make your change ...
gbrain eval replay --against baseline.ndjson       # diff retrieval, get Jaccard@k
```

Three numbers come back: mean Jaccard@k between captured and current slug
sets, top-1 stability, and mean latency Δ. The replay tool flags the worst
regressions so you can eyeball whether the change is hurting real queries.

Trigger paths (rerun if your diff touches any of these):

- `src/core/search/hybrid.ts`
- `src/core/search/source-boost.ts`, `sql-ranking.ts`
- `src/core/search/intent.ts`, `expansion.ts`, `dedup.ts`
- `src/core/embedding.ts`
- `src/core/operations.ts` (query / search handlers)
- `src/core/postgres-engine.ts` / `pglite-engine.ts` (searchKeyword /
  searchVector SQL)

See [`docs/eval-bench.md`](./docs/eval-bench.md) for the full guide
including CI integration, hand-crafted NDJSON corpora (so a fresh checkout
without captured data can still replay), and cost considerations. The
NDJSON wire format is documented in
[`docs/eval-capture.md`](./docs/eval-capture.md).

## Welcome PRs

- SQLite engine implementation
- Docker Compose for self-hosted Postgres
- Additional migration sources
- New enrichment API integrations
- Performance optimizations
