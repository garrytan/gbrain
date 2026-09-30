## PR 1: fill coverage holes (test-reduction plan)

Adds behavioral owners for eight contracts that had none, before any test that depends on them is removed. No tests are deleted except the OCR seam wrapper's callers, which move to the real import boundary. One production change: the `_maybeOcrGatedForTests` export is removed from `src/core/import-file.ts`.

Every new test was run against a targeted mutation of the production code (it must fail) and against the real code (it must pass). Where an old test covered the same contract, the same mutation was run against it too. Raw results: `(scratch) mut/results.tsv`, per-probe logs in `(scratch) mut/logs/`.

### Mutation evidence: new tests

| Item | Contract | Mutation (production edit) | New test result | Old test on the same mutation |
|---|---|---|---|---|
| 1 features | `missing-embeddings` fires | `missing_embeddings > 0` → `> 1e9` | fail (2) | lane probe F: `runFeatures` throwing at entry left `features.test.ts` + `features-recipe-secrets.test.ts` 19 pass / 0 fail |
| 1 | `zero-links` fires / stays silent | `link_count === 0` → `=== -1` / `>= 0` | fail (1) / fail (2) | same |
| 1 | `zero-timeline` fires / stays silent | `=== 0` → `=== -1` / `>= 0` | fail (2) / fail (2) | same |
| 1 | `low-coverage` fires / stays silent | `< 0.9` → `< 0.4` / condition → `<= 1` | fail (1) / fail (2) | same |
| 1 | integrations ANY-of secrets | `secrets.some` → `secrets.every` | fail (2) | same |
| 1 | heartbeat counts as configured | heartbeat check → `return true` | fail (1) | same |
| 1 | only `setup_complete` heartbeats count | `evt?.event === 'setup_complete'` → `!!evt` | fail (1) | same |
| 1 | `no-sync` fires / stays silent | condition → `false` / `true` | fail (1) / fail (2) | same |
| 1 | priority-1 always pitched | `priority === 1` → `=== 3` | fail (1) | same |
| 1 | declined priority-2 suppressed | declined check removed | fail (1) | same |
| 1 | brains under 3 pages skip P2 checks | `page_count >= 3` → `>= 0` | fail (1) | same |
| 1 | offers persisted | `saveOffers` removed from JSON path | fail (1) | same |
| 1 | healthy early return writes nothing | `saveOffers` added to early return | fail (1) | same |
| 1 | offers under `HOME`, not `GBRAIN_HOME` | `offersPath` uses `GBRAIN_HOME` | fail (2) | same |
| 2 supervisor | 3-strike threshold | `>= 3` → `>= 2` / `>= 4` | fail (4) / fail (3) | copied-logic tests in `connection-resilience.test.ts` pass; only the "Eng-review D3" source pin fails |
| 2 | degraded branch reachable | `>= 3` → `false` | fail (3) | same (only the D3 source pin fails) |
| 2 | reconnect called | `engine.reconnect()` removed | fail (3) | not run |
| 2 | reconnect success resets counter | reset removed | fail (1) | not run |
| 2 | reconnect failure keeps counter | reset added on failure | fail (1) | not run |
| 2 | successful health query resets | reset removed | fail (1) | not run |
| 2 | stopping suppresses | `stopping` dropped from guard | fail (1) | not run |
| 2 | configuration-blocked suppresses | `configurationBlocked` dropped from guard | fail (1) | not run |
| 2 | `db_reconnected` event | reason renamed | fail (1) | not run |
| 3 embed | default 20 on `--all` (embedAll) | default `'20'` → `'19'` / `'25'` | fail (1) / fail (1) | `embed.serial.test.ts` + `embed-helper-migration.test.ts`: 60 pass / 0 fail on `'19'` |
| 3 | default 20 on `--stale` (embedAllStale) | default `'20'` → `'19'` / `'25'` | fail (1) / fail (1) | not run |
| 4 schema | `EXPERIMENTAL_VERBS` content | set emptied | fail (1) | old constant-vs-constant test: 7 pass / 0 fail |
| 4 | one verb dropped | `graph` removed | fail (1) | not run |
| 4 | `(experimental)` tag rendered | tag → `''` | fail (1) | not run |
| 5 check-resolvable | `add_trigger` fix type | `add_trigger` → `add_row_PROBE` | fail (1 of 233 across check-resolvable, -cli, resolver) | lane probe Q3: 231 pass / 0 fail |
| 5 | fix `skill_path` / `section` | path without `skills/` / section renamed | fail / fail | not run |
| 5 | MECE whitelist filters overlaps | whitelist filter removed | fail (2) | not run |
| 5 | whitelisted skills need no triggers | gap-skip removed | fail (1) | not run |
| 5 | `brain-ops` whitelisted | entry removed | fail (1) | not run |
| 5 | overlaps reported | overlap push skipped | fail (1) | not run |
| 6 OCR | env opt-in off means no OCR | opt-in check removed | fail (2) | old `_maybeOcrGatedForTests` suite: 7 pass / 0 fail |
| 6 | env opt-in on runs OCR (positive control) | OCR never runs | fail (8) | old suite: 7 pass / 0 fail |
| 6 | hash-unchanged re-import when OCR wanted | `ocrWanted = false` | fail (1) | not run |
| 6 | budget gate | gate disabled | fail (4) | not run |
| 6 | budget consumed | `images += 1` removed | fail (3) | not run |
| 6 | config cap honored | config read ignored | fail (2) | not run |
| 6 | cap 0 means unlimited | `> 0` → `>= 0` | fail (1) | not run |
| 6 | `ocr_status: done` stamped | stamp removed | fail (1) | not run |
| 6 | OCR text persisted | OCR text dropped | fail (2) | not run |
| 7 e2e map | `postgres-engine.ts` selects its 3 singleton owners | one owner / all three removed from the map | fail (1) / fail (1) | no test existed; lane report: a `postgres-engine.ts`-only diff selected 25 files and none of the three |
| 8 SIGPIPE | broken pipe runs the cleanup route | SIGPIPE listener removed | fail (1) | old test was `test.skip` |
| 8 | cleanup deletes the lock (both cases) | cleanup pass runs no entries | fail (2) | old SIGTERM test: failed 3/3 locally, but passes vacuously whenever it misses the lock row (early-return path, now removed) |
| 8 | SIGTERM runs cleanup | SIGTERM listener removed | fail (2) | not run |
| 8 | stdout/stderr `EPIPE` listeners | both listeners removed | **pass (survived)**: under Bun the broken pipe arrives as SIGPIPE, so these listeners are unreachable; filed in TODOS.md | n/a |

All new and changed tests pass on the real code (focused run below).

### Deleted test

| Deleted | Evidence case | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|---|
| `src/core/import-file.ts` `_maybeOcrGatedForTests` seam (and the old `ocr-run-budget.test.ts` cases that called it) | Retained contract | opt-in check removed; OCR never runs; budget gate disabled | old seam tests pass on the first two (they bypass the opt-in); the new tests fail on all three | `test/ocr-run-budget.test.ts` (rewritten through `importImageFile`) | fail on every mutation above, pass on real code |

The old `EXPERIMENTAL_VERBS` constant-vs-constant test body was replaced in place by the behavioral test (item 4). Vacuous-assertion evidence: emptying the set left it passing (7 pass / 0 fail).

### SIGPIPE determinism bar (item 8)

One Ubicloud `standard-8` VM, `scripts/ubicloud/setup-ci-vm.sh` (Postgres + PgBouncer slot), `scripts/run-unit-parallel.sh` looping in the background to saturate the CPU, then `test/e2e/sync-lock-recovery.test.ts` run 50 times back to back through `scripts/ubicloud/ci-item.sh e2e`, then one run with the SIGPIPE cleanup listener removed. Log: `(scratch) sigpipe/result/out/sigpipe-50.log`.

| Measure | Result |
|---|---|
| Consecutive runs | 50 of 50 passed (8 pass / 0 fail each; both boundary cases passed every run) |
| CPU load during the runs (8 vCPU) | load1 between 5.84 and 13.30; the unit saturator (`run-unit-parallel.sh`, 4 shards) ran for the whole window |
| Per-run wall time | 8-9 s |
| Mutation: SIGPIPE cleanup listener removed | failed as required (rc=1): "closing the output pipe mid-sync routes through cleanup and releases the lock" |

The bar is met, so item 8 counts as a closed hole and the plan's fallback (delete the skip, file a TODO) was not needed.

### Supervisor: reconnect on every failing tick

A failed `engine.reconnect()` leaves the failure counter at 3 or more, so each later failing health tick warns `db_connection_degraded` and reconnects again. No doc or CHANGELOG entry says whether this is intended. The test pins current behavior; TODOS.md has an entry to confirm or add a backoff.

### Production bug found (not fixed here)

`src/core/process-cleanup.ts`: a second signal during the cleanup pass calls `process.exit` before the first pass's lock DELETE finishes (`runCleanupPass` returns at once when a pass is already running, and each signal handler exits in `.finally`). Reproduced 4/4 locally by closing the sync output pipe the moment the lock row appears: two SIGPIPE deliveries, both cleanup callbacks registered, neither finished, exit 141, `gbrain-sync:default` row left until its TTL. Filed as a P2 in TODOS.md with the proposed fix.

### Diff size

| Area | Added | Removed |
|---|---|---|
| Production (`src/`) | 0 | 9 |
| Scripts (`scripts/e2e-test-map.ts`) | 5 | 0 |
| Tests (`test/`, incl. 2 new files) | 789 | 152 |
| Docs (`docs/TESTING.md`, `TODOS.md`, `.gitignore`) | 33 | 0 |
| Committed audit evidence (`docs/test-audit/2026-09-29/`, 24 files) | ~14,250 | 0 |

### Commands

| Command | Result |
|---|---|
| Focused: 23 files, each run alone (`features`, `features-recipe-secrets`, `supervisor-health-reconnect`, `supervisor`, `supervisor-wedge`, `supervisor-configuration-blocked`, `connection-resilience`, `embed-default-concurrency`, `embed.serial`, `embed-helper-migration`, `schema-cli-contract`, `check-resolvable`, `check-resolvable-cli`, `resolver`, `ocr-run-budget`, `import-image-retry`, `select-e2e`, `scripts/e2e-wiring`, `process-cleanup`, `docs-cli-commands`, `build-llms`, `docs-navigation`, `test-reads-source-smell`) | all pass (log `(scratch) focused.txt`) |
| New unit files plus gateway-sensitive neighbors in one `bun test` process | 110 pass / 0 fail |
| `bash scripts/run-e2e.sh test/e2e/sync-lock-recovery.test.ts` (local pgvector) | 8 pass / 0 fail |
| `bun run verify` | 55/55 checks green (19 s) |
| `scripts/check-privacy.sh` on the committed lane reports, plus a manual real-name review | clean; only public names (repo owner in `garrytan/gbrain`, the public Hermes harness, and a `users/garry` string quoted from an existing test) |
| `bun run ci:ubicloud` | all checks passed in 5m35s: gitleaks 1, verify 1, unit 1995, serial 331, slow 21, e2e 314, 0 failed (7 of 10 VMs became ready; the queue drained on those) |

New test timings: `features.test.ts` about 4 s (one PGLite boot), `ocr-run-budget.test.ts` about 4 s (one PGLite boot), `embed-default-concurrency.test.ts` about 1 s, `supervisor-health-reconnect.test.ts` under 0.5 s, the `check-resolvable` and `schema-cli-contract` additions a few ms each, `sync-lock-recovery.test.ts` about 11 s (both boundary cases use a 1,000-file repo).

### Contributor note (for the CHANGELOG "For contributors" section)

- `gbrain features` now has behavioral tests (`test/features.test.ts`): each feature check fires in a fixture brain with the gap and stays silent in a healthy one; recipe names in the integrations pitch follow env and heartbeat configuration; declined offers are suppressed; offers persist only under the temporary home.
- New `test/supervisor-health-reconnect.test.ts` drives the supervisor's DB health branch (3-strike degrade + reconnect, reset, failed reconnect, stopping and configuration-blocked suppression) through the real health check.
- New `test/embed-default-concurrency.test.ts` pins the default of 20 embed workers on both `--all` and `--stale` through the real gateway path.
- `test/schema-cli-contract.test.ts` checks `gbrain schema usage` output instead of grepping for verb names; `test/check-resolvable.test.ts` adds fixture trees for the unreachable-skill fix and the overlap whitelist.
- `test/ocr-run-budget.test.ts` now drives `importImageFile` (opt-in on and off, hash-unchanged retry, budget caps); the `_maybeOcrGatedForTests` export is gone.
- `scripts/e2e-test-map.ts` routes `src/core/postgres-engine.ts` to its three shared-singleton E2E owners (removed from `test/fixtures/e2e-unmapped-baseline.txt`).
- `test/e2e/sync-lock-recovery.test.ts`: the skipped `| head -5` case is replaced by a real closed-pipe test, and the SIGTERM case no longer passes when it misses the lock; both wait for the held lock first and fail if they never see it.
- The 2026-09-29 test-audit lane reports are committed under `docs/test-audit/2026-09-29/` (linked from `docs/TESTING.md`, excluded from the llms bundles and from the docs CLI-command scanner).
