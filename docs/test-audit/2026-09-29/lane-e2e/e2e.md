# Test audit — LANE=e2e (test/e2e)

Read-only discovery. Checkout at `2ede415` (v0.59.11.0). The tree was left clean after every probe (`git status --short` came back empty). Method: the openclaw test-audit skill, AGENTS.md/CLAUDE.md, and TESTING.md §"Coverage responsibilities before consolidation". Costs come from `scripts/ubicloud/weights.json` (`e2e:<path>` ms per file). 16 newer files have no weight entry.

## CI routing facts that shape every verdict

- **Unit shards exclude `test/e2e/*`** (`scripts/test-shard.sh:93`). A PGLite-only e2e file executes only in the e2e lanes.
- **The e2e lanes:**
  - **PR/push `selected-e2e`**: diff-selected via `select-e2e.ts`. Escape-hatch paths (`operations.ts`, `src/core/ops/`, `skills/`, workflows, `package.json`, …) select ALL files, minus `E2E_EXCLUSIONS`. Runs sequentially per shard through `run-e2e.sh` with `DATABASE_URL`. **No provider keys** are passed.
  - **Named jobs**: `jsonb-parity`, `tier1`, and `tier2` (skills.test.ts, with keys).
  - **Nightly `coverage-full-e2e`**: the whole `test/e2e/*.test.ts` glob, 4 shards, with coverage, plus OPENAI/ANTHROPIC keys (no VOYAGE/OPENROUTER/GOOGLE).
- **`run-e2e.sh` scrubs `GBRAIN_REAL_*` / `HERMES_` / `GROK_` / `OPENCODE_`**, so the real-agent door files structurally skip in every e2e lane. Their venue is `heavy-tests.yml`.
- **`persistence-validation.yml`** is `workflow_call`ed from `test.yml` on every PR. By name it runs `test/e2e/reconcile-crash*.test.ts` (postgres × Bun 1.3.11/1.3.13), `reconcile-pgbouncer`, `extract-atoms-page-state`, and `scripts/persistence/matrix.ts`.
- **No PgBouncer service in `e2e.yml`**, so files gated on `GBRAIN_PGBOUNCER_URL` are skip-only in GitHub e2e. They execute only under `ci:local`/`ci:ubicloud`.

## Category counts (312 files, 71,361 LOC, 2,877 s)

| Category | Files | LOC | ms (weights) | Verdict |
|---|---:|---:|---:|---|
| Real Postgres (setupDB / PostgresEngine / engine loops / fixtures) | 165 | 36,930 | 1,449,559 | Postgres owner; keep by default |
| Postgres wrappers of shared scenarios (`registerPostgresTests` / `import '../x.test.ts'`) | 22 | 78 | 491,686 | Parity arms, NOT duplicates. **Exception: 3 attendance wrappers re-run the PGLite arm (Candidate 2)** |
| PGLite-only or pure (never touch Postgres) | 113 | 30,538 | 927,437 | Lane-misplaced. They hold the Postgres runner sequentially and run on PRs only when selected. Move-lane candidates, not deletions. Inventory: `pglite-files.txt` |
| Skip-only in every e2e lane (door binaries / never-provided keys) | 12 | 3,815 | 8,151 | Doors owned by heavy-tests; 4 live files never execute in any CI |

Key-gated behaviour: on PR `selected-e2e`, every OPENAI/ANTHROPIC-gated describe skips (no secrets are passed). Nightly executes them. VOYAGE/OPENROUTER-gated tests execute nowhere in CI.

## Top candidates (full evidence)

### 1. `test/e2e/mcp.test.ts`: delete (HIGH confidence)
- **Tests:** "E2E: MCP Tool Generation > operations generate valid MCP tool definitions" and "> MCP server module can be imported".
- **What it can detect:** only that `operations` has at least 30 entries with truthy name/description and contains 9 names, plus that `server.ts` exports two functions. The first test *re-implements* the ParamDef→JSON-Schema mapping inline. Its copy has already drifted: it lacks the `default` key and recursive `items` that the real `src/mcp/tool-defs.ts:paramDefToSchema` emits. So it asserts properties of its own copy.
- **Mutation probe:** I set `buildToolDefs` to emit `required: []` and made `paramDefToSchema` drop `description`.
  - `bun test test/e2e/mcp.test.ts` → **2 pass, 0 fail** (detects nothing).
  - The owner `test/mcp-tool-defs.test.ts` → **4 fail**: "output equals pre-extraction inline mapping byte-for-byte", "put_page warns…", "strictParams… real dry_run", "paramDefToSchema preserves description on nested items".
- **Non-test callers of the seam:** none needed. It reads the public `operations` array and `server.ts` exports.
- **Surviving owners:**
  - `test/mcp-tool-defs.test.ts`: `buildToolDefs` byte-equality, "preserves operation count", "every def has object inputSchema with properties + required array".
  - `test/mcp-stdio-gate-list.test.ts`: the live stdio tools/list.
  - Op-name presence: e.g. `test/operations-trust-boundary.test.ts` (find_orphans etc.).
  - Module import is exercised by `test/mcp-stdio-source-preflight.test.ts` and `test/checkpoint-harvest.serial.test.ts` (`handleToolCall`).
  - All of these are the same boundary: pure/in-process.
- **History:** added in a86f99588 (v0.3.0, 2026-04-08), before `tool-defs.ts` was extracted as the single source (v0.34). Last touched 9c2c91188.
- **Deletion unlocks:** 70 test LOC. Plus edits to the `tier1` run line in `e2e.yml`, `E2E_EXCLUSIONS` in `scripts/e2e-matrix.ts:12`, the map entry `src/mcp/**` in `scripts/e2e-test-map.ts:346` (still covered by http-transport + mcp-search-transport-matrix), and the `test/select-e2e.test.ts:32` fixture list. No production seam.
- **Cost:** 1,201 ms. It also runs inside a required job.
- **Risk:** low. **Validation:** `bun test test/mcp-tool-defs.test.ts test/select-e2e.test.ts test/scripts/*e2e*`.

### 2. Attendance wrappers re-run the PGLite arm already run by the unit lane: rewrite at the wrapper (HIGH confidence)
- **Files:** `test/e2e/attendance-retrieval-postgres.test.ts`, `test/e2e/attendance-repair-postgres.test.ts`, `test/e2e/extract-timeline-attendance-postgres.test.ts`. Each is one line, `import '../X.test.ts'`.
- **Mechanism:** the imported scenarios use `for (const kind of ['pglite', ...(process.env.DATABASE_URL ? ['postgres'] : [])])`. They don't use `testBackends()`, so under the e2e `DATABASE_URL` they register **both** arms. The unit lane (URL stripped) already runs the PGLite arm. All 19 other wrappers use `registerPostgresTests` + `testBackends()`/connector-fixture, which honour `GBRAIN_TEST_BACKEND=postgres`.
- **Measured against local pgvector pg16:**
  - `attendance-retrieval-postgres`: 387 tests, **183 PGLite (20.1 s) + 183 Postgres (21.9 s)**.
  - `attendance-repair-postgres`: 173 tests, **86 PGLite (22.7 s) + 87 Postgres (24.4 s)**.
  - `extract-timeline-attendance-postgres`: 22 tests, 11 `(pglite)` + 11 `(postgres)` describes.
- **Surviving owner of the PGLite arm:** the unit-lane runs of `test/attendance-retrieval.test.ts` (unit weight 26.6 s), `test/attendance-repair.test.ts` (24.2 s) and `test/extract-timeline-attendance.test.ts` (3.0 s). Same contract, same PGLite boundary. The Postgres arm stays in e2e.
- **History:** a610db7b7 (v0.58.0.0, 2026-09-25, #5458), a recent wave predating/omitting the `testBackends` convention.
- **Action:** switch the three scenario loops to `testBackends()` and the wrappers to `registerPostgresTests(() => import(...))`. The shape is identical to `managed-maintenance.test.ts`. This removes only the duplicated PGLite execution.
- **Saves:** ~45 s per execution (PGLite arms 20.1 + 22.7 + ~2.5 s). Net LOC ~0. No production seam.
- **Cost now:** 47,886 + 49,195 + 4,675 ms. **Risk:** low.
- **Validation:** run each wrapper with `DATABASE_URL` and confirm only `(postgres)` describes; unit files unchanged.

### 3. `test/e2e/v030_1-integration-pglite.test.ts`: delete, keeping 2 registry assertions in a unit file (HIGH confidence)
- **Tests:** 14 tests across Lanes B/C/D/E + "Cross-lane integration".
- **Why slow:** `beforeEach` does a cold `initSchema` (the file deletes `GBRAIN_PGLITE_SNAPSHOT`). Every test, including pure checkpoint helpers, pays about 2 s. Measured locally: 14 pass, each test 1.97–2.68 s, 30.3 s wall.
- **Mutation probe:** I made `validateCheckpoint` return `resumeAt: 'pull'`. The e2e file fails 1 test; the owner `test/upgrade-checkpoint.serial.test.ts` fails "partial completion → resumeAt = next un-completed step" in **0.42 ms**.
- **Per-lane surviving owners (same PGLite/pure boundary):**
  - **Lane E** (round-trip, resumeAt, brain_mismatch, all_complete): `upgrade-checkpoint.serial.test.ts` "writes and reads a complete checkpoint", "partial completion…", "X2: brain mismatch…", "all steps complete…".
  - **Lane D:** `test/vector-index-lifecycle.test.ts` "checkActiveBuild > PGLite returns active: false" and "dropZombieIndexes > PGLite: no-op returns dropped: []". Same `kind==='pglite'` branch.
  - **Lane B:** `test/bootstrap.test.ts` "fresh install regression: initSchema on empty DB produces LATEST" (cold path, snapshot deleted). `test/schema-bootstrap-coverage.test.ts` pins `pages.emotional_weight_recomputed_at`.
  - **"connectionManager in engine" and "schema_version optional":** no product contract. The first asserts that a property is absent; the second accepts undefined or '1'.
  - **Only unique assertions:** "listBackfills returns the canonical registry entries" and "embedding_voyage is declared-only". No other test imports `backfill-registry`; `src/commands/backfill.ts` and `src/core/cycle/patterns.ts` consume it. **Move these two into `test/backfill-base.test.ts`** (no engine needed). The empty-brain `runBackfill` checks are low value; optional.
- **History:** dffb607ef (v0.30.1, #750). Last touched aa820c7f9 (snapshot opt-out).
- **Deletion unlocks:** ~200 test LOC; entries in `test/fixtures/e2e-unmapped-baseline.txt`. No production seam.
- **Saves:** ~26 s (weight 26,038 ms). **Risk:** low.

### 4. `test/e2e/v0_30_3-fix-wave.test.ts`: delete (MEDIUM confidence), dominated by schema-bootstrap-coverage
- **Tests:** "pre-v39 brain…", "pre-v40 brain…", "pre-v41 PGLite brain…", "pre-v34 brain (compounded…)". Each rewinds a LATEST PGLite brain by dropping columns and re-runs `initSchema`.
- **Mutation A** (dropped the `effective_date` ALTER from `applyForwardReferenceBootstrap`, `src/core/pglite-engine.ts`):
  - v0_30_3 fails 2 of 4.
  - `test/schema-bootstrap-coverage.test.ts` fails 3: "covers every forward reference declared in REQUIRED_BOOTSTRAP_COVERAGE", "after bootstrap, PGLITE_SCHEMA_SQL replays…", "every ALTER TABLE ADD COLUMN in MIGRATIONS is covered…".
  - `test/bootstrap.test.ts`: 0 fail.
- **Mutation B** (dropped the `modality` ALTER):
  - **v0_30_3: 4 pass**, so its "pre-v39 (missing modality…)" test does not detect the loss of the column it names.
  - schema-bootstrap-coverage fails 1.
- **Surviving owners:** `schema-bootstrap-coverage.test.ts` (every column v0_30_3 names is in `REQUIRED_BOOTSTRAP_COVERAGE`, lines ~90–118). Full-initSchema-from-old-shape is covered generically by `bootstrap.test.ts` "full path: pre-v0.18 brain reaches LATEST_VERSION via initSchema" and "pre-v121 timeline shape reaches LATEST through full initSchema". All PGLite.
- **Why MEDIUM:** v0_30_3 is the only test running this exact set of rewinds through the full `initSchema` + migration chain. Its unique value is the "compounded pre-v34" arc. Consider merging that one case into `bootstrap.test.ts`.
- **History:** ff53a4c9b (v0.31.1.1 fix-wave, #776).
- **Unlocks:** 201 LOC. **Saves:** 13,153 ms. **Risk:** low–med.
- **Sibling:** `test/e2e/v0_28_5-fix-wave.test.ts` (15,254 ms, 292 LOC) is the same pattern. Its A4 tests duplicate `test/embedding-dim-check.test.ts` "Postgres branch inlines all four recipe steps…" and "…skips HNSW recreate when requested dims exceed pgvector cap". Cluster A overlaps schema-bootstrap-coverage. Cluster B (dim templating at 768 / >2000) needs an owner check before removal. Not probed; secondary candidate.

### 5. `test/e2e/reconcile-crash.test.ts` + `reconcile-crash-unactivated.test.ts`: add to `E2E_EXCLUSIONS` (HIGH confidence, lane dedupe, no test deletion)
- **Tests:** "Postgres reconciliation survives SIGKILL/<boundary>, activation=true|false" over `CRASH_BOUNDARIES`.
- **Duplicate execution:** `persistence-validation.yml` (called from `test.yml` on every PR) already runs exactly these two files, by name, on postgres × Bun {1.3.11, 1.3.13} with pg16, and uploads crash manifests. The step is "Require all reconciliation crash boundaries before and after activation". The `selected-e2e` run is Bun 1.3.13 + pg16, which is **the same contract on the same boundary** as the persistence-validation postgres/1.3.13 arm. They are selected on any escape-hatch PR and through `e2e-test-map.ts:229,235,238`.
- **Action:** add both files to `E2E_EXCLUSIONS` (the "named-job lane" mechanism). That removes only the PR `selected-e2e` duplicate. Nightly `coverage-full-e2e` still runs them, so coverage artifacts and cadence are unchanged, per TESTING.md.
- **History:** b272cf234 (#5361, 2026-09-22) added the files and the persistence-validation step together.
- **Saves:** ~203 s per PR where selected (102,209 + 101,348 ms). **Risk:** low.
- **Validation:** `bun test test/scripts/*e2e-matrix*` (if pinned) and `bun scripts/select-e2e.ts | bun scripts/e2e-matrix.ts prepare`.

### 6. `test/e2e/minions-field-report-repro.test.ts`: keep, rewrite for a smaller workload (HIGH confidence it is the sole owner)
- **Test:** "v0.41 field-report repro > subagent batch under lease pressure completes; zero dead-from-lease-pressure".
- **Mutation probe:** I set `isLeaseFull = false && …` in `src/core/minions/worker.ts:1659`, which breaks the worker's lease-full routing.
  - This file **fails**.
  - `test/minions-lease-full-retry.test.ts` (7 pass), `test/e2e/minions-controller-bounce-only.test.ts` (2 pass), `test/job-isolation-protocol.test.ts` (22 pass) and `test/child-job-runner.test.ts` (15 pass) **all still pass**.
  - So this is the only worker-boundary owner. Retained.
- **Waste:** a fixed `await new Promise(r => setTimeout(r, 25_000))` with 12 jobs.
- **Action:** poll until all jobs settle (with a timeout), or use 2–3 jobs. Move to the unit/slow lane; it is PGLite-only.
- **Saves:** ~20+ s of 27,667 ms. **Risk:** low.

### 7. Never-executing live files: exclude from the e2e glob (MEDIUM; opt-in dev tools, not CI coverage)
- **Files:**
  - `openrouter-anthropic-subagent-replay.live.test.ts` (1,464 ms / 168 LOC)
  - `openrouter-deepseek-subagent-replay.live.test.ts` (1,913 / 168)
  - `voyage-rerank-live.test.ts` (297 / 132)
  - `voyage-multimodal.test.ts` (270 / 44)
- **Evidence:** no workflow provides `OPENROUTER_API_KEY` or `VOYAGE_API_KEY` (the only secrets are ANTHROPIC, OPENAI, XAI, TEMPLATE_REPO_PAT). The openrouter files still boot PGLite in `beforeAll` before skipping every test. The voyage files are excluded from `selected-e2e` but still hit by the nightly glob.
- **TESTING.md says** "a missing key … is not live-provider evidence". Keep them as documented opt-in commands, but rename or exclude them from `run-e2e.sh`'s glob so they stop counting as discovered coverage.
- **Saves:** ~3.9 s nightly. **Risk:** low.
- The 7 real-agent door files (≈3.9 s) are skip-only in e2e lanes by design (env scrub) and owned by `heavy-tests.yml`. Excluding them from the glob is optional.

## Category-level opportunity: lane misplacement (not deletions)
113 files / 30.5K LOC / 927 s never touch Postgres. Examples: `claw-test` 82 s, `mounts-routing-pglite` 45 s, `qm-provisioning` 40 s, `pglite-cli-exit.serial` 39 s, `init-fresh-pglite` 36 s, `fresh-install-pglite` 29 s, `remote-privacy-journeys` 24 s, `serve-stdio-roundtrip` 23 s, plus ~39 `*-pglite*` files.

In the e2e lane they occupy a Postgres-provisioned runner, execute strictly sequentially (`run-e2e.sh`), and run on PRs only when selected. Moving them to unit/serial/slow lanes (by suffix) would *increase* PR coverage and cut Postgres-lane wall time. Their tests are the sole owners in most cases, so this is re-homing, not reduction.

TODOS.md:6806 ("Non-tier-1 e2e files run in no required CI lane") is the same finding, and partly stale now that `selected-e2e` exists. Exceptions that must stay put:
- `sync-delegation-under-serve.serial` and `dream-synthesize-pglite`: dedicated tier1 steps.
- `db-guard.test.ts`: fine to move, but keep it.

## Retained false positives
- **22 Postgres wrappers** (491 s, 78 LOC; e.g. `persistence-embedding-effects`, `managed-connector-retry`, `projection-recovery-parity`, `google-attachments-postgres`). Tiny files, but each is the Postgres arm of a shared scenario gated by `requirePostgresTestDatabase` + `GBRAIN_TEST_BACKEND=postgres`. A PGLite pass doesn't establish JSONB, locking or pool behaviour (TESTING.md). Only the 3 attendance wrappers double-run (Candidate 2).
- **`db-guard.test.ts`** (332 ms): a pure unit test sitting in e2e, but the only direct truth table for `assertSafeE2eDatabaseUrl`, the destructive-DB safety guard. `db-guard-coverage.test.ts` tests the scanner, not the predicate. Security contract. Keep; lane-move it.
- **`persistence-runtime-matrix.test.ts`** (45 s weight): skip-only in GitHub e2e (no PgBouncer). Under `ci:local`/`ci:ubicloud` it is the local stand-in for persistence-validation's "Execute all 24 deployment cases", which ci:local does not otherwise run.
- **`minions-field-report-repro`**: the probe showed it is the sole worker-routing owner (shrink it, don't delete).
- **`minions-controller-bounce-only`**: covers `controllerTick` over populated audit/dead-job SQL windows. `lease-cap-controller.test.ts` covers the pure `nextLeaseCap` and only the empty-brain tick.
- **`claw-test`** (82 s): drives the real harness subprocess, oracles, phase-timeout kill and charset guard. `claw-test-cli.test.ts` covers only the registry, detection and argv. Process boundary. Keep (slow-lane candidate).
- **`sync-delegation-under-serve.serial`** (155 s), **`serve-http-multi-agent`**, **`postgres-bootstrap`**: process/IPC/SIGKILL/bootstrap boundaries with dedicated jobs.
- **Tier1 named files are also in the nightly glob**, so they run twice nightly. That is deliberate, for coverage LCOV, so no action.

## Est. savings if candidates 1–7 land
| # | Action | Test LOC removed | ms saved per run where it executes |
|---|---|---:|---:|
| 1 | delete mcp.test.ts | 70 | 1,201 |
| 2 | attendance wrappers → Postgres-only | ~0 | ~45,000 |
| 3 | delete v030_1 (move 2 asserts) | ~200 | ~26,000 |
| 4 | delete v0_30_3 (+ v0_28_5 follow-up) | 201 (+~292) | 13,153 (+15,254) |
| 5 | reconcile-crash → E2E_EXCLUSIONS | 0 | ~203,000 per selected PR |
| 6 | field-report poll instead of 25 s sleep | ~0 | ~20,000 |
| 7 | exclude never-run live files | 0 (rename) | ~3,900 nightly |
| | **Total (1–7, excl. v0_28_5)** | **~470** | **~312 s** (≈11% of e2e compute) |

Plus the category move of 927 s from the sequential Postgres lane to parallel unit/serial lanes.

Probes run (all reverted; `git status` clean): tool-defs mutation, worker lease-full routing, PGLite bootstrap effective_date / modality, upgrade-checkpoint resumeAt. Attendance arm timings came from a local `pgvector/pgvector:pg16` container, since removed. No full-suite runs.
