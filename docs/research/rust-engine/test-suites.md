# Test suites

Research map for the Rust port. Reference: [garrytan/gbrain](https://github.com/garrytan/gbrain) at `origin/master` commit `8bbfd0b5e8` (package version 0.60.733.0), read on 2026-11-16. All paths are relative to that repo root. Counts come from scripted scans (`rg`, `find`, `wc`) and are approximate where marked. Statements were checked in the repo unless marked "(unverified)" or "measured".

Related maps: [background-jobs.md](./background-jobs.md) and [subsystems.md](./subsystems.md).

## At a glance

| Measure | Value |
|---|---|
| Test framework | Bun-native `bun:test`, always launched through runner scripts in `scripts/` |
| Unit and integration files (`test/**` minus e2e and live) | 5,567 (476 serial, 62 slow); 4,637 sit directly in `test/` |
| E2E files (`test/e2e/`) | 921 test files (509 `-postgres`, 37 `-pglite`, 378 unsuffixed); about 490 need `DATABASE_URL` |
| Live (paid provider) files | 3 (`*.live.test.ts`), opt-in only |
| Helpers / fixtures | 305 helper modules in `test/helpers/`; 1,193 fixture files (about 23 MB) in `test/fixtures/` |
| Other | `tests/heavy/` ops shell scripts, `tests/docker/` offline bootstrap e2e, `admin/` Playwright, `spec/tla/` TLA+ models, `evals/` (518 files) |
| Engine use | about 68% of unit files touch a DB engine (2,649 construct `PGLiteEngine` directly); 820 run dual-arm via `testBackends()` (PGLite always, Postgres when `DATABASE_URL` is set) |
| Pure-logic candidates | about 985 unit files have no engine, spawn, MCP, filesystem, or network reference |
| Black-box surfaces | 375 unit files + 48 e2e files spawn the CLI; 147 unit files + about 68 e2e files use MCP (stdio or HTTP) |
| API keys | keyless by default: `bunfig.toml` preloads strip provider keys, and `ai-tripwire` / `no-network-preload` record outbound calls; about 70 e2e files gate on keys |
| CI | 26 workflows; PR gate `test.yml` = 36 unit shards (18 jobs) + 4 serial shards + typecheck, verify, security; Postgres-heavy lanes are nightly |
| Run time | Recorded: about 560 s per unit shard x 36, serial shards 222-277 s, "30-minute full run". Measured here: 10 sampled unit files 0.16-23.4 s each; one PGLite serial file 3.2 s. The full suite was not run in this session |
| Contract inventory | `docs/contracts/public-surface.json`: 220 CLI commands, 613 CLI flags, 186 MCP tools, 855 MCP params, 503 config keys, exit codes |

## Recommended parity strategy (summary)

1. **Do not port the 6,500 TypeScript test files one by one.** Most are tied to PGLite/Postgres internals.
2. **Tier 1 (about 80-100 files): run unchanged as black-box tests against the Rust binary.** CLI help and goldens, MCP stdio `tools/list` and tool calls, `serve-http-*` routes and OAuth, markdown import/export round-trips. Hook: add a `GBRAIN_PARITY_BIN` override to `_setSpawnTarget()` in `test/helpers/cli-spawn.ts` and to the MCP stdio transport command.
3. **Surface-coverage gate:** one test that checks every entry in `public-surface.json` against `--help`, `tools/list`, and config keys, giving a parity percentage.
4. **Tier 2 (an estimated 150-200 files): port the logic tests to Rust unit tests.** Slugify, markdown/frontmatter/YAML parsing, fence round-trips, link extraction, chunkers, CJK word counting, RRF/cosine math, sink matching.
5. **Tier 3: do not port.** SQL-text goldens, migration history, Postgres pooling and lock tests, PGLite WAL/repair, live-provider tests.
6. **Reuse fixtures, not test code:** `test/fixtures/goldens/`, `agent-contract/`, `cli-contract/`, `ranking-shapes/`, `bootstrap-corpus/`, and the JSONL eval sets. The gbrain-evals repo (mapped separately) is the retrieval-quality oracle.

## Top parity risks (consolidated)

1. **Test isolation lives in preloads.** Scrubbed env, per-run `GBRAIN_HOME`, stripped provider keys, hermetic git, audit and sync-failure redirection. A Rust harness must set the same isolation or tests touch the operator's real home.
2. **Golden files pin exact text.** `goldens/doctor`, `goldens/cli`, `goldens/catalog` compare after named normalizers. Postgres-only checks in `doctor --json` will never match an embedded store byte for byte; they must be normalized out or split by backend.
3. **Search ordering.** `ts_rank` / `websearch_to_tsquery` semantics and HNSW approximation are not reproducible exactly. Compare slugs in order with defined tie-breaks, and scores with a tolerance.
4. **Markdown bytes are the brain format.** Frontmatter key order, fence markers, line endings, and trailing newlines must match exactly; normalizers must not hide them.
5. **Dual-arm assumption.** 820 files assume two engines with identical behavior; a single embedded store makes the "second arm" undefined.
6. **Crash, lock, and upgrade tests depend on PGLite internals** (crash workers, lock-process harnesses, `pglite-upgrade-replay/brain.tar.gz`). Rust needs its own atomicity and recovery tests.
7. **Stale reference checkout.** In this sandbox, the reference `node_modules` was out of sync with `bun.lock` (js-yaml 3.14.2 vs 4.3.2; `detect-libc` missing), which broke test files that import `data-frontmatter.ts`. Measurements used a fresh `git archive` copy. CI pins Bun 1.4.4; this host had 1.3.14.

## Open questions for Garry (consolidated)

1. **Parity approach:** black-box contract suite (Tier 1 + surface gate + shared goldens) as the main gate, with Tier 2 ported as Rust unit tests? Or a broader file-by-file port?
2. **Byte-identical vs shape-stable:** must `doctor --json` and CLI help be byte-identical after normalization, or is shape-level parity enough for v1?
3. **Init command:** does the Rust binary keep `gbrain init --pglite` (or accept it as an alias for the embedded store)? Tier 1 tests start from it.
4. **MCP HTTP scope:** is `serve --http` with OAuth and member tokens in v1? About 20 Tier 1 files depend on it.
5. **Fixtures:** the Rust code lives in gbrain (plan decision D1), so the Rust tests can read the corpora (goldens, contracts, ranking shapes, eval JSONL) in `test/fixtures/` in place. Which corpora does the Rust arm read, and does it need its own copies of any?
6. **Postgres-only lanes:** PgBouncer, Supavisor, pg15, and pg_upgrade matrices exist only to test Postgres. Confirm they are out of scope for an embedded-storage port.
7. **Existing brains:** is reading an existing PGLite data directory in scope? That decides whether the upgrade-replay fixture is an input or dropped.

---

## Test infrastructure, runners, and CI

Reference: `garrytan/gbrain` at origin/master 8bbfd0b5e8 (package version 0.60.733.0). Everything below was read from the repo unless marked "measured" (timed in a scratch copy) or "(unverified)".

### Summary

- Tests are Bun-native (`bun test`, bun:test). Lanes are selected by filename suffix: `*.test.ts` (parallel unit), `*.serial.test.ts` (one process per file), `*.slow.test.ts` (cold paths), `test/e2e/*.test.ts` (real Postgres), `*.live.test.ts` (paid providers), `tests/heavy/*.sh` (ops-shape shell scripts), `admin/e2e/*.pw.ts` (Playwright).
- The `bun test` invocation is always wrapped by a runner script. Runners unset `DATABASE_URL`, `GBRAIN_HOME`, and `SHARD` before starting, and then fan out.
- PGLite is the default test engine. Postgres is only exercised by E2E, by lanes that set `DATABASE_URL`, and by heavy scripts.
- 26 workflows in `.github/workflows/`. The PR gate is `test.yml`; it fans out to 18 unit-shard jobs (36 shards, two per job), a 4-shard serial job, and separate typecheck, verify, security, and dependency-audit jobs. Nightlies (`e2e.yml`, `heavy-tests.yml`, `convergence-nightly.yml`, etc.) run the Postgres-heavy and long lanes.
- Measured: a 10-file sample of small unit files passes in 0.16 to 23.4 s wall each (bun startup included). One PGLite serial test takes 3.2 s wall.

### package.json test scripts

| Script | Calls | What it does |
|---|---|---|
| `test` | `scripts/run-unit-parallel.sh` | Parallel unit loop, then serial pass. Excludes `*.slow`, `*.serial`, `test/e2e/*`. |
| `test:serial` | `scripts/run-serial-tests.sh` | `*.serial.test.ts` only, pooled. |
| `test:slow` | `scripts/run-slow-tests.sh` | `*.slow.test.ts` only, one `bun test --timeout=120000` process. |
| `test:e2e` | `scripts/run-e2e.sh` | Real-Postgres lane. Needs `DATABASE_URL`. |
| `test:heavy` | `scripts/run-heavy.sh` | Runs each `tests/heavy/*.sh` (not `_`-prefixed) sequentially. |
| `test:admin` | `playwright test --config admin/playwright.config.ts` | Browser suite. |
| `test:full` | `verify`, then `test`, then `test:slow`, then E2E only if `DATABASE_URL` is set | Prints a skip notice otherwise. |
| `verify` | `scripts/run-verify-parallel.sh` | Guard battery (about one minute per docs). |
| `ci:local` / `ci:local:diff` | `scripts/ci-local.sh` (`--diff` = doc-only fast path) | Full gate in Docker via `docker-compose.ci.yml`. |
| `ci:ubicloud` / `:diff` | `scripts/ci-ubicloud.ts` | Same lanes on ephemeral Ubicloud VMs. |
| `test:compile-smoke` | `bun test test/binary-self-update-compiled.serial.test.ts` | Needs a real compiled binary. |
| `test:convergence` | `GBRAIN_TEST_CONVERGENCE=1 bun --no-env-file test --timeout=3600000 test/sync-convergence.serial.test.ts` | 1 h per-test timeout. |
| `test:busy-agent` | `GBRAIN_TEST_BUSY_AGENT=1 bun --no-env-file test --timeout=3600000 test/busy-agent-soak.serial.test.ts` | 1 h timeout. |
| `test:stress` | `bun run scripts/stress/run.ts` | Stress harness. |
| `test:scale` | `bun scripts/scale/run.ts` | Scale tier (`scale-tier.yml`). |
| `test:tla` | `scripts/spec/tlc.sh`, then `scripts/spec/mutants.ts` (drain-lease, refresh-barrier) | TLA+ model checks. |
| `test:agent-voice` | `scripts/test-agent-voice.sh` | Installs pinned vitest and ws into a temp prefix, then runs the recipe's unit suite. |
| `test:profile` | `scripts/profile-tests.sh` | Reads a captured `bun test` log on stdin and prints the slowest tests. |
| `typecheck` | `tsc --noEmit --incremental` with 8 GB heap | Separate from tests. |
| `bench:efficiency`, `bench:parity` | `scripts/bench/...` | Benchmarks, not tests. |

`stress`, `scale`, `tla`, `convergence`, `busy-agent`, `compile-smoke`, and `agent-voice` are not in the default PR path. There are 104 `check:*` scripts in `package.json`. The `verify` battery runs the subset listed in the `CHECKS` array of `scripts/run-verify-parallel.sh`, which is not the full list.

### Runners and sharding

**`scripts/run-unit-parallel.sh`** (991 lines)

- Sources `scripts/lib/test-env.sh`, then runs `ensure_pglite_snapshot` before fan-out, so shards inherit a built schema snapshot.
- Shard count defaults to `detect_cpus`, is capped at 4 unless `--shards` or `SHARDS` is set, and is capped at 8 overall.
- Memory-adaptive: budget = available memory minus 4 GB, divided by `GBRAIN_TEST_MEM_PER_FILE_MB` (default 1536). Concurrency is reduced to fit. Disabled by `GBRAIN_TEST_NO_MEM_ADAPT=1`.
- Each shard runs `scripts/run-unit-shard.sh` under `timeout` with `GBRAIN_TEST_SHARD_TIMEOUT` (default 3000 s) and a `GBRAIN_TEST_SHARD_KILL_AFTER` grace (default 30 s).
- After the parallel pass, the serial pass runs (`scripts/run-serial-tests.sh`).
- Rescue lane: failures that carry a PGLite WASM OOM signature, or shards killed externally, are re-run serially. Plain assertion failures are never rescued. Disabled by `GBRAIN_TEST_NO_OOM_FALLBACK=1`.
- Output: `.context/test-failures.log`, `.context/test-summary.txt`, `.context/test-shards/`, `.context/test-receipts/`.

**`scripts/run-unit-shard.sh`** (184 lines)

- Discovers `find test -name '*.test.ts'` minus `test/e2e/*`, `*.slow.test.ts`, and `*.serial.test.ts`.
- Partitions by `SHARD=N/M` through `scripts/sharding.ts`. Partitioning is longest-processing-time-first bin-packing over measured per-file weights in `scripts/test-weights.json`. Unweighted files fall back to the corpus p75.
- Runs one `bun test` per file (`GROUP_SIZE=1`), with `--timeout=60000 * GBRAIN_TEST_TIMEOUT_MULTIPLIER` (default 60 s).
- Parses bun's summary and fails the group if the file census does not match.

**`scripts/test-shard-pack.sh` and `scripts/test-shard.sh`** are the CI wrappers. CI calls `test-shard-pack.sh 36 <shards...>`, which runs two shard indices concurrently per job.

**`scripts/run-serial-tests.sh`** (507 lines)

- Runs all `*.serial.test.ts` files except those in `scripts/serial-files.tsv` (477 rows, with class R1, R2, and so on).
- Four files are "exclusive" (for example `test/autopilot-launchd-lifecycle.serial.test.ts`, `test/bootstrap-hook-under-serve.serial.test.ts`). They run only on shard 1 of 1.
- Each file runs in its own process. The pool is `min(detect_cpus, 4)`, ordered heaviest first from `scripts/serial-weights.json`.
- Per-file timeout is also set in the script.

**`scripts/run-slow-tests.sh`**: one `bun test --timeout=120000` over the 62 `*.slow.test.ts` files. The file `test/entity-card-perf.slow.test.ts` is exclusive.

**`scripts/run-e2e.sh`** (639 lines)

- Forces `GBRAIN_TEST_ALLOW_DATABASE_URL=1` and `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`, then scrubs every `CONDUCTOR_`, `MCP_`, `OPENCLAW_`, `HERMES_`, `GROK_`, `OPENCODE_`, and `GBRAIN_` variable except an allow-list.
- Gives each file its own `HOME` and `GBRAIN_HOME` under `mktemp -d`, removed by an EXIT trap.
- Skips `test/e2e/e2e-live-key-only.txt` entries from the default glob.
- With `SHARD=N/M`, uses `scripts/e2e-weights.json`.
- Backend matrix options (`GBRAIN_PGBOUNCER_URL`, `GBRAIN_PGBOUNCER_E2E_URL`, `GBRAIN_SUPAVISOR_URL`) come from `scripts/e2e-backend-matrix.txt`.

**`scripts/run-heavy.sh`**: discovers `tests/heavy/*.sh` at the top level only, skips `_`-prefixed helpers, runs each in lexical order, and fails on the first non-zero exit.

**`scripts/ci-local.sh`** (333 lines): host gitleaks, frozen install, guards and typecheck, serial and slow lanes, then four unit/E2E shards in Docker via `docker-compose.ci.yml`.

### bunfig.toml and preloads

`bunfig.toml`:

- `[test] timeout = 60_000`. The file comments say Bun 1.4.2 ignores this, so every runner passes `--timeout` itself. A plain `bun test` run still uses 5 s (the comment), so direct invocations need `--timeout=60000`. Measured: the sample above passed `--timeout=60000` explicitly.
- `preload` array, in order:

| Preload (`test/helpers/...`) | Purpose |
|---|---|
| `database-url-guard-preload.ts` | Refuses to start if `DATABASE_URL` is ambient without `GBRAIN_TEST_ALLOW_DATABASE_URL=1` (#3485). |
| `operator-env-preload.ts` | Drops ambient `CONDUCTOR_`, `MCP_`, `OPENCLAW_`, and `GBRAIN_` config overrides (#4023). |
| `provider-keys-preload.ts` | Strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` so model routing matches keyless CI. |
| `real-home-guard-preload.ts` | Guards against writes to the real home directory. |
| `legacy-embedding-preload.ts` | Pins gateway defaults to legacy OpenAI/1536 for hardcoded fixtures. |
| `audit-dir-preload.ts` | Redirects `GBRAIN_AUDIT_DIR` to scratch. |
| `sync-failures-preload.ts` | Redirects the sync failure ledger to scratch. |
| `gbrain-home-preload.ts` | Points `GBRAIN_HOME` at per-run scratch. |
| `git-hermetic-preload.ts` | Sets `commit.gpgsign=false` and `tag.gpgsign=false` via `GIT_CONFIG_COUNT`. |

### Serial vs parallel separation

- The filename suffix decides the lane. `run-unit-parallel.sh` excludes `*.serial` and `*.slow`. `run-serial-tests.sh` runs only `*.serial`. Counts (my `find`): 5,030 unit `*.test.ts`, 476 serial, 62 slow, 923 E2E, 3 live. The top-level `test/` also holds `test/*.test.ts`, about 4,637 files in that directory.
- The docs say serial exists because `--max-concurrency=1` in a shared process leaks `mock.module` through the module registry (`docs/TESTING.md`, "File taxonomy").
- `scripts/serial-files.tsv` gives each serial file a class (R1 for process-level state such as HOME or PATH mutation, R2 for `mock.module` replacement) and a reason.

### test/helpers conventions

- 305 entries in `test/helpers/`, including the preloads above, `wait-for.ts`, `db-guard.ts`, `cli-spawn.ts`, `fake-postgres-sql.ts`, `database-url-guard-preload.ts`, and many `*-fixture.ts`, `*-scenarios.ts`, and `*-cases.ts` modules.
- `docs/TESTING.md` "E2E test DB lifecycle": `setupDB()` clears rows but keeps the physical schema. Fixed legacy-width vectors use `setupLegacyEmbeddingDB()`.
- Tests that need a real CLI spawn it through helpers (`cli-spawn.ts`).
- Lint rules (`scripts/check-test-*.sh`): test names must be real, fragment reads are restricted, env opt-ins are checked, isolation is enforced (`check-test-isolation.allowlist`), and placeholder assertions are banned.

### Env flags

| Flag | Effect |
|---|---|
| `DATABASE_URL`, `GBRAIN_DATABASE_URL` | Postgres target. Unit and serial runners unset them. E2E keeps them. |
| `GBRAIN_TEST_ALLOW_DATABASE_URL=1` | Lets the DB guard pass. Set by `run-e2e.sh`. |
| `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1` | Keeps provider keys. Set by `run-e2e.sh`. |
| `GBRAIN_TEST_DB` | Explicit schema-reset opt-in for service hosts. |
| `GBRAIN_TEST_MAX_CONCURRENCY`, `GBRAIN_TEST_MEM_PER_FILE_MB`, `GBRAIN_TEST_NO_MEM_ADAPT` | Unit-runner concurrency and memory. |
| `GBRAIN_TEST_SHARD_TIMEOUT`, `GBRAIN_TEST_SHARD_KILL_AFTER`, `GBRAIN_TEST_NO_OOM_FALLBACK` | Unit shard timeout and rescue. |
| `GBRAIN_TEST_TIMEOUT_MULTIPLIER`, `GBRAIN_TEST_WAIT_MULTIPLIER`, `GBRAIN_TEST_PERF_BUDGET_MULTIPLIER` | Scale timeouts and perf budgets. |
| `GBRAIN_TEST_RECEIPT_DIR` | Executed-test receipts (`scripts/lib/test-env.sh`). |
| `GBRAIN_NO_SNAPSHOT`, `GBRAIN_PGLITE_SNAPSHOT`, `GBRAIN_TEST_DEFAULT_SNAPSHOT` | PGLite schema snapshot control. |
| `GBRAIN_CI_DISABLE_TEST_ENV_FILE` | Blocks `.env.testing`; set in `docker-compose.ci.yml`. |
| `GBRAIN_TEST_UPDATE_GOLDENS` | Rewrites golden files (49 references). |
| `GBRAIN_TEST_CONVERGENCE`, `GBRAIN_TEST_BUSY_AGENT`, `GBRAIN_TEST_REQUIRE_COMPILE` | Opt-ins for the long lanes. |

Reference counts from `rg -oh` across `test`, `scripts`, `.github`, `tests`, and `docs`: about 60 distinct `GBRAIN_TEST_*` names.

### Postgres service images and compose files

- `docker-compose.test.yml`: one `pgvector/pgvector:pg16` service on `127.0.0.1:5434`, database `gbrain_test`, user and password `postgres`.
- `docker-compose.ci.yml` (local CI):
  - four `pgvector/pgvector:pg16` services with `shm_size: 1g`, on host ports 5434 to 5437 (`GBRAIN_CI_PG_PORT*`);
  - `edoburu/pgbouncer:latest` in transaction pooling, fronting `postgres-1` on port 6543, with `AUTH_TYPE: plain` and an explicit `IGNORE_STARTUP_PARAMETERS` list;
  - a `runner` service on `oven/bun:${GBRAIN_CI_BUN_TAG:-1.4.4}`, bind-mounting the repo, with `stop_grace_period: 600s`.
- Comment in the file: 4 DBs remove the TRUNCATE race between E2E files. Estimated wall time on a 16-core host: about 6 min sequential vs 1.5 to 2 min sharded (unverified).
- `tests/docker/Dockerfile`: `oven/bun:1.4.4` plus git and ca-certificates. `bootstrap-e2e.sh` runs the container with `--network none --read-only --cap-drop ALL --tmpfs /tmp`. `bootstrap-e2e-inner.sh` runs a scripted interview, confirm, render, a fake-gh repo phase, an ABORT_AFTER kill with status resume, and a keyless verify on a temp PGLite brain. It is run from `heavy-tests.yml` (line 112). Docker is not started here.

### tests/heavy and test/postgres-unit-arms.txt

- `tests/heavy/README.md`: ops-shape scripts costing more than about 30 s, needing real Postgres, spawning multiple processes, or measuring RSS, latency, or lock contention. Not in default `bun test`. Scripts must source `tests/heavy/_db_floor.sh`, which refuses a DB name without a "test" segment unless `GBRAIN_E2E_ALLOW_DB` names it exactly.
- Top-level scripts: `pg_upgrade_matrix.sh`, `measure_rss.sh` (budget in `rss-baseline.json`), `read_latency_under_sync.sh`, `sync_lock_regression.sh` (NUM_PARALLEL 2 to 32, default 4), `sync_timeout_rescue.sh`, `graduation_10k.sh`, `frontmatter_scan_wallclock.sh`. Helpers with `_` prefix: `_build_legacy_fixtures.sh`, `_db_floor.sh`, `_measure_rss_workload.ts`, `_read_latency_workload.ts`, `_sync_timeout_rescue_workload.ts`.
- Fixtures: `tests/heavy/fixtures/down-mutate-pre-v0.13.sql` and `down-mutate-pre-v0.18.sql`.
- `test/postgres-unit-arms.txt`: 776 lines, 763 non-comment rows. One repo-relative test path per line, sorted. Each row is a unit-lane suite whose Postgres arm runs only when `DATABASE_URL` is set. Consumers: `scripts/postgres-unit-arms.ts` (one Bun process per file) and `persistence-validation.yml` (`unit-postgres-arms`, 21 shards), plus `test.yml` `race-hunt` (10 iterations per file). `scripts/check-postgres-lane-coverage.ts` verifies each row is gated.

### Workflows (26 files in `.github/workflows/`)

Triggers are abbreviated. Runner labels are Ubicloud unless noted. Timeouts are the job-level `timeout-minutes` where read.

| Workflow | Trigger | What it runs | Services and images | Secrets | OS / runner | Timeout |
|---|---|---|---|---|---|---|
| `test.yml` (Test) | push master, PR, merge_group, cron `23 7 * * *`, dispatch | `dynamic-ci`, `changes` (reuse), gitleaks, security-regressions, dependency-audit, verify, typecheck, census (2 shards), serial (4 shards), slow, brainbench, test (18 jobs = 36 unit shards), coverage, native-locks, persistence, stress, race-hunt, admin-browser, shared-skills, receipts, `test-status`, `full-suite` | `pgvector/pgvector:pg16` on serial and unit jobs | `TRUNK_API_TOKEN` (dynamic-ci) | 2 to 8 vCPU Ubicloud; security-regressions matrix ubuntu, macos-26, windows-latest | Unit 22 min, serial 25, verify 12, typecheck 21, gitleaks 10 |
| `e2e.yml` (E2E Tests) | push master, merge_group, cron `0 6 * * *`, dispatch (full_corpus, order_hunt) | Selected E2E shards (diff-relevant), full corpus, order hunt, JSONB parity | `pgvector/pgvector:pg16`, `pgvector/pgvector:pg15` (pg15 migration check), `edoburu/pgbouncer` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` | Ubicloud 2 and 4 vCPU | prepare 5, E2E shards 60, full 70, nightly 150 |
| `heavy-tests.yml` (Heavy Tests) | cron `17 8 * * *`, PR labeled `heavy-tests`, dispatch | `run-heavy.sh`, `bootstrap-e2e.sh`, real-agent door e2e (`install-real-*.serial.test.ts`), grok-door, opencode-paid | `pgvector/pgvector:pg16` | `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `XAI_API_KEY` | ubicloud-standard-30 (heavy), 16 (door) | 75 min heavy, 30 door |
| `convergence-nightly.yml` | cron `17 9 * * *`, dispatch seed | Sync convergence (long soak) | `pgvector/pgvector:pg16` and PgBouncer, matrix over bun | none | ubicloud-standard-4 | 330 and 150 min |
| `persistence-validation.yml` | workflow_call, dispatch | `scripts/persistence/matrix.ts`, deployment matrix (PgBouncer/RLS), unit-postgres-arms (21 shards) | `pgvector/pgvector:pg16`, `edoburu/pgbouncer` | none | ubicloud 4 and 8 | 55 min |
| `scale-tier.yml` | PR (labeled), cron `41 8 * * *`, dispatch pages | `bun run test:scale`, dynamic-ci | `pgvector` pg16 for postgres engine only | `TRUNK_API_TOKEN` | ubicloud 2, 8 | 10 min plan |
| `stress.yml` | workflow_call (mode) | Stress shards | `pgvector/pgvector:pg16` | none | ubicloud 2, 4 | 10 min result |
| `native-locks.yml` | workflow_call (scope full/primary/smoke) | Native lock tests, toolchain build, compiled smoke | `pgvector` pg16 | none | Linux x64/arm64, macos-26, macos-26-intel; bun matrix | 15 min per cell |
| `macos-validation.yml` | cron `41 9 * * *`, PR labeled, dispatch | macOS 26 typecheck and tests (no secrets) | none | none | macos-26, macos-26-intel | 90 and 40 min |
| `upgrade-matrix.yml` | cron `41 6 * * *`, PR, dispatch candidate/from | Upgrade matrix cells (N-1, N-10, N-50, 30-day) | `pgvector` pg16 for postgres cells | none | ubicloud 2, 4 | cell 40 min |
| `tla-spec.yml` | PR (spec paths), push, cron `40 9 * * *` | TLA+ specs | `pgvector` pg16 | none | ubicloud 4 | 60 min |
| `production-soak.yml` | cron `17 6 * * 1`, dispatch | 2-hour soak per cell | none | none | ubicloud 16 | 600 min |
| `sync-freshness-gate.yml` | cron `29 9 * * *`, dispatch runs | Sync freshness gate | none | none | ubicloud 4 | 30 min step |
| `stable-daily.yml` | cron `17 5 * * *` and `17 13 * * *`, dispatch dry_run | Stable daily check | none | none | ubuntu-latest | 20 min |
| `promote-stable.yml` | dispatch | Promote version to stable | none | none | ubuntu-latest | 10 min |
| `release.yml` | push master (VERSION path), dispatch | Build matrix (macos-26 and ubuntu-latest), CI gate, skill-resolver bundle, publish, template publish | none in build | `TEMPLATE_REPO_PAT` | ubuntu-latest, macos-26 | ci-gate 120, build 30 |
| `full-ci.yml` | PR labeled | Full CI reuse trigger | none | none | ubicloud 2 | 5 min |
| `harness-check.yml` | PR | `gbrain-check.ts` against a harness image | none | `HARNESS_EVALS_READ_TOKEN` | ubicloud 4 | 45 min |
| `skill-resolver-bench.yml` | PR (resolver paths), dispatch | `bench-skill-resolver.ts` | none | none | ubicloud 2 | 20 min |
| `semgrep.yml` | PR, cron `30 7 * * 1`, dispatch | Semgrep 1.170.0 rulesets (pinned digest) | semgrep image | none | ubicloud 4 | 20 min |
| `osv-scanner.yml` | PR (lockfile paths), cron `30 6 * * 1`, dispatch | OSV scanner (upstream reusable) | none | none | upstream | - |
| `actionlint.yml` | push/PR on workflows, dispatch | actionlint | none | none | ubicloud 2 | 5 min |
| `ci-health.yml` | cron `0 10 * * 1`, dispatch | `ci-cost-ledger.ts` report, weekly | none | none | ubicloud 2 | 15 min |
| `nightly-watch.yml` | workflow_run completed for 14 named workflows, dispatch run_id | Evaluates run results and reports | none | none | ubicloud 2 | 5 and 15 min |
| `fix-wave-gate.yml` | pull_request_target (labels) | Fix-wave gate | none | none | ubicloud 2 | 5 min |
| `fix-wave-closeout.yml` | pull_request_target closed | Fix-wave closeout | none | none | ubicloud 2 | 10 min |

Notes:

- Secrets actually referenced: `ANTHROPIC_API_KEY` (14 refs), `OPENAI_API_KEY` (7), `XAI_API_KEY` (4), `HARNESS_EVALS_READ_TOKEN` (2), `TRUNK_API_TOKEN` (2), `TEMPLATE_REPO_PAT` (1). Only `heavy-tests.yml` and `e2e.yml` use LLM keys; the other workflows are keyless by design.
- Postgres images: `pgvector/pgvector:pg16` (24 refs) and `pgvector/pgvector:pg15` (`e2e.yml` line 706, for `scripts/e2e-postgres15.txt`). PgBouncer: `edoburu/pgbouncer:latest` (8 refs). Semgrep is pinned by digest. Nothing pins a PgBouncer or pgvector digest.
- Bun versions: 1.4.4 everywhere (66 refs), plus one job on 1.4.3 (`harness-check.yml`). Matrices include `bun: ['1.4.4']` (14 refs).
- OS matrix: only `security-regressions` (ubuntu-latest, macos-26, windows-latest) and `release.yml` build (macos-26, ubuntu-latest) and `macos-validation.yml` (macos-26 and macos-26-intel) use GitHub-hosted runners. Everything else is Ubicloud Ubuntu 24.04 (2, 4, 8, 16, or 30 vCPU, plus an arm64 4 vCPU).
- Crons (all UTC): test 07:23 daily, e2e 06:00 daily, heavy 08:17, macOS 09:41, convergence 09:17, TLA 09:40, scale 08:41, upgrade 06:41, sync-freshness 09:29, stable-daily 05:17 and 13:17, production-soak Monday 06:17, ci-health Monday 10:00, semgrep Monday 07:30, osv Monday 06:30.
- Test matrix in `test.yml` line 1044: `shards: [[1, 2], [3, 4], ... [35, 36]]`, 18 jobs. Each job runs `test-shard-pack.sh 36 <a> <b>`.
- Sharding constants (`scripts/sharding.ts`): `UNIT_SHARDS = 36`, `UNIT_SHARDS_PER_JOB = 2`, `UNIT_SHARD_BUDGET_MS = (UNIT_JOB_TIMEOUT_MS - UNIT_SETUP_ALLOWANCE_MS - 60_000) / 2` (about 600 s, per the comment). `test/scripts/unit-shard-budget.test.ts` enforces this.
- Weights: `scripts/test-weights.json` is mined from 5 nightly runs (metadata file names run 43825374906, 5,057 of 5,057 files measured). `scripts/serial-weights.json` has 476 of 476 files measured.

### Timing data

| Source | Recorded figure |
|---|---|
| `docs/TESTING.md` "Test command tiers" | Full run described as the "30-minute full run" in CHANGELOG line 2739. |
| `CHANGELOG.md` line 2739 | "Pull requests now run the tests that check gbrain's lists, in about 4 minutes" (census job). |
| `CHANGELOG.md` line 633 | `test/enforced-member.serial.test.ts` took 185 to 191 s on a 4-vCPU machine. CI killed it at 300 s. |
| `CHANGELOG.md` line 1849 | `test/e2e/worktree-refresh-postgres.test.ts` took 139 to 156 s against a 180 s per-file limit. |
| `CHANGELOG.md` line 2010 | Postgres unit arms: largest shard planned at 554.6 s against a budget. |
| `test.yml` comments | Unit shards: about 20,220 s of mined file time over 36 shards, about 562 s per shard; budget 600 s. Serial shard 2: 222 s on 8 vCPU, 277 s on 4. |
| `run-unit-parallel.sh` comments | 13k+ tests, 120-migration PGLite replay per init, about 960 to 1,020 s internal wall per shard at a 4-shard default. Those figures are from the comments, so they may be stale. |
| `docs/TESTING.md` "CI runner capacity" | Unit shard about 542 s on 2 vCPU and 608 s on 2 vCPU in one comparison. |
| `profile-tests.sh` | Helper to rank slow tests from a log. No stored data. |

Timeouts in the repo (for planning): `bunfig` 60 s per test; runners 60 s (unit shards, serial), 120 s (slow), 1 h (convergence and busy-agent), 3000 s per unit shard (wall), 300 s per E2E file cap in CI (per CHANGELOG line 633), 22 min unit job, 25 min serial job, 60 min E2E shards, 70 min full E2E.

### Measured

Environment: 8 vCPU, 30 GB RAM Linux host, Bun 1.3.14 (`~/.bun/bin/bun`). Note the repo's `package.json` engines say bun >=1.4.4 and CI pins 1.4.4; the measurement used 1.3.14 because that is what is installed. Each `bun test` run used `--timeout=60000`, with the unit-lane env scrubbing (DATABASE_URL and GBRAIN_HOME unset, git gpgsign off).

Measurement location: a scratch copy, created with `git archive HEAD`. The reference checkout's `node_modules` was stale (see below), so the scratch copy got a fresh `bun install --frozen-lockfile --ignore-scripts`. The reference repo was not modified.

Ten small unit files, one run each, wall time includes bun startup and preloads:

| File | Tests | Result | Wall |
|---|---|---|---|
| `test/fuzz/filesystem-validators.test.ts` | 5 | pass | 0.55 s |
| `test/minions/agent-audit.test.ts` | 7 | pass | 0.59 s |
| `test/core/background-work.test.ts` | 10 | pass | 0.18 s |
| `test/commands/schema-packpath.test.ts` | 3 | pass | 0.20 s |
| `test/context/entity-salience.test.ts` | 28 | pass | 0.16 s |
| `test/chunkers/cap-oversized-cjk.test.ts` | 6 | pass | 1.56 s |
| `test/ai/anthropic-claude5-wire.test.ts` | 7 | pass | 3.17 s |
| `test/facts/backstop-page-date.test.ts` | 4 | pass | 3.07 s |
| `test/cycle/concept-publication-file-recheck.test.ts` | 6 | pass | 3.61 s |
| `test/search/adjacency-generic-plan.test.ts` | 1 | pass | 23.42 s |

One PGLite-backed serial test, measured in the same way: `test/search-telemetry-cache-wiring.serial.test.ts` (imports `PGLiteEngine` at line 45), 4 pass, 3.20 s wall.

Not measured: the full parallel unit suite (`scripts/run-unit-parallel.sh`). I did not start it, so there is no wall time or pass/fail count. Docker and Postgres were not started, per the task.

### Infrastructure issue (stale checkout)

the sandbox checkout's `node_modules` contains js-yaml 3.14.2, but `bun.lock` pins js-yaml 4.3.2. `src/core/data-frontmatter.ts:30` calls `DEFAULT_SCHEMA.extend`, which only exists in js-yaml 4. In the stale checkout, every test that imports that module fails at load (all ten sampled files failed with "Unhandled error between tests"). A clean `bun install --frozen-lockfile` fixes it. The issue was reported to the infrastructure channel (ID 4806). Anyone timing this repo in place needs that reinstall first.

### Parity risks

- Runner behavior is the test contract: the rescue lane (OOM and external-kill re-runs), the 3000 s shard cap, memory-adaptive concurrency, and the exit-hang classifier all change pass/fail outcomes. A Rust port needs its own harness, not these scripts.
- Preload-driven environment (scrubbed env, per-run `GBRAIN_HOME`, git hermetic, stripped provider keys, audit and sync-failure redirection) is what makes tests deterministic. A black-box parity harness must set the same isolation or results will drift.
- PGLite snapshot (`test/fixtures/pglite-snapshot.tar`) is built from the current schema and migration set. A Rust engine needs an equivalent fast-start fixture or cold-start times multiply by roughly 300 files.
- `setupDB()` relies on TRUNCATE CASCADE semantics and per-file DB isolation in E2E (`docker-compose.ci.yml` comment). Embedded storage has no shared database, so this isolation must be reproduced per process.
- Timing gates (`CHANGELOG` 300 s per-file kill in CI, bun per-test 60 s) are calibrated to Postgres and PGLite WASM speed. Rust could pass them easily, but fixtures that check timing budgets (`GBRAIN_TEST_PERF_BUDGET_MULTIPLIER`) will not transfer.
- The `*.live.test.ts` and key-gated E2E files are not in default CI; their outputs cannot be compared without keys.

### Open questions for Garry

- Should the Rust port keep the TypeScript test lanes (unit, serial, E2E) as-is in a separate repo for behavioral parity, or rebuild a smaller black-box suite that drives only the CLI and MCP surfaces?
- Which Postgres lanes (PgBouncer, Supavisor, pg15) are in scope for an embedded-storage replacement? Many workflows and E2E files exist only to test Postgres pooling.
- Does the Rust port need the `tests/heavy` ops scripts (RSS budget, sync-lock regression, pg_upgrade matrix), or only the functional lanes?
- Target Bun version for measurement and for any retained TypeScript harness: CI pins 1.4.4, but this host has 1.3.14.

## Unit and integration test suites by subsystem

Scope: every file under `test/` except `test/e2e/` and `test/live/` in `garrytan/gbrain` (commit 8bbfd0b5e8). That is 5,567 `*.test.ts` files (476 `*.serial.test.ts`, 62 `*.slow.test.ts`), plus 305 helper modules under `test/helpers/` and 1,193 fixture files under `test/fixtures/` (about 23 MB). 4,637 test files sit directly in `test/`; 930 sit in subdirectories (`large-pages` 179, `scripts` 155, `pathological` 129, `search` 125, `ai` 84, `cycle` 38, `skillopt` 37, `decide` 37, and smaller groups).

Method: each test was classified by its primary `src/` import (the most-imported module path). Files with no `src/` import (133 in `scripts/`, 89 misc, 35 large-pages, and others) were classified by file name. Flags come from regex scans of each file: engine use, `DATABASE_URL`, provider key names, external hosts, `Bun.spawn`/`src/cli.ts` spawn helpers, MCP helpers, `mock.module(`, and git fixture helpers. These are heuristics. Counts are approximate to within a few percent, and "pure" means no engine, spawn, MCP, filesystem, or network reference was found.

### Overall counts

| Measure | Count | Notes |
|---|---|---|
| Test files (non-E2E, non-live) | 5,567 | `test/**/*.test.ts` minus e2e and live |
| Serial files (`*.serial.test.ts`) | 476 | `scripts/serial-files.tsv` mentions 477 serial entries; the scan found 476 in this tree (difference not checked). Each runs in its own process |
| Slow files (`*.slow.test.ts`) | 62 | Run by `scripts/run-slow-tests.sh` |
| Touch a DB engine (PGLite or Postgres mention) | 3,794 (68%) | 2,649 files construct `new PGLiteEngine` directly |
| Pure-function candidates (no DB, spawn, MCP, fs, or network reference) | 985 (18%) | Heuristic lower bound for "pure" tests |
| Use `testBackends()` (dual-arm: PGLite always, Postgres arm only if `DATABASE_URL` is set) | 820 | Shared gate in `test/helpers/test-backends.ts` |
| Reference a real Postgres (`registerPostgresTests`, `requirePostgresTestDatabase`, `PostgresEngine`) | 3 direct call sites; 346 files mention those helpers | Postgres runs only when `DATABASE_URL` is set |
| Gated on `DATABASE_URL` via `skipIf` | 24 | Explicit skip conditions |
| Spawn the CLI (`src/cli.ts` via `runCli`/`runCliBatch`/`runCliMemo`, `gbrain` binary, or `runGbrain`) | 375 | Largest subprocess group; `runCli` is in `test/helpers/cli-spawn.ts` |
| Spawn any child process (`Bun.spawn`, `spawnSync`, `execFile`) | 1,114 | Includes CLI spawns and helper children |
| Use the MCP server or MCP client helpers | 147 | Heuristic: `McpSession`, `mcp-stdio`, `tools/list`, `serveMcp`, and similar |
| Use `mock.module(` | 93 | 92 of the 93 are serial files (see Mocks below) |
| Reference provider key names (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, and others) | 700 | Mostly to strip or set keys; see API keys below |
| Reference external hosts (`https://…`, `git clone`) | 219 | Upper bound; not checked file by file |
| Use git fixtures (`makeGitFixture`, `gitExec`, `git init`) | 796 | `test/helpers/git-fixture.ts` and related |

### Subsystem table

Column meanings: Files and Serial are counts per primary-import group. Engine = file mentions PGLite or Postgres. `testBackends` = file loops over the dual-arm gate. CLI = spawns the CLI. MCP = MCP helpers. Mock = `mock.module`. Examples are two plain tests and one serial test.

| Subsystem (src/ mapping) | Files | Serial | Engine | testBackends | CLI | MCP | Mock | What it needs | Examples (under `test/`) |
|---|---|---|---|---|---|---|---|---|---|
| Engine layer: `src/core/pglite-engine`, `postgres-engine`, `engine*`, `db`, `pool`, `pg-*` | 1,328 | 109 | 1,284 | 189 | 47 | 36 | 8 | PGLite in process (default). Postgres arm via `DATABASE_URL`. SQL-text and fake-SQL checks (`fake-postgres-sql.ts`). | `pg-tls-default-refusal.test.ts`, `book-mirror-spend-authorization.test.ts`, `openclaw-context-engine-native.serial.test.ts` |
| Persistence: `src/core/persistence/` (353 modules) | 915 | 32 | 796 | 392 | 37 | 11 | 3 | PGLite; many tests use `managedBrain()` (1,100 call sites). Postgres arm for some. Git fixtures. | `timeline-omission.test.ts`, `conversation-facts-managed.test.ts`, `fix-wave-3-connector-loops.serial.test.ts` |
| AI, embedding, budget: `src/core/ai`, `embedding*`, `budget`, `model*` | 314 | 73 | 129 | 11 | 5 | 3 | 24 | Mostly keyless: provider keys stripped, fake OpenAI-compatible providers, `ai-tripwire`. Some `mock.module` of AI SDK. External-host strings. | `embed-skip.test.ts`, `safety-wave-coverage-invocation-inheritance.test.ts`, `embed-input-type-wire.serial.test.ts` |
| Cycle, dream, facts, extract, takes, belief: `src/core/cycle`, `facts`, `think`, `extract*`, `takes*`, `belief*` | 295 | 26 | 194 | 49 | 3 | 4 | 14 | PGLite; LLM-stubbed extraction (`longmemeval-stub`, `recording-engine`). `mock.module` for model calls. | `extract-atoms-page-state.test.ts`, `dream-retriage-conversation-pages-7307.test.ts`, `eval-takes-quality-runner.serial.test.ts` |
| Operations and MCP dispatch: `src/core/operations`, `ops`, `verbs`, `mcp/` | 186 | 14 | 122 | 14 | 20 | 35 | 4 | PGLite. Calls operations directly or through MCP (`McpSession` in `test/e2e`-style helpers). | `fix-routing.test.ts`, `persistence-graph-publication.test.ts`, `loops-close-fact.serial.test.ts` |
| Minions, jobs, workers: `src/core/minions/` | 180 | 14 | 120 | 9 | 12 | 1 | 7 | PGLite. Real child processes (`worker` and `subagent` children). `zombie-reap`, `pid1-reaper` process tests. | `worker-rss.test.ts`, `embed-backfill-submit.test.ts`, `jobs-child-readiness.serial.test.ts` |
| Doctor: `src/commands/doctor`, `src/core/doctor*` | 157 | 9 | 122 | 24 | 12 | 4 | 0 | PGLite, plus `doctor-json-golden.ts`, which spawns `gbrain` with `no-network-preload` to prove no network call. | `shared-exposure-serves.test.ts`, `function-search-path-pglite.test.ts`, `graduation-serve-guard.serial.test.ts` |
| Search and retrieval: `src/core/search`, `query*`, `rerank*`, `vector*`, `keyword*`, `hybrid*` | 151 | 19 | 70 | 8 | 1 | 2 | 9 | PGLite with vector columns, fixed-dimension embeddings (`ef-search-fixture.ts`, `vector-candidate-corpus.ts`). Some `mock.module`. | `rerank-audit.test.ts`, `search-telemetry-disconnect-hang.test.ts`, `dispatch-vector-incomplete.serial.test.ts` |
| Bootstrap, setup, config, CLI: `src/core/bootstrap`, `setup`, `config`, `src/commands/init`, `src/cli/` | 143 | 26 | 62 | 3 | 56 | 6 | 7 | Most spawn the CLI (`runCli`) in temp homes (`with-env.ts`, `gbrain-home-preload`). Some PTY tests (`tty-harness.ts`). | `append-file-read.test.ts`, `init-first-run.test.ts`, `ops-run-onboard-scope-gate.serial.test.ts` |
| Scripts and CI guards (no `src` import): `test/scripts/` | 133 | 0 | 39 | 3 | 9 | 0 | 0 | Reads repo files and runs `scripts/check-*` and similar tools. Engine use is for schema or lane checks. | `scripts/ubi-runner-run.test.ts`, `scripts/check-schema-error-predicates.test.ts` |
| Context, transcripts, conversation: `src/core/context`, `transcripts`, `conversation-parser` | 114 | 11 | 60 | 8 | 2 | 2 | 1 | PGLite for fact write-back; fixtures for parsers (`test/fixtures/transcripts`, `conversation-formats`). No network. | `transcripts-archive-legacy-collision.test.ts`, `compile-view.test.ts`, `codex-rollout-0154.serial.test.ts` |
| Skills: `src/core/skillpack`, `skillopt`, `shared-skills` | 106 | 8 | 26 | 0 | 12 | 0 | 3 | Filesystem skill trees (`test/fixtures/skill-evals`, `skill-catalog`), CLI spawn for `skillpack` commands, shared-skills transports (`shared-skills-transports.ts`, OAuth process). | `skillpack-sync-register-4831.test.ts`, `skillpack-frontmatter-sources.test.ts`, `shared-skills-export.serial.test.ts` |
| Page, markdown, chunkers: `src/core/page-body`, `page-state`, `markdown*`, `chunkers` | 97 | 2 | 45 | 22 | 0 | 0 | 0 | Pure functions for chunkers (`chunkers/`); PGLite for page storage. Fixture markdown. | `embedding-state.test.ts`, `chunker-version-gate.test.ts`, `page-summary-length.serial.test.ts` |
| Eval and bench: `src/core/eval*`, `src/eval/`, `commands/eval*`, `bench` | 79 | 6 | 29 | 0 | 3 | 0 | 2 | Eval JSONL sets (`longmemeval-*.jsonl`, `notability-eval-public.jsonl`, `whoknows-eval.jsonl`). LLM judge stubs (`longmemeval-stub.ts`). | `longmemeval-judge.test.ts`, `eval-brainbench-e2e.slow.test.ts`, `eval-longmemeval-call-plan.serial.test.ts` |
| Access, grants, guests: `src/core/access`, `grants`, `guests` | 66 | 0 | 65 | 32 | 1 | 12 | 0 | PGLite; many use `testBackends()`. MCP calls for role checks. Mostly pure DB. | `client-grants.test.ts`, `access-folder-scoped-role.test.ts` |
| Connectors, Google, ingestion: `src/core/google`, `connectors`, `ingestion` | 66 | 3 | 24 | 6 | 0 | 0 | 1 | Fake Gmail and GitHub (`connector-holds-fixture.ts`), fake Slack (`slack-fixture.ts`), `fetch` stubs. 16 files reference external hosts (upper bound). | `slack-source-managed.test.ts`, `connectors-hardening-7515.test.ts`, `google-loops-recovery.serial.test.ts` |
| Sync: `src/commands/sync`, `src/core/sync*` | 63 | 9 | 41 | 3 | 4 | 0 | 1 | Git repo fixtures (`git-fixture.ts`) and PGLite. Some serial tests for lock and watchdog preloads. | `sync-delta.test.ts`, `sync-reconcile-db-only.test.ts`, `sync-failure-ledger.serial.test.ts` |
| Schema-pack, entity types: `src/core/schema-pack`, `entities` | 60 | 2 | 26 | 3 | 2 | 0 | 0 | Filesystem pack YAML fixtures (`entity-types-pack-fixture.ts`). PGLite. | `redos-hardening.test.ts`, `link-inference-constraints.test.ts`, `schema-engine-isolation.serial.test.ts` |
| Repair and remediation: `src/core/repair`, `fence-repair`, `remediation` | 57 | 2 | 42 | 19 | 0 | 0 | 0 | PGLite and git fixtures. Some use `remediate-approval.ts`. | `generation-identity-visibility-9386.test.ts`, `repair-llm-cost.test.ts`, `repair-contextual-mode-5621.serial.test.ts` |
| Security, trust, audit, OAuth: `src/core/secret-scan`, `trust`, `audit`, `oauth*`, `guarded-http` | 52 | 5 | 27 | 3 | 1 | 4 | 0 | OAuth test server (`oauth-consent-server.ts`, `oauth.ts`), PGLite, secret-scan corpora. | `connector-trust-marker-8052.test.ts`, `trust-claim-legacy-atoms.test.ts`, `audit-slug-fallback.serial.test.ts` |
| Agent, harness, advisor: `src/core/harness`, `agent-output`, `advisor` | 39 | 5 | 22 | 2 | 3 | 0 | 0 | Agent CLIs: `agent-harness.ts` resolves `claude`, `codex`, and `hermes` binaries and checks auth (`hasClaudeAuth`, `hasCodexAuth`). | `admission-contention-retryable.test.ts`, `harness-verification-uncertainty.test.ts`, `agent-install-backup.serial.test.ts` |
| Migrations, upgrade: `src/commands/migrations`, `src/core/migrate*` | 36 | 4 | 20 | 2 | 6 | 0 | 0 | PGLite snapshots, schema history (`test/fixtures/schema-history/`), upgrade tarball (`goldens/pglite-upgrade-replay`). | `migrate-engine-resume.test.ts`, `migrations-v0_32_2-managed.test.ts`, `migrations-fresh-install-audit.serial.test.ts` |
| Large pages (no `src` import): `test/large-pages/` | 35 | 0 | 35 | 2 | 0 | 0 | 0 | PGLite, large-page fixtures (`large-page-file.ts`, `long-page-fixture.ts`). | `large-pages/conversation-facts-incremental-grammar-flag.test.ts`, `large-pages/conversation-facts-property-seeds-03-04.test.ts` |
| Git: `src/core/git*`, `hardened-git`, `git-checkout` | 25 | 7 | 2 | 0 | 5 | 0 | 0 | Real git repos (`git-fixture.ts`, `git-publication.ts`, `large-worktree.ts`). Git hermetic preload sets `gpgsign=false`. | `git-context-preload-7451.test.ts`, `git-visible-files.test.ts`, `git-commit-push-6530.serial.test.ts` |
| CLI surface (no `src` import): `test/cli-*` | 24 | 4 | 12 | 0 | 14 | 0 | 0 | Spawns the CLI (`runCli`). Help-text goldens (`cli-help-gate.ts`, `cli-golden-normalize.ts`). | `cli-json-commands.test.ts`, `cli-util-prompt.test.ts`, `cli-help-no-side-effects-3.serial.test.ts` |
| Serve, thin client, remote MCP: `src/commands/serve*`, `core/serve*`, `remote*`, `thin*` | 24 | 0 | 6 | 0 | 1 | 4 | 0 | Real HTTP servers on localhost (`serve-http.ts` `startServeHttp`, 18 files; `live-mcp-servers.ts`). Some use the MCP client. | `serve-idle-upkeep-gbra438.test.ts`, `serve-http-metrics.test.ts` |
| Brain, brainstorm: `src/core/brain*`, `brainstorm` | 22 | 6 | 6 | 0 | 5 | 0 | 0 | Filesystem brain fixtures; CLI spawn for brainstorm commands. | `chat-key-plane.test.ts`, `brain-writer.test.ts`, `brain-repo-durability.serial.test.ts` |
| Links: `src/core/link*`, `backlinks` | 20 | 0 | 4 | 1 | 0 | 0 | 0 | Pure link extraction plus PGLite for graph reads. Mostly pure. | `link-extraction-dir-whitelist-2576.test.ts`, `link-typing-explain.test.ts` |
| Autopilot: `src/commands/autopilot`, `src/core/autopilot*` | 19 | 1 | 11 | 0 | 5 | 0 | 0 | Launchd and systemd unit files written to temp dirs; CLI spawn. | `autopilot-install-repo-fallback-6755.test.ts`, `autopilot-install-wrapper.test.ts`, `autopilot-launchd-lifecycle.serial.test.ts` |
| Backup and export: `src/core/backup`, `export*`, `snapshot` | 18 | 10 | 12 | 1 | 1 | 0 | 0 | Git and filesystem fixtures; PGLite. Serial tests because of process-wide state. | `export-snapshot.test.ts`, `backup-git-env.test.ts`, `backup-verification.serial.test.ts` |
| Chronicle, timeline: `src/core/chronicle`, `timeline*` | 16 | 0 | 13 | 2 | 0 | 0 | 0 | PGLite. Pure date and ordering logic in several files. | `chronicle-auto-phase.test.ts`, `chronicle-max-events-5329.test.ts` |
| Smaller named groups: sources, reindex/reconcile, purge, loops, recall, remember, notifier, graduation, fence, storage, belief, entity (name match over primary-import groups) | ~41 | 2 | 19 | not counted | not counted | not counted | not counted | Mostly PGLite. `graduation-e2e.ts` reads `DATABASE_URL` for its Postgres target. Counts approximate. | `graduation-drain.test.ts`, `purge-deleted-parks.test.ts`, `loops-store.test.ts` |
| Long tail: 243 other primary-import groups (`core/types`, `core/creds`, `commands/import`, `core/cjk`, and similar) | 610 | 64 | 272 | 9 | 74 | 20 | 9 | Mixed. Many are pure (`cjk`, `timing-safe`, `levenshtein`, `version`), some CLI spawn (`commands/*`). | `version-history-privacy.test.ts`, `timing-safe.test.ts`, `cjk-*.test.ts` |

Note: the primary-import mapping puts 915 tests under "persistence" because `src/core/persistence/` is a 353-module layer that many tests import. For a finer split by intent, the name-based counts are: sync 257, search 251, doctor 216, large-pages 179, persistence 172, schema/migrations 162, scripts 155, pathological 129, extract 116, cycle/dream 111, facts 105, import 105, eval 104, jobs 102, transcripts 92, repair 92, AI/embedding 84, serve 78, skills 77, CLI 74. The name-based classifier is heuristic and leaves about 1,100 files in misc buckets.

### Mocks and process isolation

- 93 files use `mock.module(`, and 92 of them are `*.serial.test.ts`. Serial manifest reasons (`scripts/serial-files.tsv`) are R1 (process.env mutation), R2 (mock.module), global state, or exclusive.
- `test/pglite-in-memory-create-retry.serial.test.ts` mocks the PGLite constructor to test retry (per `docs/TESTING.md`).
- The bun test config sets `timeout = 60_000` and nine global preloads (`bunfig.toml`): database-url guard, operator env scrub, provider keys stripping, real-home guard, legacy embedding config, audit dir redirect, sync failure ledger redirect, gbrain home redirect, and git hermetic config. Per-file preloads also exist (`graduation-hooks-preload.ts`, `sync-watchdog-order-preload.ts`).
- Runner: `scripts/run-unit-parallel.sh` shards the non-serial, non-slow files across parallel `bun test` processes, then runs `*.serial.test.ts` one process per file, with an OOM rescue pass for PGLite WASM out-of-memory failures.

### API keys and network

- The unit lane is keyless by design. `provider-keys-preload.ts` strips ambient `ANTHROPIC_API_KEY` and `OPENAI_API_KEY`. `provider-env.ts` (`keylessBrainEnv`, `PROVIDER_ENV_KEYS`) builds explicit provider state.
- `ai-tripwire.ts` (`installTripwire`, 2 files use it) records every model call and every outbound `fetch` a test makes. `no-network-preload.ts` refuses `fetch` in child processes and logs URLs to `$GBRAIN_TEST_NET_LOG` for doctor goldens.
- Fake providers stand in for real ones: `longmemeval-stub.ts`, `openclaw-gateway-stub.ts`, `fake-wakeshift.ts`, `held-embedding-fixture.ts` (`FakeEmbeddings`), `npm-stub-registry.ts`, `mock-ubicloud-api.ts`, `slack-fixture.ts`, `connector-holds-fixture.ts` (fake Gmail and GitHub).
- Real-key tests exist only in `test/live/` and `test/e2e/`, which are out of scope here.

### Helpers (`test/helpers/`, 293 modules + 12 self-tests)

| Category | Modules | What they provide | Usage |
|---|---|---|---|
| PGLite lifecycle | `reset-pglite.ts`, `with-snapshot.ts`, `two-engine.ts` | `resetPgliteState` (wipe data, keep schema), narrow reset, `withColdPglite`, `GBRAIN_PGLITE_SNAPSHOT` scoping, two-brain isolation suite | `resetPgliteState` 733 call sites; `withColdPglite` in 13 files; `two-engine.ts` in the isolation suite |
| Brain builders | `managed-brain.ts`, `brain-template.ts`, `dense-hub.ts`, `inline-page-corpus.ts`, `conversation-page.ts`, `long-page-fixture.ts` | `managedBrain()` (activated brain, PGLite unless a DB URL given), template brain, seeded pages | `managedBrain()` 1,100 call sites |
| Dual backend gate | `test-backends.ts`, `db-guard.ts`, `schema-diff.ts`, `schema-catalog.ts`, `schema-history.ts`, `fake-postgres-sql.ts` | `testBackends()`, `registerPostgresTests`, `requirePostgresTestDatabase`, `assertSafeE2eDatabaseUrl`, schema snapshots and diffs across PGLite and Postgres, fake SQL recorder | 820 files use `testBackends()` |
| Shared scenario suites ("cases") | `conversation-facts-*-cases.ts`, `derivation-*-cases.ts`, `segmented-*-cases.ts`, `managed-*-contract.ts`, `engine-sql-rollback-cases.ts`, `executor-binding-matrix.ts`, `postgres-engine-sql-cases.ts`, `link-paging-scenarios.ts`, `wave-scenarios.ts` | Parameterised test bodies that run once per engine or per phase | Called from several serial and parallel files; closest thing to a behavioural contract spec |
| CLI subprocess | `cli-spawn.ts`, `cli-help-gate.ts`, `cli-command-surface.ts`, `cli-golden-normalize.ts`, `doctor-json-golden.ts`, `tty-harness.ts`, `stream-text.ts`, `wait-for.ts` | `runCli`, `runCliBatch`, `runCliMemo` (in-process memo) against `src/cli.ts`; help-text gates; normalised CLI output; PTY driver; `waitFor` polling | `runCli` 375 files (CLI-spawning set) |
| Serve and MCP | `serve-http.ts`, `live-mcp-servers.ts`, `agent-harness.ts`, `agent-envelope.ts` | `startServeHttp` (18 files), legacy HTTP server, MCP envelope checks | 18 and 12 call sites respectively |
| Git | `git-fixture.ts`, `git-publication.ts`, `git-exec.ts`, `git-coalescing-fixture.ts`, `large-worktree.ts`, `worktree-refresh-fixture.ts`, `fresh-brain-snapshot.ts` | Build-once git repo (`makeGitFixture` with `reset()`), publication fixtures, large worktrees | Git helper in 796 files |
| Connector and external fakes | `connector-fixture.ts`, `connector-holds-fixture.ts`, `slack-fixture.ts`, `held-embedding-fixture.ts`, `fake-wakeshift.ts`, `npm-stub-registry.ts`, `mock-ubicloud-api.ts`, `openclaw-gateway-stub.ts`, `longmemeval-stub.ts`, `oauth.ts` | In-process or local-port fakes for external services | Used across connectors, shared-skills, graduation, embedding |
| Golden and normalisers | `golden.ts`, `doctor-json-golden.ts`, `cli-golden-normalize.ts`, `instructions-parity.ts`, `entity-names-parity.ts`, `orphan-policy-parity.ts`, `single-write-parity.ts` | `expectGolden` with named normalisers (timestamps, durations, temp paths, sorted keys); parity dumps between engines | Golden fixtures under `test/fixtures/goldens/` |
| Timing and linearity | `work-counts.ts`, `cpu-time.ts`, `interleaved-timing.ts`, `hypervisor-steal.ts`, `seeded-random.ts` (mulberry32) | Operation-count linearity checks, CPU time, deterministic PRNG | Perf-style tests; flaky if run in parallel |
| Env and preloads | `with-env.ts`, `provider-env.ts`, `provider-keys.ts`, `no-anthropic-key.ts`, `operator-env-policy.ts`, `hermetic-preload.ts`, `database-url-guard-preload.ts`, `git-hermetic-preload.ts`, `audit-dir-preload.ts`, `sync-failures-preload.ts`, `gbrain-home-preload.ts`, `legacy-embedding-preload.ts`, `real-home-guard-preload.ts` | Scoped env overrides; global preloads from `bunfig.toml`; `hermetic-preload.ts` records every `src/` env read for the hermeticity test | `withEnv` widely used |
| Process children | `persistence-stdio-owner`, `local-ipc-process`, and other `*-process.ts` / `*-worker.ts` files under `test/fixtures/` (not helpers) | Child-process scripts for crash, lock, and kill tests | Spawned via `Bun.spawn`; see fixtures |

### Fixtures (`test/fixtures/`, 1,193 files, about 23 MB)

| Corpus | Files | Size | What it is | Rust parity use |
|---|---|---|---|---|
| `goldens/` | 79 | 11.5 MB | Pinned outputs: `doctor/` (17), `cli/` (8), `catalog/` (10), `sql-text/` (14), `pglite-upgrade-replay/` (5 files: `brain.tar.gz`, `v260`–`v262.sql.gz`, `MANIFEST.json`) plus others | High. CLI and doctor goldens are the best black-box contract. The upgrade tarball is a real PGLite brain. |
| `schema-history/` | 33 | 1.3 MB | Per-version SQL for `pglite/` (16) and `postgres/` (16) | High for migration parity. Shows exact schema history per version. |
| `ranking-shapes/` | 211 | 1.2 MB | Markdown brain fixtures under `source-a/` and `source-b/`: people, concepts, companies, meetings, notes, media, writing, images | High. Real-format markdown pages for indexing and ranking parity. Names are fictional but avoid copying them. |
| `bootstrap-corpus/` | 15 | 68 KB | 12 markdown `pages/`, beliefs, and queries | High for bootstrap and retrieval parity. |
| `calibration/` | 22 | 100 KB | `extract-takes-corpus/` (11), `holdout/` (10); takes extraction calibration | Medium. Eval inputs. |
| `guards/` | 469 | 5.5 MB | Good and bad example trees for structural guard scripts (`check-layering`, `check-orphan-modules`, `check-postgres-lane-coverage`) | Low for Rust. Guards are TypeScript-specific. |
| `nightly-watch/` | 39 | 292 KB | Nightly master-red and watch scenarios | Medium. |
| `skill-evals/`, `skill-catalog/`, `skill-catalog-query/`, `skill-resolver/`, `brain-first-skills/` | 94 | ~600 KB | Skill trees with brain and meeting transcripts for skill evaluation | Medium. Skill files are format-level inputs. |
| `agent-contract/` | 19 | 108 KB | `v1/` contract fixtures including a `journey/` subfolder | High. Agent-facing JSON contract. |
| `cli-contract/`, `memory-verbs/`, `memvelope/`, `q2-dev-phrasings/`, `retrieval-quality/`, `short-code-alias/` | 23 | ~100 KB | CLI and retrieval contracts, dev phrasings | High for retrieval and CLI parity. |
| `transcripts/`, `conversation-formats/`, `claude-code-paste/`, `hook-transcript.jsonl` | ~30 | ~200 KB | Agent session JSONL, `chatgpt-conversations.json`, Claude Code paste | High for transcript-parser parity. |
| `openclaw-*` (gateway, reference-minimal, mixed-merge, plugin-real, compact-resolver) | 45 | ~250 KB | OpenClaw workspace fixtures | Low (OpenClaw integration). |
| `claw-test-scenarios/`, `generic-agents-workspace/`, `connectors/`, `slack/`, `export-consumer/`, `backlinks-parity/` | 20 | ~200 KB | Scenario workspaces and connector payloads | Medium. |
| JSONL eval sets | 8 files at the top of `fixtures/` | ~25 KB | `longmemeval-mini`, `longmemeval-mixedcase`, `longmemeval-nightly`, `notability-eval-public`, `whoknows-eval`, `contradictions-mini`, `dream-budget-schema-v1`, `hook-transcript` | High for eval parity (small, public). |
| Ranking JSON | 2 files | 280 KB | `keyword-arm-ranking.json`, `fold-hook-noop-6712.json` | High. Concrete ranking outputs. |
| Crash, lock, and process workers | 45 `.ts` and `.mjs` files at the top of `test/fixtures/` (plus `.c` and `.ps1`) | small | Child scripts for crash-kill, lock, WAL, and watchdog tests (e.g. `reconcile-crash-worker.ts`, `pglite-lock-process.ts`, `mcp-stdio-round-trip-driver.ts`) | Not reusable as data. They define the crash-recovery and lock scenarios Rust must reproduce. |
| Binary and misc | `images/tiny.avif`, `tiny.heic`, `guarded-http-localhost.{crt,key}`, `windows-backup-cmdlet-protect.ps1`, `native-export-faults.c` | small | Media and platform-specific fixtures | Low. |

### Parity risks

- The dual-arm pattern (820 files via `testBackends()`) assumes two engines with the same behaviour. A single embedded Rust store cannot run the "Postgres arm". Any parity suite built from these files needs a decision on what the second arm means.
- Golden files (`goldens/doctor`, `goldens/cli`, `goldens/catalog`, `goldens/sql-text`) pin exact text output after named normalisers. Small wording or whitespace drift in Rust fails them; `sql-text` goldens are not portable at all.
- Crash-recovery and lock tests (`*-crash-worker.ts`, `*-lock-process.ts`, `serve-sync-claim-barrier.ts`, `pglite-disconnect-watchdog-harness.ts`) kill processes at exact points and then check repair. Embedded storage needs equivalent atomicity and recovery.
- Upgrade replay (`goldens/pglite-upgrade-replay/brain.tar.gz`) and `pglite-resetwal`/`pglite-repair` tests depend on PGLite on-disk format. Rust either reads that format or drops these tests.
- Timing and linearity tests (`work-counts.ts`, `hypervisor-steal.ts`, `worker-rss.test.ts`, `zombie-reap`) assert CPU and memory ratios. They are flaky on shared runners and will vary across the Rust runtime.
- The keyless unit lane depends on the bunfig preloads (provider keys, `GBRAIN_HOME`, audit dir, sync failure ledger). Rust test harnesses must reproduce that isolation or tests will touch the operator's real home.

### Open questions for Garry

- Should the Rust parity harness run the TypeScript test suite's JSON and CLI contract fixtures against the Rust binary (black-box), rather than porting the 5,567 TypeScript tests file by file? The black-box route reuses `goldens/`, `agent-contract/`, and `cli-contract/` with the least rework.
- Is reading an existing PGLite data directory (the `pglite-upgrade-replay` tarball) in scope for the Rust port? That decides whether migration tests and the upgrade fixture are inputs or dropped.
- The Rust code lives in gbrain (plan decision D1), so `test/fixtures/` (23 MB, including 469 guard trees) needs no copy. Which corpora does the Rust arm read? The likely set is `ranking-shapes`, `bootstrap-corpus`, `goldens`, `schema-history` and the JSONL eval sets.
- What is the first Rust milestone for tests: CLI and MCP contracts only, or full subsystem parity? That sets whether the 1,000-plus engine and persistence tests are in or out of scope.

## E2E suites and parity-test candidates

Reference: `garrytan/gbrain` (v0.60.x, read-only). Counts below come from `find`/`rg` runs in this session unless marked "(estimate)" or "(unverified)".

### Scope and counts

| Area | Files | Notes |
|---|---|---|
| `test/e2e/` (all files) | 947 | 921 `*.test.ts` (895 `.test.ts` + 26 `.serial.test.ts`), 8 `.ts` helpers and fixtures, 16 `.md` fixtures, 6 bench `.ts` under `bench-vs-openclaw/` plus `fixtures/` |
| `test/e2e/*.test.ts` by suffix | see below | `-postgres` 509 by name, `-pglite` 37 by name, no suffix 378 |
| `test/live/` | 1 | `test/live/decide-typesafe.live.test.ts`, skipped unless `GBRAIN_LIVE_TYPESAFE=1` and a TypeSafe key is set |
| `*.live.test.ts` under `test/e2e/` | 2 | `openrouter-anthropic-subagent-replay`, `openrouter-deepseek-subagent-replay` |
| Top-level `test/*.test.ts` (unit lane) | 4,637 | 418 `.serial.test.ts`, 46 `.slow.test.ts`. Many Postgres arms of shared suites live here |
| `tests/` | 20 | `tests/heavy/` (ops shell and TS workload helpers, SQL fixtures, README) and `tests/docker/` (offline bootstrap e2e, Dockerfile) |
| `evals/` | 518 | Eval harnesses (brainbench, longmemeval, take-grading, fence-repair-tier3 and others). Only 12 files reference provider calls (grep) |
| `docs/contracts/public-surface.json` | 1 | Machine-readable surface: 220 `cli-command`, 613 `cli-flag`, 186 `mcp-tool`, 855 `mcp-param`, 503 `config-key`, plus an `exit-code` object |
| `docs/contracts/qm-memory-provider/` | 6 | `v1.json` to `v5.json` and README |
| `test/fixtures/` | 1,193 | Includes `goldens/` (20 subdirectories), `cli-contract/help-baseline.json`, `agent-contract/` |
| `spec/tla/` | TLA+ specs | Drain-lease and refresh-barrier models with `.cfg` and mutants. Not runtime tests |

The brief said about 926 files. The actual count is 947 files, of which 921 are test files.

### How a test selects its backend

Three mechanisms, all in `test/helpers/` and `test/e2e/helpers.ts`:

1. Shared-suite arms. Scenario files in `test/*.test.ts` register backends through `testBackends()` and `registerPostgresTests()` (`test/helpers/test-backends.ts`). The default is PGLite. A safe `DATABASE_URL` enables the Postgres arm. 349 of the `test/e2e/` files are thin wrappers that call `registerPostgresTests`, so most of the `-postgres` files are wrappers and not separate scenarios. `docs/TESTING.md` (section "Postgres-arm lanes") explains that the unit, serial and slow lanes unset `DATABASE_URL`, so the Postgres arm only runs in a lane that names the file.
2. Direct engine tests. 310 `test/e2e/` files import `PGLiteEngine` or `PostgresEngine` directly. These drive the engine class, not a public surface.
3. Subprocess or network tests. 48 files spawn `src/cli.ts`, 25 use MCP stdio, and about 43 call HTTP through `fetch` or `serve-http`.

Gating conventions: `DATABASE_URL` is required by `setupDB()` (`test/e2e/helpers.ts:105`). `hasDatabase()` is exported at `test/e2e/helpers.ts:89`. The e2e runner `scripts/run-e2e.sh` also runs each file in `scripts/e2e-backend-matrix.txt` a second time through PgBouncer. `scripts/e2e-live-key-only.txt` lists the four keyed live files that the default run skips (two OpenRouter replay tests, two Voyage tests).

### Setup and teardown

- `test/e2e/helpers.ts` (413 lines) is the common Postgres helper. `setupDB()` connects, clears fixture data, configuration and sync identity but keeps `config.version` and the stored embedding identity (per `docs/TESTING.md`). `setupDB({ replayMigrations: true })` replays migrations. `importFixtures()` and `importFixture()` load markdown from `test/e2e/fixtures/`. `teardownDB()` and `removeMembers()` clean up. `dumpDBState()` is used for diffs.
- `test/helpers/cli-spawn.ts` (252 lines) spawns `[process.execPath, '--no-env-file', CLI_PATH]`. It strips `DATABASE_URL`, `GBRAIN_DATABASE_URL` and `GBRAIN_REMOTE_CLIENT_SECRET`, sets `GBRAIN_SKIP_STARTUP_HOOKS=1`, and sets both `HOME` and `GBRAIN_HOME` from `opts.home`. It already has a test seam `_setSpawnTarget()` (line 73) that replaces the command prefix. This is the natural place for a binary override.
- `test/helpers/golden.ts` writes and compares `{ normalizer, golden }` JSON with sorted keys. Normalizers include `scrubTimestamps`, `scrubDurations`, `scrubPaths`, `scrubKeys` and `mapStrings`. `GBRAIN_TEST_UPDATE_GOLDENS=1` regenerates them.
- `test/fixtures/mcp-stdio-round-trip-driver.ts` is a stdio MCP server on an in-memory PGLite brain with statement recording.
- PGLite is embedded WASM. Each test creates an in-memory or temporary-directory brain. Postgres tests create a scratch database per capture (for example `gbrain_test_doctor_golden_<uuid>` in `test/e2e/doctor-json-golden.test.ts`).

### Backend classification (by file, counts from grep)

| Backend or dependency | Approx. files | Typical pattern |
|---|---|---|
| Needs Postgres (`DATABASE_URL`) | about 490 reference `DATABASE_URL`, `setupDB` or `registerPostgresTests` | `-postgres` suffix, `setupDB()`, `registerPostgresTests` |
| Runs on PGLite (keyless, in-process) | about 310 reference PGLite | `-pglite` suffix, `PGLiteEngine`, `testBackends()` |
| Needs provider keys (network) | about 70 reference provider keys (grep for `*_API_KEY`) | `skipIf` on key, `*.live.test.ts`, `e2e-live-key-only.txt` |
| Spawns the CLI as a subprocess | 48 (`src/cli.ts`) | `runCli`, `cli-spawn.ts`, `Bun.spawn` |
| MCP over stdio or HTTP | 25 stdio, about 43 HTTP | `StdioClientTransport`, `StreamableHTTPClientTransport`, `serve-http-*` |
| Golden or snapshot | 83 by grep (57 without a backend suffix) | `expectGolden`, `GOLDENS_DIR`, `*-golden.test.ts` |
| Docker or shell, ops-shaped | `tests/heavy/` (shell scripts plus `_*_workload.ts` helpers), `tests/docker/` (`bootstrap-e2e.sh`, `bootstrap-e2e-inner.sh`) | Shell plus `_*_workload.ts` helpers |

Filename suffixes: `-postgres` (Postgres arm or Postgres-only), `-pglite` (PGLite-only), `-parity` (compares two engines or two code paths; 36 files under `test/e2e/` contain `parity` in the name), `.serial` (one process per file, listed in `scripts/serial-files.tsv`), `.slow` (lane-excluded, top level only), `.live` (paid providers, named per file). `-golden` marks golden output comparisons. `-contract` and `-conformance` mark shared case lists (for example `write-contract-conformance`).

### Grouping by subsystem (top-level `test/e2e/`, filename prefix counts)

| Theme | Files (approx.) | Examples (verified) |
|---|---|---|
| Persistence and sync | 44 + 38 (prefix counts) | `persistence-http-liveness.test.ts`, `sync-lock-recovery.test.ts`, `sync-credential-preflight.test.ts` |
| Serve, HTTP and MCP transport | 19 (`serve-` prefix) | `serve-http-meta.test.ts`, `serve-http-oauth.test.ts`, `mcp-search-transport-matrix.test.ts`, `http-transport.test.ts` |
| Conversation and chronicle | 28 + 12 | `chronicle-*-postgres.test.ts`, `conversation-parser-pglite.test.ts` |
| Managed connectors and migrations | 26 + 17 + 8 | `managed-*`, `migration-flow.test.ts`, `migrate-engine-pglite-to-postgres.test.ts` |
| Repair, fence and facts | 23 + 5 + 15 | `repair-*`, `fence-*`, `facts-forget.test.ts` |
| Doctor, graduation, bootstrap | 14 + 16 + 9 | `doctor-json-golden.test.ts`, `graduation-cli.test.ts`, `bootstrap-*.serial.test.ts` |
| Search, embedding, vector | 11 + 8 + 8 (`search-`, `embedding-`, `vector-` prefixes) | `search-*`, `embedding-column-pglite.test.ts`, `vector-candidate-safety-postgres.test.ts` |
| Dream, autopilot, minions | 11 + 6 + 8 | `dream-*-pglite.test.ts`, `autopilot-*`, `minions-shell-pglite.test.ts` |
| Auth, access, takes | 10 + 9 (`auth-`, `takes-` prefixes); `access-*` not counted | `auth-permissions.test.ts`, `takes-postgres.test.ts`, `access-*` |
| Links, slugs, markdown | `link*` grep 16, `slug*` grep 6 | `link-relationships-postgres.test.ts`, `slug-handles-postgres.test.ts`, `frontmatter-migration.test.ts` |
| Code intelligence | 6 | `code-indexing.test.ts`, `code-edges-read-parity.test.ts` |
| Shared skills and skillpacks | `skillopt-*` 6 | `skillopt-pglite.serial.test.ts`, `skillpack-third-party.test.ts` |

Counts come from `ls test/e2e/*.test.ts | awk` on the first hyphen token, so they overlap (a name can match two themes).

### Tier 1: run unchanged as black-box, or with a thin adapter

Criteria: drives `gbrain` through CLI, MCP or HTTP, checks stdout, JSON or response shape; does not import engine classes or SQL. About 64 `test/e2e/` files match this pattern before deduplication (56 unique by grep). Root-level golden and contract tests add about 25 more.

Top candidates (grouped; all paths verified to exist):

CLI surface and help goldens:
1. `test/cli-goldens.test.ts` (uses `test/helpers/cli-spawn.ts`; goldens in `test/fixtures/goldens/cli/`: `help-and-errors.json`, `tools-json.json`, `thin-client-cases.json`, `dispatch-phase.json`)
2. `test/cli-contract.test.ts` (imports `src/cli/command-table.ts`; adapter needed, or compare to `test/fixtures/cli-contract/help-baseline.json`)
3. `test/cli-help-grammar.test.ts`
4. `test/cli-help-discoverability.test.ts`
5. `test/cli-help-without-brain.test.ts`
6. `test/export-help.test.ts`
7. `test/jobs-subcommand-help.test.ts`
8. `test/dream-help-json-8510.test.ts`
9. `test/schema-cli-contract.test.ts`
10. `test/error-registry-6317-contract.test.ts` (error codes and exit codes)
11. `test/e2e/cli-read-startup-round-trips.test.ts`
12. `test/e2e/worker-readiness-cli.test.ts`
13. `test/e2e/graduation-cli.test.ts`
14. `test/e2e/non-tty-output.serial.test.ts`

MCP and HTTP surface:
15. `test/mcp-tool-list-snapshot.test.ts` (spawns a driver script with `Bun.spawn`)
16. `test/mcp-surface.test.ts`
17. `test/mcp-advertised-surface.test.ts` (imports `src/mcp/surface.ts`; adapter or golden)
18. `test/serve-stdio-roundtrip.test.ts` (MCP SDK spawns `gbrain serve`; best single stdio check)
19. `test/serve-request-round-trips.test.ts`
20. `test/serve-http-route-golden.test.ts` and `test/serve-http-route-runtime-golden.test.ts` (goldens in `test/fixtures/goldens/serve-http/routes.json` and `routes-runtime.json`)
21. `test/e2e/http-transport.test.ts`
22. `test/e2e/mcp-search-transport-matrix.test.ts` (PGLite-based, uses both stdio and HTTP)
23. `test/e2e/serve-http-meta.test.ts`
24. `test/e2e/serve-http-consent.test.ts`
25. `test/e2e/serve-http-oauth.test.ts` (OAuth transport contracts)
26. `test/e2e/serve-http-api-keys.test.ts`
27. `test/e2e/serve-http-member-tokens.test.ts`
28. `test/e2e/serve-http-ingest-webhook.test.ts`
29. `test/e2e/serve-http-multi-agent.test.ts`
30. `test/e2e/sources-remote-mcp.test.ts`
31. `test/e2e/mcp-legacy-token-dcr-surface-9266.test.ts`
32. `test/e2e/thin-client.test.ts`
33. `test/e2e/trust-route-matrix.test.ts`

Golden and contract checks on CLI or MCP output:
34. `test/doctor-json-golden.test.ts` (and `test/e2e/doctor-json-golden.test.ts`, Postgres; PGLite twin is root-level)
35. `test/doctor-registry-golden.test.ts`
36. `test/e2e/doctor-hot-checks-golden.test.ts` (Postgres-specific checks; needs a filter)
37. `test/export-surface-golden.test.ts`
38. `test/agent-contract-goldens.test.ts` and `test/agent-contract-a0.test.ts` (fixture `test/fixtures/agent-contract/v0.60.37-json-documents.json`)
39. `test/harness-format-contract.test.ts`
40. `test/memory-verbs-conformance.test.ts`
41. `test/skills-conformance.test.ts`
42. `test/hybrid-golden.test.ts` (golden `test/fixtures/goldens/hybrid/`)
43. `test/evidence-delivery-golden.test.ts` (golden `test/fixtures/goldens/evidence-delivery/`)

Markdown round trip (import, export, sync through public surfaces):
44. `test/export-import-slug-roundtrip.test.ts` (imports `runExport` and `importFromFile` directly; convert to CLI calls)
45. `test/e2e/ingestion-roundtrip.test.ts`
46. `test/e2e/cjk-roundtrip.test.ts` (PGLite, public import and search)
47. `test/large-page-roundtrip.test.ts`
48. `test/frontmatter-writers-roundtrip.test.ts`
49. `test/write-roundtrips-gbra156.test.ts`
50. `test/backup-archive-roundtrip-5312.test.ts`
51. `test/export-snapshot.test.ts`
52. `tests/heavy/` shell scripts (`tests/heavy/sync_timeout_rescue.sh`, `tests/heavy/read_latency_under_sync.sh`, `tests/heavy/measure_rss.sh`) are ops-shaped and Postgres-leaning; optional, not parity.
53. `tests/docker/bootstrap-e2e.sh` (offline bootstrap: scripted interview, render, resume; keyless PGLite brain; the binary invocation inside `bootstrap-e2e-inner.sh` is unverified)
54. `test/e2e/upgrade.test.ts`, `test/e2e/migration-flow.test.ts` (verify each uses only the CLI)
55. `test/e2e/skills.test.ts`, `test/e2e/facts-forget.test.ts`, `test/e2e/job-isolation.test.ts`, `test/e2e/zombie-reaping.test.ts`, `test/e2e/mechanical.test.ts`, `test/e2e/supervisor-stop-drain-5062.test.ts` (keyless CLI or process tests; check each for engine imports before porting)

Tier 1 is the highest-value parity suite because it tests what agents see. The remaining work is to make the binary path configurable.

### Tier 2: port the logic (pure functions, clear inputs and outputs)

Criteria: pure or near-pure functions with fixture inputs. The grep heuristic found 1,181 top-level files with no engine, DB or spawn symbol. That is an upper bound: many still use helper modules that open a brain. About 150 to 200 files are likely pure (estimate). The list below is a verified-by-name starting set (about 60):

Slugs and paths:
1. `test/slug-validation.test.ts` (`slugifySegment`, `slugifyPath`, `SLUG_SEGMENT_PATTERN` from `src/core/sync.ts`)
2. `test/slug-unicode-scripts.test.ts`
3. `test/colon-slug-windows-5032.test.ts`
4. `test/e2e/slug-stamp-double-hyphen.test.ts`
5. `test/client-slug-fence.test.ts`
6. `test/frontmatter-validate-slug-565.test.ts`

Markdown, normalization and hashing:
7. `test/markdown.test.ts` (784 lines; `parseMarkdown`, `serializeMarkdown`, `splitBody`, `sourceGitScope`)
8. `test/markdown-serializer.test.ts`
9. `test/markdown-code-equivalence.test.ts`
10. `test/markdown-validation.test.ts`
11. `test/markdown-leading-blank-frontmatter.test.ts`
12. `test/markdown-own-timeline-section-7738.test.ts`
13. `test/markdown-fence-parse-budget.test.ts`
14. `test/normalized-file-hash.test.ts` (`normalizeForHash`, `computeContentHash`)
15. `test/fence-format-reference.test.ts`
16. `test/fence-extraction.test.ts`
17. `test/fence-marker-code-context.test.ts`
18. `test/fence-locators-code-quoted-8020.test.ts`

YAML and frontmatter:
19. `test/yaml-lite.test.ts`
20. `test/yaml-1-2-frontmatter.test.ts`
21. `test/yaml-load-bounded-only.test.ts`
22. `test/frontmatter-alias-bomb.test.ts`
23. `test/frontmatter-security.test.ts`
24. `test/frontmatter-inference.test.ts`
25. `test/frontmatter-non-string-fields.test.ts`
26. `test/frontmatter-validate-many-paths.test.ts`
27. `test/lint-frontmatter.test.ts`
28. `test/data-frontmatter.test.ts`

Link extraction and link typing:
29. `test/link-extraction.test.ts` (2,389 lines; mixes parsing with `BrainEngine` cases. Split before porting.)
30. `test/link-extraction-line-grammar.test.ts`
31. `test/link-extraction-relative-path.test.ts`
32. `test/link-extraction-code-refs.test.ts`
33. `test/link-extraction-dir-whitelist-2576.test.ts`
34. `test/link-source-namespaced-regex.test.ts`
35. `test/link-typing-units.test.ts`
36. `test/link-validity.test.ts`

Chunking and text:
37. `test/chunker-timeout.test.ts` (code chunker from `src/core/chunkers/code.ts`)
38. `test/chunker-version-gate.test.ts`
39. `test/chunk-moves.test.ts`
40. `test/e2e/chunker-takes-strip.test.ts`
41. `test/cjk.test.ts`
42. `test/cjk-word-stats.test.ts`
43. `test/fixtures/goldens/chunker/word-count-fuzz.json` (golden fixture for word counting; drive `src/core/cjk.ts` or chunker helpers)

Search ranking math:
44. `test/rrf-source-key.test.ts` (`rrfFusion`, `rrfFusionWeighted` in `src/core/search/hybrid.ts`)
45. `test/cosine-rescore-column.test.ts`
46. `test/ranking-inversion-895.test.ts`
47. `test/rank-entities.test.ts`
48. `test/dedup.test.ts`
49. `test/search-frontmatter-where.test.ts` (verify no engine import)
50. `test/fixtures/keyword-arm-ranking.json` (fixture for keyword ranking; check its consumer)

Other pure helpers:
51. `test/doctor-cause-rank.test.ts`
52. `test/doctor-frontmatter-partial.test.ts`
53. `test/advisor-ranking-eval.test.ts`
54. `test/embed-chunk-statistics.test.ts`
55. `test/conversation-parser-normalize-block.test.ts`
56. `test/conversation-parser-transcript-signals.test.ts`
57. `test/eval-longmemeval-parse-args.test.ts`
58. `test/legacy-slug-delete.test.ts`
59. `test/hardened-git-held-chunk-gbra133.test.ts`
60. `test/cycle-synthesize-chunker.test.ts`

Several Tier 2 items call `chunker-*` internals that may depend on `src/core/chunkers/*.ts` helpers (4,362 lines total). Port the golden inputs first (for example the word-count fuzz set), then the unit assertions.

### Tier 3: do not port (internal tests)

Keep these in the TypeScript reference or rewrite as Rust-internal tests with new expectations:

- SQL shape and catalog: `test/engine-sql-*.test.ts`, `test/e2e/schema-catalog-golden.test.ts`, `test/engine-sql-sql-text.test.ts` with `test/fixtures/goldens/sql-text/` (14 files), `test/postgres-rls-scope-inventory.test.ts` with `test/fixtures/goldens/rls-scope-inventory.json`, `test/e2e/cosine-rescore-sql-postgres.test.ts`, `test/e2e/vector-candidate-safety-postgres.test.ts`, `test/e2e/vector-plan-real-column-postgres.test.ts`.
- Migration and schema history: `test/e2e/apply-migrations-*.test.ts`, `test/e2e/migrate-engine-pglite-to-postgres.test.ts`, `test/e2e/fixture-reset-postgres.test.ts`, `test/migrations-golden.test.ts`, `test/fixtures/goldens/pglite-upgrade-replay/` (5 files), `tests/heavy/pg_upgrade_matrix.sh` with `tests/heavy/fixtures/down-mutate-pre-v*.sql`.
- Postgres locking, pooling, and concurrency: `test/e2e/sync-lock-*-postgres.test.ts`, `test/e2e/pgbouncer-teardown.test.ts`, `test/e2e/audit-pooler-misroute-postgres.test.ts`, `test/e2e/persistence-writer-admin-lock.test.ts`, `tests/heavy/sync_lock_regression.sh`, `test/e2e/analyze-yields-to-autovacuum-postgres.test.ts`.
- Engine internals: `test/e2e/pglite-cli-exit.serial.test.ts`, `test/e2e/migrate-engine-pglite-to-postgres.test.ts`, `test/postgres-engine-gauge-golden.test.ts` with `test/fixtures/goldens/postgres-engine-gauge/`, `test/e2e/jsonb-roundtrip.test.ts`, `test/e2e/code-edges-jsonb-postgres.test.ts`.
- Snapshot internals: `test/pglite-snapshot-timezone.serial.test.ts`, `test/fixtures/goldens/catalog/*`. These check PGLite and Postgres catalog snapshots, which an embedded Rust store will not have.
- LLM and provider behavior: `test/e2e/*-live.test.ts`, `test/live/decide-typesafe.live.test.ts`, `test/e2e/voyage-*.test.ts`. Keep them as optional opt-in checks, not parity.
- Heavy and performance: `tests/heavy/*.sh`, `test/e2e/bench-vs-openclaw/`, `test/e2e/bench-sync-pass-memory.test.ts`. Useful later as performance baselines.

Rough tier totals (estimates, derived from the greps above):

| Tier | Files (approx.) | Basis |
|---|---|---|
| Tier 1 black-box | 80 to 100 | 56 unique e2e surface-driven files plus about 25 root-level CLI, MCP, HTTP or golden tests (estimate), plus 2 shell scripts |
| Tier 2 pure logic | 150 to 200 | 1,181 grep-clean top-level files minus helper-coupled ones; 60 verified starting names |
| Tier 3 do not port | about 900 e2e files (remainder after Tier 1 and Tier 2) plus about 3,400 top-level unit files that match an engine, DB or spawn symbol | Engine, SQL, Postgres arm, migration and live provider tests |

Test-case counts are not measured. Run `bun test --dry-run` or a listing pass before publishing counts (unverified).

### Parity harness design

Goal: run the same CLI, MCP and HTTP test bodies against either the TypeScript `gbrain` or a Rust binary, and compare outputs under a normalizer.

1. Binary selection through an environment variable. Extend `test/helpers/cli-spawn.ts`: when `GBRAIN_PARITY_BIN` is set, replace the prefix `[process.execPath, '--no-env-file', CLI_PATH]` with `[GBRAIN_PARITY_BIN]`. The existing `_setSpawnTarget()` seam already supports this. Do the same for the MCP stdio tests. `StdioClientTransport` takes a `command`, so the test should pass the Rust binary and `serve` as args. HTTP tests should use the same override where they spawn a server.
2. Hermetic environment. Keep the existing rules: strip `DATABASE_URL`, `GBRAIN_DATABASE_URL` and `GBRAIN_REMOTE_CLIENT_SECRET`; set `HOME` and `GBRAIN_HOME` to a temp dir; set `GBRAIN_SKIP_STARTUP_HOOKS=1`. The Rust binary must accept the same environment variables.
3. Init path. The Tier 1 tests start from `gbrain init --pglite` (the serve-stdio test does this). The Rust binary needs an equivalent embedded init, or the adapter maps `--pglite` to its embedded store. Decide this before writing tests (see open questions).
4. Golden files. Reuse `test/fixtures/goldens/` as is. The format is `{ normalizer, golden }` with sorted keys. Port the normalizers (`scrubTimestamps`, `scrubDurations`, `scrubPaths`, `scrubKeys`, `stableStringify`) to a shared module. The Rust side reads the same files and applies the same normalizer name. A normalizer mismatch is a test bug, not a parity failure.
5. Surface checklist. Add one test that loads `docs/contracts/public-surface.json` and checks each `cli-command`, `cli-flag`, `mcp-tool`, `mcp-param` and `config-key` against the binary (`--help` output, `tools/list` response, config keys). This gives a percentage score and is cheap to run. The counts are 220, 613, 186, 855 and 503.
6. Adapter for TypeScript-internal imports. Tests that import `src/cli/command-table.ts`, `src/core/verbs.ts` or `src/mcp/surface.ts` need a generated JSON export. Generate it once from the TypeScript reference and commit it under `docs/contracts/`. The Rust side reads the JSON.

Byte-stable outputs (must match after the normalizer):
- `gbrain --help` text and `help-baseline.json`; `tools/list` JSON (`test/fixtures/goldens/cli/tools-json.json`); exit codes and error envelopes (`help-and-errors.json`).
- `public-surface.json` entries (names, flags, parameter names, exit codes).
- Serialized markdown files from export and round-trip (frontmatter key order, body bytes, trailing newline). These are the brain format and must match exactly.
- Golden JSON for `doctor --json` after normalization (`doctor-json-v1`), and the serve-http route list (`routes.json`).

Shape-stable outputs (keys, types and ordering, values may differ):
- MCP and HTTP response envelopes (JSON-RPC `result`, `error.code`, `content` arrays). Ids, timestamps, UUIDs and durations are masked.
- Search results: slugs and their order are required; scores are compared with a tolerance (relative 1e-6 or similar, because float summation order can differ). Tie ordering must be defined by slug.
- Stats and counts (page counts, chunk counts) must match exactly.
- Paths: normalize to placeholders with `scrubPaths`.

### Parity risks

- Embedded store vs Postgres catalog: `doctor --json` and `schema` goldens include Postgres-only checks (pg_stat, catalog grants, RLS flags). A Rust binary will never match them byte for byte. Normalize them out or split by backend.
- Float ordering in search: RRF fusion (`src/core/search/hybrid.ts`) and cosine rescoring can reorder ties. Compare slugs in order, scores with tolerance.
- Timestamps and durations in every JSON surface: the normalizer must mask them consistently (`scrubTimestamps`, `scrubDurations`).
- Snapshot and clock behaviour: `GBRAIN_PGLITE_SNAPSHOT` and `pglite-snapshot-timezone` mean the TypeScript side has a prebuilt snapshot. A Rust binary without that behaviour may differ on first-run output such as init messages.
- Markdown serialization: frontmatter key order, line endings and trailing newlines are part of the brain format. Any normalizer that hides them weakens the check.
- Error text: many error tests match human message text. Compare error codes and exit codes exactly, and message text only as a substring.

### Open questions for Garry

- Should the Rust binary keep the `gbrain init --pglite` command name and flags, or does the port use a new embedded init? This decides whether Tier 1 tests run unchanged.
- Is byte-identical JSON required for `doctor --json` and CLI help, or is shape-level parity enough for v1? The golden format already supports both.
- Is the MCP HTTP transport (`serve --http`, OAuth, member tokens) in scope for the first Rust release? About 20 Tier 1 files depend on it.
- Should the Tier 2 unit logic (1,181 grep-clean top-level test files) be ported in the Rust repo, or should only the e2e and golden fixtures be shared?
- Should the `public-surface.json` checklist be the release gate for parity?

