# TypeScript test suites as a parity oracle

Line numbers refer to gbrain 36bd05806a.

Scope: gbrain v0.60.733.0 (commit 36bd05806a) at `garrytan/gbrain`, read only. Nothing was run; all counts come from `find`/`rg` over the checkout this session. "Verified" means read or counted in code or docs. "Inferred" means drawn from names, headers or docs without running the test.

## 1. Headline numbers (verified)

- 6,486 `*.test.ts` files under `test/` (6,489 repo-wide; the 3 extra sit outside `test/`).
- About 53,100 `test(`/`it(` call sites by regex. Approximate: nested `describe` and `.each` expansion are not counted.
- Disjoint tier buckets, by precedence (e2e directory, then `.serial`, `.slow`, `.live`, unit remainder): e2e 923, serial 476 (outside e2e; 502 total including e2e), slow 62, live 1 (2 more live files sit in `test/e2e`), unit 5,024. These sum to 6,486.
- Only 81 test files spawn the CLI without importing `src/` directly or through a helper (see section 7). Roughly 500 test cases are that black-box set.

## 2. Tier model

Lanes are defined in `docs/TESTING.md` ("File taxonomy", l.1389; "Test command tiers", l.402) and the event matrix in `docs/ci-event-parity.md`.

| Tier | Files | Selector / command | Database | CI cadence (from docs) |
|---|---|---|---|---|
| unit | 5,024 | `*.test.ts` outside `test/e2e`; `bun run test` (`scripts/run-unit-parallel.sh`) | PGLite; `DATABASE_URL` unset in the lane | every PR, 10 weighted shards |
| serial | 476 (+26 in e2e) | `*.serial.test.ts`, listed in `scripts/serial-files.tsv` (476 rows); `bun run test:serial` | PGLite | 4 pooled workers, one Bun process per file |
| slow | 62 | `*.slow.test.ts`; `bun run test:slow` | PGLite | named slow jobs or unit shards |
| live | 3 | `*.live.test.ts`, `test/live/`; paid provider calls | real providers | never in PR CI |
| e2e | 923 | `test/e2e/*.test.ts`; `bun run test:e2e` (`scripts/run-e2e.sh`) | real Postgres via `DATABASE_URL`; skipped when unset | PR gets a selected subset; full corpus on master, merge queue, nightly |
| heavy | 9 `.sh` (2 are `_` helpers) + 3 `_*.ts` workloads in `tests/heavy/` | `bun run test:heavy` | Postgres | label-gated on PR; nightly `heavy-tests.yml` |
| fuzz | 3 | `test/fuzz/*.test.ts` | none | in unit lane (about 3 s) |
| admin | 29 files with `admin` in the name; 1 Playwright `admin/e2e/*.pw.ts` | `bun run test:admin` (PGLite in-memory, Chromium) | PGLite | required `admin-browser` job |
| stress | harness `scripts/stress/` + 6 name matches | `bun run test:stress`; PR gate `stress-changed-tests` runs each touched file 10x | Postgres arms | PR (changed files), nightly race hunt |
| scale | harness `scripts/scale/` + about 15 name matches | `bun run test:scale` (package.json l.103) | both | `scale-tier.yml`, nightly 10k-50k |
| convergence | `test/sync-convergence.serial.test.ts` (+ helpers) | `bun run test:convergence` sets `GBRAIN_TEST_CONVERGENCE=1` (l.107) | PGLite | `convergence-nightly.yml`; PR cell in `persistence-validation.yml` |
| busy-agent | `test/busy-agent-soak.serial.test.ts`, profile `test/fixtures/busy-agent-profile.json` | `bun run test:busy-agent` sets `GBRAIN_TEST_BUSY_AGENT=1` (l.108) | PGLite | dispatch-driven |
| tla | `spec/tla/` (2 modules, 15 `.cfg`) | `bun run test:tla` (l.109) | none for TLC | `tla-spec.yml` nightly and on touching PRs |

Per-directory split (verified; unit / serial / slow): root `test/*.test.ts` 4,168 / 418 / 46; `large-pages` 164 / 3 / 12; `scripts` 152 / 0 / 3; `pathological` 127 / 2 / 0; `search` 111 / 14 / 0; `ai` 80 / 4 / 0; `cycle` 36 / 2 / 0; `skillopt` 32 / 5 / 0; `decide` 15 / 22 / 0; `chunkers` 17; `ingestion` 12; `core` 10 / 3 / 1; `minions` 9 / 1 / 0; `audit` 9; `facts` 8; `conversation-parser` 8; `brainstorm` 8 / 2; `code-intel` 6; then 1 to 5 files each for `enrich`, `context`, `budget`, `bench`, `regressions`, `fuzz`, `extract`, `schema-pack`, `progressive-batch`, `fixtures`, `eval-contradictions`, `commands`, `eval`. `test/e2e` holds 923 files; `test/helpers` holds 12 `*.test.ts` plus about 200 helper modules.

Note that `decide/` is serial-heavy (22 of 37 files), so its tests are process-isolated by design.

## 3. Database requirements: PGLite versus `DATABASE_URL`

- Unit, serial and slow lanes unset `DATABASE_URL` (docs/TESTING.md l.271). A file whose Postgres arm is gated on it runs that arm only where a Postgres lane names it: a workflow step, a `test/e2e/` wrapper (`registerPostgresTests`), a `tests/heavy` script, or a row in `scripts/e2e-backend-matrix.txt` (77 rows). `test/postgres-unit-arms.txt` (776 rows) lists unit files that run their Postgres arm in `persistence-validation.yml`.
- `test/helpers/test-backends.ts`:
  - `requirePostgresTestDatabase` (l.6) refuses to skip a Postgres arm silently.
  - `testBackends()` (l.15) returns `['pglite','postgres']` when `DATABASE_URL` is set and `['pglite']` otherwise; `GBRAIN_TEST_BACKEND=postgres|postgres-direct|pgbouncer` forces the Postgres arm.
  - `registerPostgresTests()` (l.24) wraps loaders with `GBRAIN_TEST_BACKEND=postgres`.
- Counts (verified by `rg -l`): 831 files call `testBackends(`; 356 files mention `registerPostgresTests`; 284 of the `*-postgres.test.ts` wrappers call it; 1,022 files read `process.env.DATABASE_URL`.
- `test/e2e/` files are gated: 399 mention `DATABASE_URL`; 181 have neither a gate nor a registration call (inferred: these run with `DATABASE_URL` set by the runner, or are skipped).
- PGLite has a default-on schema snapshot (`test/fixtures/pglite-snapshot.tar`, generated by `scripts/build-pglite-snapshot.ts`; docs l.571). Every runner activates it, so the Rust port has no equivalent for the snapshot itself.

## 4. Two-engine parity helpers

- `test/helpers/two-engine.ts` (366 lines) runs two brains in one process with separate homes, AI keys, embedding models and fake OpenAI-compatible providers. `openTestBrain` (l.57) is the seam that later waves replace.
  - `CASES` (l.114): 26 isolation cases.
  - `EXPECTED_FAILURES` (l.308): 13 rows, each naming the wave that removes it (W2, W5, W6). These run as `test.failing`, so an unexpected pass fails the suite.
  - `twoEngineIsolationSuite(kind, urls)` (l.324) is run from `test/two-engine-isolation.serial.test.ts` (PGLite) and `test/e2e/two-engine-isolation.test.ts` (Postgres).
- `test/helpers/engine-sql-capability-cases.ts` pins three dialect capabilities, each with a boundary-size and a concurrent-write case: `maxBindParamsPerStatement` (PGLite splits code-edge inserts below 30,000 binds), `transactionAdvisoryLocks` (Postgres `pg_advisory_xact_lock` on same-entity fact inserts), and `probesEmbeddingCast` (`::vector` versus live column type). Registered from `test/engine-sql-capabilities.test.ts` and `test/e2e/engine-sql-capabilities-parity.test.ts`.
- Other engine-sql parity files: `test/e2e/engine-sql-prepare-parity.test.ts` (`pg_prepared_statements`), `test/e2e/engine-sql-normalize-parity.test.ts` (column decode shapes), `test/e2e/engine-sql-rls-scope.test.ts` (non-owner `NOBYPASSRLS` role), `test/e2e/engine-sql-transaction-parity.test.ts`.
- Name-level: 56 `*parity*.test.ts` files exist across the tree; 36 sit under `test/e2e`.
- Executor-level: `test/executor-binding-matrix.test.ts` (PGLite arm) and `test/e2e/executor-binding-matrix.test.ts` (run twice: direct and PgBouncer, with `prepare=false`).
- Shared scenario code across two engines is not treated as duplicate coverage (docs l.209). Engine-specific boundaries (JSONB, locks, pooler) are owned by the Postgres lane.

## 5. Golden and contract tests

- `test/helpers/golden.ts` is the golden harness. Goldens live under `test/fixtures/goldens/` (59 files: `doctor` 17, `sql-text` 14, `catalog` 10, `cli` 8, `pglite-upgrade-replay` 5, `decide` 3, `trust` 2). Each golden uses a named normalizer proven stable by capturing twice. Regenerate with `GBRAIN_TEST_UPDATE_GOLDENS=1`. 32 test files import the harness.
- Most relevant to a Rust engine:
  - `test/cli-goldens.test.ts`: `--help` text, `--version`, `--tools-json` bytes (sha256 pinned), unknown-command and unknown-flag exit codes and messages. Uses `runCliBatch` against the real `src/cli.ts` (`test/fixtures/goldens/cli/help-and-errors.json`, `tools-json.json`).
  - `test/cli-json-commands.test.ts` and the agent-contract tests: under `--json`, stdout is exactly one document or NDJSON, and failures are envelopes with `code`, `suggestion`, `contract_version: 1`.
  - `doctor` goldens (`test/helpers/doctor-json-golden.ts`).
- `test/engine-sql-sql-text.test.ts` pins SQL text byte-for-byte. It is a conversion guard, not product behavior; it dies with the SQL layer.
- Refactor-wave goldens pin output across rewrites; the docs say a golden is "a reviewer-visible diff" when regenerated (golden.ts header).

## 6. TLA+ specs

- `spec/tla/README.md` describes TLC checks plus mutants. `bun scripts/spec/mutants.ts` applies each mutant to a model copy (TLC must report a violation) and to the code (the named test must fail).
- `spec/tla/drain-lease/DrainLease.tla` (344 lines): the managed-sync drain lease. One drainer per source. The lease is one row in `gbrain_cycle_locks`; the acquisition token is the fencing token. Fenced transactions take the row `FOR KEY SHARE` (#7442). The model is Postgres only; PGLite is one connection. Invariants: `OneDrainer`, `FencedTxnsMatchRow`, `NoSpuriousLapse`, `CursorMonotone`. Code: `src/core/persistence/sync-lease.ts`, `src/core/db-lock.ts`. 14 mutants (`mutants.json`). Configs: `DrainLease.cfg`, `DrainLeaseSafety.cfg`, `DrainLeaseStamp.cfg`, `DrainLeaseLanesNightly.cfg`.
- `spec/tla/refresh-barrier/RefreshBarrier.tla` (884 lines): the refresh write barrier and deferred-write queue for one managed worktree and one page. Models Postgres's four row-lock modes, deadlock as a safety property (40P01), and crash-and-recover of the refreshing process (`MaxCrashes`). Code: `src/core/persistence/journal.ts`, `worktree-refresh.ts`, `refresh-barrier.ts`, `shared-skills/restore.ts`. 22 mutants. 11 `.cfg` files cover adoption, import holds, liveness and nightly variants.
- Test linkage: `test/spec-drain-lease-constants.test.ts` checks the `.cfg` timing constants against the code (per the `DrainLease.tla` header, l.13).

## 7. Black-box versus white-box

Method: for every `*.test.ts` I classified (a) direct imports from `src/` (relative specifiers), (b) CLI spawn (`test/helpers/cli-spawn.ts` or a literal `src/cli.ts`), and (c) whether the helper modules the test imports reach `src/` at depth 1. Depth-1 is an upper bound, because transitive helper chains were not followed.

| Class | Files | Test blocks (approx.) | Notes |
|---|---|---|---|
| Direct `src/` importers (white-box) | 5,545 | ~50,200 | Call functions and types from `src/`. Not portable. |
| No direct `src/` import | 941 | ~2,900 | Mixed: see below. |
| ...of which read source or doc text | 227 | | Structural guards (`test-reads-source-ok`, `structural-suites.tsv`, 488 rows). Not portable. |
| ...of which spawn the CLI | 88 | | 7 reach `src/` via a helper (depth 1). |
| Black-box candidates (spawn only, clean at depth 1) | 81 | ~496 | 64 root, 10 e2e, 7 `scripts/`. |

The 81 black-box files include `cli-goldens.test.ts`, `cli-json-commands.test.ts`, `cli-help-discoverability.test.ts`, `doctor-cli-smoke.test.ts`, `export-help.test.ts`, `e2e/serve-http-oauth.test.ts`, `e2e/sources-remote-mcp.test.ts` and `e2e/zombie-reaping.test.ts`. Their assertions are on stdout bytes, JSON envelopes, exit codes and files written under a temp `HOME`. Two examples were read: `test/cli-json-commands.test.ts` (imports only `bun:test`, Node built-ins and `./helpers/cli-spawn.ts`) and `test/helpers/cli-spawn.ts`.

The 941 non-importers are not uniformly portable. The 7 that reach `src/` through a helper (for example `test/e2e/agent-journey-postgres.test.ts`, `test/serve-stdio-bound-explicit-read.test.ts`) can become portable only after the helper is split into a protocol layer.

Most `test/e2e` wrappers are white-box at the loader level: `registerPostgresTests` calls scenario modules that import `src/`. For example the 349 files using `registerPostgresTests` depend on `test/helpers/*-scenarios.ts`, which are white-box.

Estimate of reuse:
- Run unchanged with a binary seam: about 500 cases in 81 files.
- Portable after helper refactoring: about 2,400 cases in roughly 860 non-importers, but most are scenario or source-text tests that need per-file review.
- Not portable: about 50,000 cases in 5,545 direct importers, plus the source-text guards.

Cases that a Rust engine can check beyond the 500 are only the ones that have a CLI or MCP surface and a DB-free fixture.

## 8. Harness proposal (GBRAIN_BIN)

1. The seam already exists. `test/helpers/cli-spawn.ts:63` hard-codes `CLI_PATH = src/cli.ts`; `:73` exports `_setSpawnTarget`; `:116` builds `[process.execPath, '--no-env-file', CLI_PATH]` unless overridden. Read `GBRAIN_BIN` there: if set, spawn `[GBRAIN_BIN]` and drop `--no-env-file`. Ten files across `test/`, `scripts/` and `tests/` already use `GBRAIN_BIN` (for example `test/plugin-turn-hook.test.ts` and `scripts/dx-explore.ts:834`), so the name is in use.
2. The env contract the Rust engine must honor (already set by the helper): `HOME` and `GBRAIN_HOME` pinned to a temp dir; `DATABASE_URL`, `GBRAIN_DATABASE_URL`, `GBRAIN_REMOTE_CLIENT_SECRET` stripped; `GBRAIN_SKIP_STARTUP_HOOKS=1`.
3. Run the 81 files from a TS checkout with `GBRAIN_BIN=<rust-engine CLI> bun test <files>`. Bun stays as the test driver, so the Rust team needs no new runner for the first pass.
4. Track results in a ledger keyed by (file, test name), following the identity model in `scripts/ci-executed-counts.ts` (docs l.121). Mark each as pass, fail, or expected divergence, the last with a `test.failing`-style row like `EXPECTED_FAILURES`.
5. Derive new Rust-native black-box cases from the goldens (`cli-help-v1`, `cli-tools-json-v1`) rather than from TS internals.

## Rust engine implications

Must preserve exactly (verified against the black-box set):
- CLI surface: `--help` and `--version` text, `--tools-json` bytes, unknown-command and unknown-flag exit codes and messages (`cli-goldens`).
- `--json` contract: one document per command, NDJSON where stated, error envelopes with `code`, `suggestion`, `contract_version: 1`.
- Environment handling: `HOME`, `GBRAIN_HOME`, `GBRAIN_SKIP_STARTUP_HOOKS`, and stripped `DATABASE_URL`. The Rust engine must not read a `.env` the tests strip.
- Doctor output shape (`doctor` goldens).

Can be simplified or dropped:
- Two-engine parity (`two-engine.ts`, `testBackends`, `registerPostgresTests`, the `*-parity` files, the PgBouncer backend matrix, `postgres-unit-arms.txt`). One engine means one arm.
- PGLite schema snapshot and its CI cache machinery.
- The isolation lint R1 to R9 (`scripts/check-test-isolation.sh`). These rules guard Bun's module registry and `process.env`. The lint's allowlist (63 lines) disappears with the TS code.
- SQL-text goldens (`engine-sql-sql-text`) and the engine-sql capability cases, which describe Postgres dialect behavior.
- Structural source-text guards (227 files), which check TS source shape, not product behavior.

Postgres features each test depends on (what the Rust engine must replicate or replace):
- `pg_advisory_xact_lock`: fact-insert serialization (`transactionAdvisoryLocks`).
- Row locks and `FOR KEY SHARE`: the drain-lease fence (`DrainLease.tla`) and the refresh barrier (`RefreshBarrier.tla`, four lock modes, deadlock as a safety property).
- `NOBYPASSRLS` and `FORCE RLS` roles: `engine-sql-rls-scope`, projection-statistics tests.
- pgvector HNSW plan choice and `vector`/`halfvec` casts: `vector-candidate-safety-postgres`, `vector-plan-real-column-postgres`.
- `pg_prepared_statements` and `prepare=false` behavior behind PgBouncer: `engine-sql-prepare-parity`, `backend-matrix`.
- Inferred, not mapped: `LISTEN`/`NOTIFY` and `SKIP LOCKED` queues are presumably exercised by the minions and persistence suites.

Risks:
- Oracle narrowness: only about 500 cases are truly black-box. Most of the 6,486 files would need rewriting, not reuse. Plan a Rust-native suite from the goldens and the CLI contract, not a rerun of TS unit tests.
- Helpers couple to `BrainEngine` internals (for example `engine.executeRaw`, `engineSqlExecutor`). Any Rust port of the helpers needs a new public seam.
- Timing ceilings are tuned for Bun and WASM PGLite (per-file caps, 1536 MB per slot, 820 s crash-robot ceiling). Do not carry them over unchanged.
- TLA+ models are Postgres-specific. If the Rust engine keeps a single process and in-process locks, `DrainLease` and `RefreshBarrier` need a new model, not a port.
- Goldens are generated on TS master. A Rust output diff must be classified as intended or a bug, with a documented exception list (the `EXPECTED_FAILURES` pattern works).

## Open questions

1. Is the oracle the TS binary's behavior (goldens and CLI contract), or the TS test files themselves? The answer decides whether to port tests or write new black-box cases.
2. Which goldens are contract-bearing and must stay byte-identical (`cli`, `tools-json`, `doctor`), and which are TS-formatting artifacts?
3. Does the Rust engine keep multi-process writers? If not, `DrainLease` and the refresh barrier stop applying, and the crash-robot scheduling need not be ported.
4. Who owns the `GBRAIN_BIN` seam in the TS test tree? The seam must be added either in a branch of gbrain or in a copied test tree.
5. Should the 3 live provider files and the `evals` suite (21 files in `gbrain-evals/test/eval/`, mostly pure eval logic) run against the Rust engine? They depend on provider keys and a `gbrain` package import (one file imports `gbrain/engine`).
6. Depth-1 import analysis may undercount black-box tests. Is a transitive pass worth the cost before committing to the 81-file estimate?
