# PR 3: E2E lane corrections (test-reduction plan, items 1-8)

Scope: plan "PR 3 — E2E lane corrections" items 1-8 with the DX "PR 3 documentation" and eng amendments. The lane-move pilot is not in this PR. No production (`src/`) code changes. No VERSION/CHANGELOG change (the fix-wave integration does one bump).

## LOC (`git diff --numstat`)

| Area | Added | Removed |
|---|---:|---:|
| Production (`src/`) | 0 | 0 |
| Tests (`test/`) | 187 | 570 |
| CI/scripts/manifests (`scripts/`, `.github/`) | 40 | 21 |
| Docs (`docs/TESTING.md`, `CONTRIBUTING.md`) | 42 | 2 |

Whole files deleted: `test/e2e/mcp.test.ts` (70), `test/e2e/v030_1-integration-pglite.test.ts` (222), `test/e2e/v0_30_3-fix-wave.test.ts` (201).

## Compute (from `scripts/ubicloud/weights.json`, ms)

| Change | Before | After | Where it saves |
|---|---:|---:|---|
| delete `mcp.test.ts` | 1,201 | 0 | every run that selects it + tier1 |
| delete `v030_1-integration-pglite` | 26,038 | 0 (`backfill-base` unit 170 → 1,172) | E2E |
| delete `v0_30_3-fix-wave` | 13,153 | 0 (+~2 s unit in `bootstrap`) | E2E |
| attendance wrappers Postgres-only | 101,756 | 50,344 (27,079 + 21,285 + 1,980) | E2E when selected |
| field-report polling | 27,667 | 8,334 | E2E |
| reconcile-crash out of PR `selected-e2e` | 203,557 | 0 on PR selected-e2e (still in persistence-validation on every PR) | PRs that select them |
| live-key files out of the runner glob | 3,944 | 0 | nightly full corpus, local gates |
| mechanical "Performance Baselines" | ~1,200 | 0 | tier1 + nightly |

"After" values for changed files come from this branch's `bun run ci:ubicloud` run (10 VMs, same harness that produced the "before" weights), written into `scripts/ubicloud/weights.json`. That's one run each, not a matched multi-run comparison. Full gate: 9,389 s of test compute, 315 s wall.

## Evidence table

Mutation probes were run against the real production code with the named edit applied, then reverted (`git status src/` clean after each). Deleted files were restored from `HEAD` under a probe name (for example `test/e2e/v030-probe.test.ts`), run, and removed again. Raw logs: `(scratch) pr3-probes/item{3,4,5,6,8}.log`.

### Item 1: `test/e2e/mcp.test.ts` deleted (owners: `test/mcp-tool-defs.test.ts`, `test/operations-descriptions.test.ts`)

| Deleted test | Probe edit | Deleted test result | Surviving owner | Owner result |
|---|---|---|---|---|
| operations generate valid MCP tool definitions | `src/mcp/tool-defs.ts`: `paramDefToSchema` drops `description`; `buildToolDefs` emits `required: []` | 2 pass, 0 fail (blind: it re-implements the mapping) | `mcp-tool-defs.test.ts` | 4 fail: "output equals pre-extraction inline mapping byte-for-byte", "put_page warns…", "an op with a REAL declared dry_run param keeps its own schema", "paramDefToSchema preserves description on nested items" |
| same (description truthy) | `src/core/ops/salience.ts`: `get_recent_salience` description `''` | 1 fail | `operations-descriptions.test.ts` | 1 fail: "get_recent_salience description > matches the operation registration" |
| same (op names present) | `src/core/ops/orphans.ts`: `find_orphans` renamed | 1 fail | `mcp-tool-defs.test.ts` | 1 fail: "every non-localOnly op carries a non-empty area (WP4)" |
| MCP server module can be imported | top-level `throw` in `src/mcp/server.ts` | 1 fail | `test/mcp-stdio-gate-list.test.ts` (imports server.ts) | exit 1 (unhandled import error) |

Evidence case: retained contract. Also updated: `tier1` line in `.github/workflows/e2e.yml`, `E2E_EXCLUSIONS` in `scripts/e2e-matrix.ts`, the `src/mcp/**` entry in `scripts/e2e-test-map.ts` (still selects `http-transport` and `mcp-search-transport-matrix`), the `test/select-e2e.test.ts` fixture list, `CONTRIBUTING.md` tree listing, and weights.

### Item 2: attendance wrappers run only the Postgres arm

Scenario loops in `test/attendance-retrieval.test.ts`, `test/attendance-repair.test.ts`, `test/extract-timeline-attendance.test.ts` now use `testBackends()`; the three `test/e2e/*-postgres.test.ts` wrappers use `registerPostgresTests(() => import(...))`. No assertion changed.

Executed tests (JUnit reports, `(scratch) pr3-probes/att-describes.txt`):

| Lane | Describe | Executed |
|---|---|---:|
| unit (no `DATABASE_URL`) | non-overridden canonical attendance lifecycle (pglite) | 185 |
| unit | preview-bound attendance repair (pglite; repair-fixture non-overridden person_to_meeting) | 86 |
| unit | meeting timeline attendance roles (pglite) | 11 |
| unit | shared and filesystem canonical attendance grammar (engine-agnostic) | 17 |
| E2E (`DATABASE_URL`, pg16) | non-overridden canonical attendance lifecycle (postgres) | 185 |
| E2E | preview-bound attendance repair (postgres; …) | 87 |
| E2E | meeting timeline attendance roles (postgres) | 11 |
| E2E | shared and filesystem canonical attendance grammar (engine-agnostic) | 17 |

E2E output has zero `(pglite)` describes. Before, the lane report measured retrieval 183 pglite + 183 postgres and repair 86 + 87 in the E2E wrapper. Cadence: the PGLite arm now runs in the unit lane on every PR (more frequent than selected E2E). The 17 engine-agnostic grammar tests sit outside the backend loop and still run in both lanes, as before.

### Item 3: `test/e2e/v030_1-integration-pglite.test.ts` deleted

| Deleted test | Probe edit | Deleted test result | Surviving owner | Owner result |
|---|---|---|---|---|
| listBackfills returns the canonical registry entries | drop `registerBackfill(modalityBackfill())` | 1 fail | `backfill-base.test.ts` › backfill registry (moved) | 1 fail |
| embedding_voyage is declared-only | `v030_1_status: 'implemented'` | 1 fail | `backfill-base.test.ts` › backfill registry (moved) | 1 fail |
| v44 emotional_weight_recomputed_at column exists / emotional_weight backfill on empty brain | drop the v44 `ALTER TABLE pages ADD COLUMN … emotional_weight_recomputed_at` in `src/core/migrate.ts` | 2 fail | planned owner `schema-bootstrap-coverage.test.ts`: **0 fail** (the column is on its exemption list). New owner: `backfill-base.test.ts` › "implemented backfills against a freshly initialized PGLite brain" | 1 fail: "emotional_weight finds every column it reads…" |
| effective_date backfill on empty brain: examined=0 | `let examined = 1` in `runBackfill` | 2 fail | `backfill-base.test.ts` | 5 fail incl. "returns done with no rows when no work to do" |
| after initSchema, config.version is at LATEST_VERSION | runner skips the last pending migration | 1 fail | `bootstrap.test.ts` | 6 fail incl. "fresh install regression: initSchema on empty DB produces LATEST" |
| dropZombieIndexes on PGLite is a no-op | PGLite branch returns `dropped: ['probe']` | 1 fail | `vector-index-lifecycle.test.ts` | 1 fail: "PGLite: no-op returns dropped: []" |
| checkActiveBuild on PGLite returns active: false | PGLite branch returns `active: true` | 1 fail | `vector-index-lifecycle.test.ts` | 1 fail: "PGLite returns active: false" |
| round-trip / resumeAt | `resumeAt: ALL_STEPS[0]` | 1 fail | `upgrade-checkpoint.serial.test.ts` | 1 fail: "partial completion → resumeAt = next un-completed step" |
| cross-brain checkpoint mismatch (X2) | brain_id check disabled | 1 fail | `upgrade-checkpoint.serial.test.ts` | 1 fail: "X2: brain mismatch → reason=brain_mismatch" |
| full step progression | `all_complete` returns valid | 1 fail | `upgrade-checkpoint.serial.test.ts` | 1 fail: "all steps complete → reason=all_complete" |
| connectionManager is null on PGLite | n/a | n/a | none needed | Vacuous: asserts a property is absent; the only reader (`src/core/minions/db-probe.ts`) reads it as optional, so adding an undefined field would fail this test with no behavior change. |
| schema_version on BrainHealth is optional | n/a | n/a | none needed | Vacuous: the type is `'1' \| undefined`, so `=== undefined \|\| === '1'` cannot fail for type-correct code. |

The new PGLite block adds about 2.6 s to `backfill-base.test.ts` (0.25 s before, 2.86 s after). Upgrade-checkpoint rows are the named mixed-file exception (owner until the misc cluster deletes the module).

### Item 4: `test/e2e/v0_30_3-fix-wave.test.ts` deleted; compounded pre-v34 case merged into `test/bootstrap.test.ts`

The merged case now also checks that every dropped column comes back (the old case checked only the version).

| Probe edit (`applyForwardReferenceBootstrap`, `src/core/pglite-engine.ts`) | Deleted v0_30_3 | `schema-bootstrap-coverage.test.ts` | `bootstrap.test.ts` (merged case) |
|---|---|---|---|
| drop `effective_date` ALTER | 2 fail | 3 fail | 1 fail (compounded pre-v34) |
| drop `modality` ALTER | **0 fail** | 1 fail | 0 fail |
| drop `import_filename` ALTER | **0 fail** | 1 fail | 0 fail |
| drop `embedding_image` ALTER | 2 fail | 2 fail | 1 fail |
| drop `salience_touched_at` ALTER | **0 fail** | 1 fail | 0 fail |
| drop `search_vector` ALTER | **0 fail** | 1 fail | 0 fail |

`schema-bootstrap-coverage` catches all six, and the deleted file missed four of them. Evidence case: retained contract.

### Item 5: reconcile-crash moves out of PR `selected-e2e`

`PERSISTENCE_VALIDATION_OWNED` in `scripts/e2e-matrix.ts` (commented with `persistence-validation.yml`) is spread into `E2E_EXCLUSIONS`. `prepareMatrix` and `scripts/select-e2e.ts` print `excluded: <file> (owned by persistence-validation.yml)`; select-e2e prints it on stderr when a mapped source or the suite itself changes, and still lists the files on stdout, so the local diff gates keep running them. `docs/TESTING.md` "Coverage responsibilities before consolidation" records the ownership change and the local command. Owner: `persistence-validation.yml`, called from `test.yml` (`pull_request` to master, no path filter), step "Require all reconciliation crash boundaries before and after activation", postgres × Bun 1.3.11/1.3.13, crash-manifest upload unchanged. The nightly full-corpus run still includes them.

| New/changed test | Probe edit | Result on probe | Result on real code |
|---|---|---|---|
| e2e-matrix › drops the persistence-validation.yml crash suites and names their owner | remove `...PERSISTENCE_VALIDATION_OWNED` from `E2E_EXCLUSIONS` | 1 fail | pass |
| same + select-e2e notice tests | `exclusionNotice` always generic | 3 fail | pass |
| select-e2e › a mapped reconcile source names both crash suites | skip map matching in `persistenceOwnedNotices` | 1 fail | pass |
| select-e2e › the CLI prints the notice on stderr and still lists the files on stdout | remove the stderr write from `main` | 1 fail | pass |
| e2e-wiring › every EXCLUDE entry is named by another job here, by persistence-validation.yml, or is a live-key spender | `persistence-validation.yml` stops naming `reconcile-crash.test.ts` | 1 fail | pass |

Documented local command run against pg16: see "Commands run".

### Item 6: `minions-field-report-repro` polls instead of sleeping 25 s

| Test | Probe edit | Result on probe | Result on real code |
|---|---|---|---|
| subagent batch under lease pressure completes; zero dead-from-lease-pressure | `src/core/minions/worker.ts:1659` `isLeaseFull = false && …` | 1 fail (7.4 s) | pass; 6 runs at 7.45-9.78 s (was 27.7 s weight) |

### Item 7: mechanical "Performance Baselines" removed

Vacuous: the block has zero `expect()` calls. The master copy run with `-t "Performance Baselines"` against pg16 reports 1 pass and no `expect() calls` line. It only printed timings. Import, search and link behavior stays owned by the rest of `mechanical.test.ts` (77 tests pass). The now-unused `time()` helper in `test/e2e/helpers.ts` is removed.

### Item 8: key-gated live files left out of the `run-e2e.sh` glob fallback

Files: the 2 openrouter `.live` replays and the 2 voyage files. No workflow provides `OPENROUTER_API_KEY` or `VOYAGE_API_KEY`. Argv invocation still runs them, and each header plus `docs/TESTING.md` shows `KEY=... bash scripts/run-e2e.sh <file>`.

| Test | Probe edit | Result on probe | Result on real code |
|---|---|---|---|
| nightly-e2e › the four actual runner partitions cover the complete default discovery exactly once (now also checks argv mode lists the live files) | remove the glob filter | 1 fail | pass |
| same | apply the filter to argv too | 1 fail | pass |

`bash scripts/run-e2e.sh test/e2e/voyage-multimodal.test.ts` still runs the file by name (1 file, passed).

## Manifests

- Weights: deleted and no-longer-discovered files removed from `scripts/e2e-weights.json` (281 → 274, metadata counts synced) and `scripts/ubicloud/weights.json` (2591 → 2584). The 14 touched files' `scripts/ubicloud/weights.json` entries were refreshed from this branch's `ci:ubicloud` run. `e2e-weights.json` values are mined from GitHub nightly logs, so its changed-file entries refresh on the next mine. `test-weights.json` and `serial-weights.json` had no entries for deleted files.
- `test/fixtures/e2e-unmapped-baseline.txt`: removed the 2 deleted files; `BASELINE_SEEDED_LENGTH` in `test/scripts/e2e-wiring.test.ts` lowered 150 → 143 to match.
- `scripts/structural-suites.tsv` regenerated (no change); `bun run build:llms` produced no change.
- Grep for deleted paths across `scripts/`, `.github/`, `test/`, `docs/`: only historical TODOS.md entries and CHANGELOG remain; left untouched per the TODOS rule.

## Commands run

- Focused unit/script tests (22 files, 724 tests, then 10 files, 150 tests): all pass after fixing `test/scripts/e2e-wiring.test.ts`'s honesty test for the new exclusion.
- Local pg16 E2E: tier1 line `bun test test/e2e/mechanical.test.ts test/e2e/job-isolation.test.ts test/e2e/sync-reconcile-postgres.test.ts` 81 pass; `bash scripts/run-e2e.sh` for field-report, the 3 attendance wrappers and mechanical: 5 files, 378 tests pass; the documented reconcile-crash command: 16 pass, 16 crash manifests.
- `bun run verify`: 55/55 checks green (46 s).
- `bun run ci:ubicloud`: all lanes green in 5m15s (gitleaks 1, verify 1, unit 1993, serial 331, slow 21, e2e 307 files, 0 failed).
