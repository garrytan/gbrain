# Lane A: live flakes at the root, then faster tests

Plan steps S1 (W2: B1, B2 test part, B4, B5/A11, A10) and S4 (W5: D2, D3, D4,
D11, D6, D5, D14), plus two folded community PRs. No test was deleted or
retired, so there are no Retiring-a-test rows. Every executed-identity change
is declared in `../expected-deltas.tsv` (92 D6 moves, 5 D14 skips).

Local checks ran on Bun 1.4.2 against a pgvector/pg16 container. "Mutation"
means a temporary edit to production code (or to the fix), reverted after the
run.

## W2: live flakes

### B1: `foresights sources add` crashed when git gc pruned `.git/objects`

`assertNoPhysicalRootOverlap` (`src/core/persistence/physical-root-record.ts`)
and `topologyDirectoryBytes` (`src/core/persistence/topology-filesystem.ts`)
skip a subdirectory that vanishes or becomes a file between listing and
descent (ENOENT/ENOTDIR below the root). Root errors and every other error
(EACCES) still throw, and `.git` is still walked (ENG-1).

Tests:

- `test/physical-root-walk.test.ts` injects the race through `node:fs`
  (restored after each test): subdirectory removed mid-walk, directory replaced
  by a file, reservation nested under `.git` still found after a sibling
  vanished, root vanishing still throws, EACCES still throws, the same four for
  `topologyDirectoryBytes`, and a timed 20,000-file walk (~0.9 s locally).
- `test/persistence-physical-root.test.ts` › "another brain's reservation under
  the checkout's .git refuses the outer claim": brain B (a second PGLite brain,
  second home) claims `repo/.git/child`; brain A's claim of `repo` is refused
  with `recovery_required`.
- `test/large-brain-ceilings.test.ts` prints stderr when an exit code is wrong.

| Mutation | Result |
|---|---|
| Revert both product edits | walk test: 5 of 11 fail (the four vanished-subdir cases and the nested-reservation case) |
| Skip `.git` in the overlap walk | walk test: 3 fail; two-brain regression fails |

Loop: the 20,000-file CLI case 30 times under two busy-loop CPU hogs: 30/30.

### B2 (test part): self-upgrade-marker leaked a network refresh

The JUST_UPGRADED breadcrumb case now seeds a fresh `UP_TO_DATE` cache, so the
startup hook never spawns `check-update --refresh-cache`. Without the seed, a
leaked `bun src/cli.ts check-update --refresh-cache` process remains after the
file (observed); with it, none. Loop: `bash scripts/run-e2e.sh
test/e2e/self-upgrade-marker.test.ts` 20 times: 20/20, no leftover
`check-update` process. (Lane S0 owns the run-e2e.sh process-group cleanup.)

### B4: facts-queue fixed sleeps

Every fixed result sleep in `test/facts-queue.test.ts` waits on the queue's
counters or `inflightCount()` through `waitFor`. Mutation: ignore
`perSessionInflightCap` (`inflight < Infinity`): the serialization case fails on
order (`toEqual` diff), not on timing.

### B5/A11: child-readiness timeout

The timeout case uses `timeoutMs: 2500` (the production 250 ms stop-to-settle
gap) and requires the confirmed message `timed out; no jobs were admitted`.
`checkChildReadiness` documents the tini-grandchild timeout contract.

| Mutation (delay the wrapper's `close` handler) | Old test | New test |
|---|---|---|
| 100 ms | passes | passes (inside the 250 ms gap) |
| 400 ms (settles as "cleanup unconfirmed") | passes (blind: accepts the unconfirmed variant) | fails on the message |

Both arms run with and without tini (tini installed locally).

### A10: coverage deadline multiplier

`test/helpers/wait-for.ts`: `GBRAIN_TEST_WAIT_MULTIPLIER` (default 1, range
1..4, anything else fails with Why/Fix/Docs) scales every `waitFor` deadline,
capped at 50 s (below bun's 60 s per-test timeout; a larger base is kept), and
the timeout error names the scaling. Sourcing `scripts/lib/test-env.sh` sets 2
when `COVERAGE_DIR` is set and the caller chose nothing; `run-e2e.sh`'s env
scrub keeps the name, and the bun preload keeps `GBRAIN_TEST_*`.
Tests: `test/helpers/wait-for.test.ts` (unset, scaled + message, ceiling,
invalid values) and `test/scripts/e2e-runner.test.ts` (coverage default 2,
explicit value survives the scrub, non-coverage value passes through).

## W5: faster tests

### D2: connector fixture budget

`connectorWaitBudget.ms` is `testWaitMs(1_500)` in the shared connector fixture
(was 10 s) and teardown restores the production 30 s (it leaked before). The 28
fixture files: 165/165 pass; summed test time 282 s -> 147 s; tests over 9.5 s:
11 -> 1 (the remaining one is a standalone-recovery case dominated by child
processes, not the budget).

### D3: maintenance publish waits

`maintenancePublishWaitMs()` (`MAINTENANCE_PUBLISH_WAIT_MS` = 5 s, production
unchanged) replaces waitForWrite's implicit 5 s default in facts-maintenance,
connector-sync (blocked retry, Google receipts), grandfather and
projection-reindex. `__setMaintenanceWriteWaitForTests` overrides both
maintenance waits and returns a restore function. Fixtures: write_pending
cases 250 ms (compaction, embedding deferred cases, managed atoms deferred,
extract-atoms accepted-pending), managed-maintenance 500 ms (it also needs real
commits); all through the multiplier.

- managed-facts-compaction + managed-facts-embedding: 67.6 s -> 11.5 s.
- managed-maintenance: 23/23 in 13 s (each write_pending case waited 5 s).
- The one real-commit case: PostgreSQL `managed fact embedding … equal_dimensions`
  needs its commit inside the wait, so the embedding contract shortens the wait
  only for its deferred (write_pending) scenarios. PG E2E (embedding +
  compaction): 3/3 runs, 25/25.

### D4: embedding-claim renewal seam

`EFFECT_RENEWAL_INTERVAL_MS` (10 s) with `__setEffectRenewalIntervalForTests`
(returns a restore function). `test/persistence-embedding-effects.test.ts` runs
at 1.5 s intervals (through the multiplier); the takeover case's SQL lease is
1.5 intervals (as 15 s is to 10 s), so competitors arrive at 1.7 and 2.8
intervals, after the unrenewed lease would have expired (ENG-9). An afterEach
asserts the production default after every test, and
`test/persistence-test-seams.test.ts` asserts every shortened seam (maintenance
waits, renewal interval, connector budget) restores its production value.

| Mutation | Result |
|---|---|
| Disable periodic renewal (`Date.now() < 0 &&` in the interval) | "two independent consumers retain one healthy multi-batch provider past the fixture lease": fails, `calls` 2 (expected 1) |

PGLite file 7.7 s (CI 21 s); Postgres arm 13.9 s (sleeps were 11-17 s each).

### D11: run-verify-parallel fallback watchdog

Confirmed: without timeout/gtimeout, a watchdog subshell killed after
`pkill -P` but before forking its `sleep` left an orphan `sleep $TIMEOUT` that
held the caller's stdout/stderr; a local run left 10 orphans and both fallback
tests timed out. The watchdog now owns no caller pipes (`</dev/null >/dev/null
2>&1`) and its TERM trap kills its sleep. The harness timeout is 5 s, and a new
case fails when a watchdog sleep survives or the run nears the timeout.

| Mutation | Result |
|---|---|
| Restore the old watchdog | new case fails in 2 of 3 runs (47 s against a 47 s timeout) |

New script: 10/10 runs of the three fallback cases, no orphan sleeps.

### D14: pass-by-early-return becomes skip

Four Postgres-only journal cases (`test.skipIf(!DATABASE_URL)`) and two
case-sensitivity cases (`test.skipIf` on a probed case-insensitive filesystem).
With DATABASE_URL all 13 journal cases run (13/13).

### D6: serial rejoin and the serial manifest

Candidate method (D-unit-corpus.md D6, regenerated on this branch):

1. Lint every non-E2E serial file as a parallel file (copies renamed to
   `*.test.ts`): 248 of 432 violate R1-R4, 184 are clean.
2. Hold back clean files with process-wide state: `__set*/__reset*ForTests`
   seams, `configureGateway`, `spyOn`, `Bun.serve`/`listen`/`createServer`,
   stdout/console patching, `process.chdir`, EXCLUSIVE_FILES and the
   compile-smoke opt-in: 92 held, 92 candidates.
3. Run the 92 in one bun process, forward and reverse order
   (`--max-concurrency=1 --timeout=60000`): 615 pass, 0 fail, 0 skip in both.

The 92 are renamed to `*.test.ts`; five whose name was taken get a suffix
(`apply-migrations-list-db-state-cli`, `cli-help-curated-cli`,
`persistence-read-diagnostics-child`, `process-watchdog-harness`,
`source-resolver-default-write-guard-pglite`). Workflows, imports, spawned
paths, structural suites and key-file docs follow. Two rejoined cli-spawn files
drop per-test pins below the runner default (run-unit-shard.test.ts rule).

`scripts/serial-files.tsv` lists the remaining 341 serial files with a class
(R1 128, R2 72, global-state 138, exclusive 3) and an evidence-derived reason
(the env variables, mocked modules, seams or machine resources). The guard in
`test/scripts/serial-files.test.ts` (logic in `scripts/lib/serial-manifest.ts`)
requires set equality with the tree, a known class, a reason of at least 20
characters that is not boilerplate, R1/R2 rows backed by the file's source,
and exclusive rows matching EXCLUSIVE_FILES. Each failure prints Why, the Fix
(`bash scripts/check-test-isolation.sh --as-parallel <file>`, then the row to
add or delete) and Docs. Fixtures: unlisted file, stale row, boilerplate and
empty reasons, wrong-evidence class, unknown class, exclusive mismatch. The
manifest caught a serial file another lane added (`eval-run-all-outcome`, R2)
when the collector merged.

Local `bun run test` (4 shards + serial pass) with the moves: 33,613 pass,
29 fail. 11 failures were this lane's (two runner sandboxes staging a stub
test-env.sh, one cli-spawn pin rule) and are fixed. The other 18
(hook-command, workspace-push, bootstrap-status serial files and one
git-visible-files case) fail identically at the base commit 6622a119e on this
machine (host git/gh environment), so they are not caused by the moves.

### D5: brain template (in-process engines only)

`test/helpers/brain-template.ts` initializes one disk PGLite template per
process and embedding shape, disconnects it, asserts no source or writer
registration exists in it, and clones it per use with a regenerated
`brain_id`, default-source incarnation and shared-skill token secret/serving
epoch. Nothing outside the data directory is copied (the sibling owner lock
stays behind). Clone ~1 s vs ~3 s for a fresh disk init.
`test/helpers/brain-template.test.ts`: two concurrent clones get distinct
identities and independent writes, and the template's bytes are unchanged.
Mutation: drop the brain_id regeneration -> the test fails. The connector
fixture adopts it (28 files + the seam guard: 169/169).

Not done: CLI-home adoption (cli-spawn / agent-journey). An initialized
GBRAIN_HOME carries identity keyed by its own paths (`persistence/managed-roots`
records named by the data-directory hash, the data directory's owner record,
`content/<brain_id>`), which a copy cannot rebase without a production
re-identity path (plan option (b)).

## Folded community PRs

- #5907 (gateway-chat baseline restore): re-applied with Co-Authored-By.
  Reproduced on this base: `bun test test/ai/gateway-chat.test.ts
  test/search/search-query-contract.test.ts` 40 pass / 1 fail ("expected 1024
  dimensions, not 1536") before, 43/0 after.
- #5961 (cycle_extract contract race): not folded; already fixed on master by
  ccdc6c675 (cycle_extract drains the jobs its Gmail sweep queued before the
  cycle), which landed after the PR was opened. With the PR's own
  discriminator (drainQueue poll slowed to 250 ms) the base passes 16/16 on
  PostgreSQL in 3 of 3 runs.

## Flake loops (ENG-16)

All with coverage on and `GBRAIN_TEST_WAIT_MULTIPLIER=2`:

- PostgreSQL arm of persistence-embedding-effects (D4 lease crossing), pinned
  to 2 CPUs (`taskset -c 0,1`): 30/30.
- D3 PostgreSQL arms (managed-facts embedding/compaction, managed-extract-atoms
  through run-e2e.sh with COVERAGE_DIR), 2 CPUs: 10/10.
- Unit files on Ubicloud standard-2 (2 vCPU), three VMs x 10 iterations of
  facts-queue, child-readiness (tini installed), physical-root-walk,
  managed-facts-compaction/-embedding, managed-maintenance,
  extract-atoms-accepted-pending, managed-extract-atoms,
  persistence-embedding-effects (PGLite), connector-checkpoint-identity,
  connector-wave3, persistence-connectors, persistence-connector-retry,
  persistence-test-seams and run-verify-parallel (226 tests per iteration):
  29/29 iterations green, 0 failures (one VM lost SSH during its tenth
  iteration). The VMs' own Postgres was unreachable from the loop, so the PG
  arms were looped locally (above) instead.
