# Contributing to GBrain

## Setup

```bash
git clone https://github.com/garrytan/gbrain.git
cd gbrain
bun install
bun test
```

Requires Bun 1.0+.

### Windows

`bun run test`, `verify`, `ci:local` and `test:e2e` all dispatch through bash, so
the shell scripts under `scripts/` must be checked out with Unix line endings.
The root `.gitattributes` pins `*.sh text eol=lf`, which overrides the
`core.autocrlf=true` that Git for Windows installs by default. A fresh clone is
correct with no extra steps.

`.gitattributes` pins `*.md text eol=lf` for the same reason. The frontmatter
readers anchor on a `---` fence followed by a Unix line ending, so a CRLF
checkout makes a well-formed document parse as having no frontmatter. That
failure is silent: no error, the field just comes back empty.

If you cloned before either pin existed, your working copy still has the old
Windows line endings. Bash will fail with `$'\r': command not found`, and
frontmatter will read as absent. Refresh it once, from the repository root:

```bash
git rm --cached -r . -q
git reset --hard
bash -n scripts/run-unit-parallel.sh          # silence means bash can read the scripts
git ls-files --eol -- '*.md' | grep -cE 'w/(crlf|mixed)' # 0 means Markdown is clean
```

Every `check:*` entry in `package.json` invokes its script as `bash scripts/<name>.sh`
rather than relying on the shebang, because bun on Windows cannot exec a `.sh`
directly. Keep that prefix when you add a new shell-script check.

## Project structure

```
src/
  cli.ts                  CLI entry point
  commands/               CLI-only commands (init, upgrade, import, export, etc.)
    doctor.ts             gbrain doctor façade (buildChecks/runDoctor/output)
    doctor/               Peeled doctor modules: checks/* bundles + tail clusters
    sync.ts               gbrain sync CLI + performSync/performFullSync
  core/
    operations.ts         Operation contract assembly (façade over ops/)
    ops/                  Contract types + security fences + the op domain modules
    engine.ts             BrainEngine interface
    engine-factory.ts     Engine factory (dynamic import of the configured engine)
    postgres-engine.ts    Postgres + pgvector implementation (façade)
    postgres-engine/      Narrow-deps engine modules (facts, takes, code-edges, salience)
    pglite-engine.ts      PGLite (embedded Postgres via WASM) implementation (façade)
    pglite-engine/        Narrow-deps engine modules (facts, takes, code-edges, salience)
    db.ts                 Connection management + schema loader
    import-file.ts        Import pipeline (chunk + embed + tags)
    sync-*.ts             Peeled sync clusters (cost-gate, git, anchor, lock, reconcile, status-report, ...)
    types.ts              TypeScript types
    markdown.ts           Frontmatter parsing
    config.ts             Config file management
    storage.ts            Pluggable storage interface
    storage/              Storage backends (S3, Supabase, local)
    supabase-admin.ts     Supabase admin API
    file-resolver.ts      MIME detection + content hashing
    migrate.ts            Migration helpers
    bootstrap/            Agent-bootstrap flow (interview, hooks, repo, verify)
    yaml-lite.ts          Lightweight YAML parser
    chunkers/             3-tier chunking (recursive, semantic, llm)
    search/               Hybrid search (vector, keyword, hybrid, expansion, dedup)
    embedding.ts          Embedding service (provider-routed; Voyage default)
  mcp/
    server.ts             MCP stdio server (generated from operations)
    http-transport.ts     HTTP MCP transport (OAuth, body caps)
    dispatch.ts           Op dispatch + scope enforcement + param redaction
    rate-limit.ts         Rate limiting
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

Per-file invariants live in `docs/architecture/KEY_FILES.md` — read a file's entry
before editing it.

## Running tests

The canonical reference for test tiers, isolation rules, timing, and the E2E
lifecycle is [`docs/TESTING.md`](docs/TESTING.md). The short version:

```bash
# Inner edit loop (~8min full suite on a Mac dev box; single files in seconds)
bun run test                      # parallel 4-shard fan-out (memory-adaptive) + serial post-pass; PGLite snapshot default-on
bun test test/markdown.test.ts    # specific unit test

# Pre-push gate (50+ parallel checks + typecheck)
bun run verify

# Pre-merge sanity (everything CI runs)
bun run test:full                 # verify + parallel unit + slow + smart e2e

# Slow / serial / e2e in isolation
bun run test:slow                 # *.slow.test.ts only (cold-path correctness)
bun run test:serial               # *.serial.test.ts only (pooled per-file processes, heaviest-first)
bun run test:e2e                  # real-Postgres E2E (requires DATABASE_URL)

# E2E setup (Postgres with pgvector)
docker compose -f docker-compose.test.yml up -d
DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e

# Or use your own Postgres / Supabase
DATABASE_URL=postgresql://... bun run test:e2e
```

Heads-up: a bare `bun test` refuses to start while `DATABASE_URL` or
`GBRAIN_DATABASE_URL` is set in your environment — some tests run destructive
SQL against whatever those URLs point at. Unset the variable for unit runs
(they need no database) or use the wrappers: the unit/slow runners strip the
variables at their boundary, and `bun run test:e2e` opts in at its own. The
refusal message walks you through it; details in
[`docs/TESTING.md`](docs/TESTING.md) ("Database-URL run guard"). If you point
`bun run test:e2e` at your own Postgres or Supabase, a second floor applies:
the database name must carry "test" as a word segment (like `gbrain_test`
above) or destructive tests refuse to run — opt a differently-named database
in one-shot with `GBRAIN_E2E_ALLOW_DB=<name>`.

Use `bun run verify` before pushing. It runs 50+ guard checks in parallel
(`scripts/run-verify-parallel.sh`), including: banned fork-name leaks
(`scripts/check-privacy.sh`), `JSON.stringify(x)::jsonb` interpolation
patterns (`scripts/check-jsonb-pattern.sh`), `\r` progress bleed to stdout
(`scripts/check-progress-to-stdout.sh`), test-isolation rule violations
(`scripts/check-test-isolation.sh` — see "Writing tests that survive the parallel
loop" below), silent fallback to recursive chunking in the compiled binary
(`scripts/check-wasm-embedded.sh`), stale admin-dashboard build artifacts
(`scripts/check-admin-build.sh`), resolver drift on bundled skills
(`bun run check:resolver`), and typecheck. The guard REGISTRY is
`scripts/guards-manifest.tsv`, and `scripts/guard-self-test.sh` (also in
`verify`) proves each self-tested scanner guard (`selftest=yes` in the
manifest; coverage ratchets up from the `todo` rows) can actually fail by
running it against known-bad fixtures — a new `scripts/check-*` guard must be
registered in the manifest or the build fails. There is no `check:all` script; the
trailing-newline, exports-count, and no-legacy-getconnection checks run in
`verify` with everything else.

### Writing tests that survive the parallel loop

`bun run test` shards 1000+ unit-test files across up to 4 worker processes,
capping total concurrency (shards × intra-shard files) to available memory and
re-running OOM-killed or externally-killed files serially before calling them
failures (see `docs/TESTING.md` for the rescue-pass details and knobs). Files
in the same shard share a process, so process-global state leaks between them.
Four lint rules (`scripts/check-test-isolation.sh`, R1–R4) enforce isolation:
no direct `process.env` mutation (use `withEnv()` from
`test/helpers/with-env.ts`), no `mock.module(...)` outside `*.serial.test.ts`,
and every `new PGLiteEngine(` goes inside the canonical `beforeAll` block with
a paired `afterAll(disconnect)`.

**The full rules, the canonical PGLite block, the `withEnv` pattern, and the
`*.serial.test.ts` quarantine policy live in
[`docs/TESTING.md`](docs/TESTING.md#test-isolation-lint-and-helpers)
— read that before writing a new test file.** Files that predate the rules are
listed in `scripts/check-test-isolation.allowlist`; the allow-list MUST shrink
over time — never add new entries.

### Discrimination test — required for every fix (#3665)

A fix's test is only worth anything if it **fails without the fix**. A test
that passes both ways is worse than no test: it inflates reviewer confidence,
gets weighted into the CI shards forever, and keeps passing after a future
refactor silently breaks the behavior. (An adversarial review pass found PRs
where 7 of 8 new tests passed on master.)

Every PR that fixes behavior must fill the **Discrimination test** field in
the PR template with the actual result of checking this:

> Discrimination test: reverted `<source file(s)>` to `<ref>`, ran
> `<test file>` → `N pass / M fail`. Restored → all pass.

The helper does the whole dance in one command:

```bash
bash scripts/check-test-discriminates.sh <test-file> <source-file> [<source-file>...]
```

It reverts the source files to the pre-fix state (plain file copies, no git
stash), runs the test file, requires at least one EXECUTED test to fail —
exit ≠ 0 alone does not count, because a missing file or import crash also
exits non-zero (exit 3, the vacuous-failure class) — restores, and prints the
paste-ready field line. Exit 1 means the test passed with the fix reverted:
tighten the assertions before asking for review.

Vacuous-assertion shapes to avoid (they recur):
- asserting only `exit ≠ 0` (a missing binary also exits non-zero);
- asserting membership in a set that covers every reachable value
  (`['warn','fail']` when those are the only outputs);
- asserting a substring that would also appear in the broken output —
  assert parsed structure instead.

Relatedly: a test whose only assertion is a regex over `readFileSync`'d
source text pins spelling, not behavior. New tests that read `src/` text
need a `test-reads-source-ok: <why>` comment (or a behavioral assertion
alongside); `test/test-reads-source-smell.test.ts` enforces this for new
files and ratchets the pre-existing list down.

### Local CI gate (recommended before pushing)

```bash
bun run ci:local         # full gate: gitleaks + guards/typecheck + 4-shard parallel unit + E2E
bun run ci:local:diff    # gate with diff-aware E2E selector
bun run ci:select-e2e    # print which E2E files the selector would run
```

`ci:local` spins up four pgvector services plus a transaction-mode PgBouncer via
`docker-compose.ci.yml`, runs everything PR CI runs plus the full E2E suite
sharded 4 ways in parallel, then tears down. Named volumes keep the install warm
across runs. Requires Docker (Docker Desktop, OrbStack, or Colima) and `gitleaks`
on host (`brew install gitleaks`). Override the postgres host port with
`GBRAIN_CI_PG_PORT=5435 bun run ci:local` if 5434 collides.

Fail-closed selector: an unmapped `src/` change runs ALL E2E files. Hand-tune
narrower mappings via `scripts/e2e-test-map.ts`.

### PR-side security checks

Besides the test gate, PRs may trigger three security workflows: Semgrep CE
SAST (every PR — **blocking for findings new since the PR base**, so a net-new
issue fails the check while pre-existing findings never block an unrelated PR;
scheduled/dispatch runs do a full-tree report-only scan), OSV-Scanner (only when
`package.json` or `bun.lock` change), and actionlint (only when
`.github/workflows/**` change). See `SECURITY.md` → "Automated security
scanning" for details.

## Building

```bash
bun build --compile --outfile bin/gbrain src/cli.ts
```

## Adding a new operation

GBrain uses a contract-first architecture. Add your operation to one domain module
and it automatically appears in the CLI, MCP server, and tools-json:

1. Add your operation to the matching domain module under `src/core/ops/`
   (`pages.ts`, `search.ts`, `takes.ts`, `jobs.ts`, ... — define params, handler,
   cliHints there). `src/core/operations.ts` is the assembly façade that spreads
   every domain module into the single `operations` array: a new op in an existing
   domain needs no façade change; a brand-new domain module gets one spread line
   in `operations.ts`. Shared contract types live in `src/core/ops/contract.ts`,
   the security/scope fences in `src/core/ops/context.ts`.
2. Add tests
3. That's it. The CLI, MCP server, and tools-json are generated from operations.

For CLI-only commands (init, upgrade, import, export, files, embed, doctor, sync):
1. Create `src/commands/mycommand.ts`
2. Add the case to `src/cli.ts`
3. Regenerate the flag registry: `bun run build:flag-registry`. The CLI rejects
   unknown flags before dispatch; each CLI-only command's legal flag set is
   derived from its source into `src/core/cli-flag-registry.generated.ts`.
   `test/cli-flag-validation.test.ts` pins registry freshness, drift, and
   consumption evidence (a safety flag like `--dry-run` may only be advertised
   if the command's code actually reads it), so a stale registry fails the
   build. At runtime a missing registry entry fails open — a forgotten regen
   never bricks a command. Rerun the regen whenever you add or remove a flag
   on an existing command, too.

Parity tests (`test/parity.test.ts`) verify CLI/MCP/tools-json stay in sync.

## Adding a new engine

See `docs/ENGINES.md` for the full guide. In short:

1. Create `src/core/myengine-engine.ts` implementing `BrainEngine`
2. Add to the engine factory in `src/core/engine-factory.ts`
3. Run the test suite against your engine
4. Document in `docs/`

The original SQLite engine plan was superseded by PGLite (embedded Postgres 17 via WASM), which uses the same SQL dialect as Postgres and eliminates the need for a separate FTS5/sqlite-vss translation layer. See [`docs/ENGINES.md`](docs/ENGINES.md) for the engine architecture and the rationale.

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
- `src/core/search/query-intent.ts`, `expansion.ts`, `dedup.ts`
- `src/core/embedding.ts`
- `src/core/ops/search.ts` (query / search op handlers)
- `src/core/postgres-engine.ts` / `pglite-engine.ts` (searchKeyword /
  searchVector SQL)

See [`docs/eval-bench.md`](./docs/eval-bench.md) for the full guide
including CI integration, hand-crafted NDJSON corpora (so a fresh checkout
without captured data can still replay), and cost considerations. The
NDJSON wire format is documented in
[`docs/eval-capture.md`](./docs/eval-capture.md).

For public benchmark coverage on top of replay, `gbrain eval longmemeval
<dataset.jsonl>` runs LongMemEval against gbrain's hybrid
retrieval. One in-memory PGLite per question, runtime-enumerated
`TRUNCATE` between questions, ground-truth scoring via LongMemEval's
published `evaluate_qa.py`. Use it alongside replay when changes affect
retrieval quality on long-context conversational data — replay catches
regressions on YOUR queries, LongMemEval catches them on a public set the
benchmark community already cites. See the "Public benchmarks: LongMemEval"
section in [`docs/eval-bench.md`](./docs/eval-bench.md).

## Shipping

Releases go through the `/ship` skill, never hand-rolled. The full release +
contributor process (CHANGELOG voice, version-locations sync, PR conventions,
community-PR-wave workflow) lives in [`docs/RELEASING.md`](docs/RELEASING.md).
Community PRs are batched into release waves rather than merged one-by-one;
contributor attribution stays attached via `Co-Authored-By:` trailers and every
accepted contribution is credited in `CHANGELOG.md`.

## Welcome PRs

- Additional engine implementations (see [`docs/ENGINES.md`](docs/ENGINES.md))
- Docker Compose for self-hosted Postgres
- Additional migration sources
- New enrichment API integrations
- Performance optimizations
