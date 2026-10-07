# Testing (gbrain repo)

This is the contributor reference for how gbrain is tested: which lanes exist,
what each one proves, how CI runs them, and the guards that keep those claims
honest. It describes current behavior and invariants only. Release history
lives in `CHANGELOG.md`; per-file detail lives in the test files and in
`docs/architecture/KEY_FILES.md`.

## Quick start

Prerequisites: Bun 1.4.0 or newer (CI pins 1.4.2), Git, and bash. E2E needs
Docker for a `pgvector/pgvector:pg16` container and Python 3 on `PATH` (the E2E
runner validates Bun's JUnit reports with the standard-library XML parser).

```bash
bun install --frozen-lockfile && bun run test && bun run verify
```

`bun run test` is the parallel unit loop plus the serial pass (a few minutes on
a laptop); `bun run verify` is CI's guard battery (about a minute). For E2E,
follow [E2E test DB lifecycle](#e2e-test-db-lifecycle-always-follow-this) and
run `DATABASE_URL=postgresql://postgres:postgres@localhost:5434/gbrain_test bun run test:e2e`.
`bun run ci:local` runs the whole CI gate in Docker; `bun run ci:ubicloud` runs
it on ephemeral VMs in about five minutes.

A failing `bun run test` writes every failure block to
`.context/test-failures.log`, one line per shard to `.context/test-summary.txt`
and executed-test receipts to `.context/test-receipts/`; the banner prints the
log's absolute path. A failing `bun run verify` keeps each failed check's log
and prints it. In CI, each red job's step summary lists the failing tests with a
`bun test … -t` reproduce command.

**Red CI on master:** [CI red runbook](ci-red-runbook.md).

| File suffix or location | Lane | Command | Runs in PR CI |
|---|---|---|---|
| `*.test.ts` | unit (parallel shards) | `bun run test` | yes, 8 weighted shards |
| `*.serial.test.ts` | serial (one process per file; listed in `scripts/serial-files.tsv`) | `bun run test:serial` | yes, 4 pooled workers |
| `*.slow.test.ts` | slow (cold paths, long workloads) | `bun run test:slow` | named jobs and unit shards |
| `test/e2e/*.test.ts` | E2E (real Postgres) | `bun run test:e2e` | yes, Selected E2E plus named jobs |
| `*.live.test.ts`, `test/live/` | paid provider calls | named per file (see [API keys](#api-keys-and-running-all-tests)) | no |
| `tests/heavy/*.sh` | ops-shape shell scripts | `bun run test:heavy` | label `heavy-tests` and nightly |
| `admin/e2e/*.pw.ts` | browser | `bun run test:admin` | yes, `admin-browser` |

## CI runner capacity

Repository-owned Linux validation jobs use ephemeral Ubicloud runners pinned to
Ubuntu 24.04. The Ubicloud Managed Runners GitHub App must have access to this
repository and active billing in its connected project; runner labels alone do
not grant access. No Ubicloud API token is passed to workflow jobs.

| Workload | Runner | Capacity |
| --- | --- | --- |
| Unit shards, slow and eval jobs, BrainBench, admin browser, shared-skills compatibility, persistence soak, reconciliation crashes and read latency, native Linux cells, OpenClaw startup, JSONB parity, PR serial pool, E2E backend matrix, Tier 2, coverage reports and Semgrep | `ubicloud-standard-4-ubuntu-2404` | 4 vCPU, 16 GB RAM |
| Nightly coverage serial pool, `verify`, PgBouncer/RLS deployment matrix | `ubicloud-standard-8-ubuntu-2404` | 8 vCPU, 32 GB RAM |
| E2E Tier 1 (its CLI `init` spawns exceed their timeouts on 4 vCPUs), label-gated and nightly heavy-tests jobs | `ubicloud-standard-16-ubuntu-2404` | 16 vCPU, 64 GB RAM |
| Label-gated heavy test suite | `ubicloud-standard-30-ubuntu-2404` | 30 vCPU, 120 GB RAM |
| Native ARM64 glibc and musl tests | `ubicloud-standard-4-arm-ubuntu-2404` | 4 vCPU |
| Selected E2E (one Bun process each), planning, status aggregation, dependency audit, gitleaks, security regressions and actionlint | `ubicloud-standard-2-ubuntu-2404` | 2 vCPU, 8 GB RAM |

macOS and Windows matrices stay on GitHub-hosted runners. Release building and
publishing also stay unchanged. The pinned upstream OSV reusable workflow does
not expose a runner override, so its runner remains upstream-owned.

Sizes come from measured CPU use, not guesses. Each Ubicloud project shares one
vCPU quota between pull-request CI and agent `ci:ubicloud` VMs, so an oversized
runner makes every other job wait, and an undersized one lengthens the PR
critical path. A unit shard is one Bun process that averages 1.1-1.5 busy
cores, yet on 2 vCPUs the unit shard mean rose from 542s to 608s on a full PR
run and made Test the critical path, so unit shards stay on 4 vCPUs. On matched
VMs a unit shard takes the same time on 4, 8 and 16 vCPUs; the serial pool and
`verify` take the same time on 8 and 16 vCPUs (serial shard 2: 222s and 224s;
277s on 4); the 2,500-write PGLite soak averages 1.3-1.8 busy cores and takes
523s on 4 vCPUs and 500s on 16. Selected E2E workers run one file at a time and
fit on 2 vCPUs. Re-measure with `scripts/ubicloud/ubi-runner.sh run -s standard-N`
before resizing a runner: more CPU does not shorten a single-process job, and
the decision rule is critical path first, vCPU-minutes second.
`test/scripts/ci-runner-routing.test.ts` pins capacity and platform routing;
`.github/actionlint.yaml` declares the exact custom runner labels.

### Event parity

Every test file runs on every push to master, on the nightly schedule and on
manual dispatch, and pull requests and merge-queue runs (`merge_group`) run
every Bun-version cell too. Each narrower PR behavior is a named exception
whose comment names the scheduled run that covers it
(`test/scripts/ci-pr-scope.test.ts` fails on an unclassified one). Table,
dependency-audit rule and cost: [docs/ci-event-parity.md](ci-event-parity.md). Required checks stay keyed on
the `test-status` and `e2e-status` aggregators.

The `changes` job classifies a pull request's changed files with
`scripts/ci-native-scope.sh`: native lock sources, the native toolchain, IPC,
persistence, publication, backup, export and sync sources, their native tests,
`package.json`, `bun.lock` and the workflow files select every target; a
`package.json` or `openclaw.plugin.json` diff that changes only the version
does not (`scripts/ci-manifest-diff.sh`). An unreadable file list selects
every target too. Skipped cells never report a
failure: `test-status` needs the `native-locks` and `persistence-validation`
workflow calls, which succeed when their remaining cells do, so the required
check names are unchanged. `test/scripts/ci-pr-scope.test.ts` pins every scope.

Shared persistence suites use `test/helpers/test-backends.ts`: direct invocation
defaults to PGLite, and a safe `DATABASE_URL` opts into both engines. Their E2E
wrappers select PostgreSQL before registering tests, refusing a missing or unsafe
database instead of silently running only the local backend. Backend selection is
captured at registration so hooks retain it after the import environment restores.
Every backend's assertions remain in the shared suites; engine-specific cases run
in their owning lane.

Ordinary PostgreSQL `setupDB()` clears fixture data, operator configuration and
source sync identity while retaining `config.version` and the stored embedding
identity, avoiding historical migration
replay against an already-current schema. Migration-focused fixtures use
`setupDB({ replayMigrations: true })`; an absent ledger also runs the cold chain.
`test/e2e/fixture-reset-postgres.test.ts` checks both paths, cleanup and vector-shape
preservation, including the deliberate legacy-width restoration helper. That
helper aligns both the physical columns and stored embedding identity with the
legacy test configuration; ordinary resets preserve that identity.

Shared-skills suites, the old-binary compatibility job and the lifecycle benchmark are described in
[scripts/shared-skills/README.md](../scripts/shared-skills/README.md#tests-and-ci).

### Executed-test receipts

A green job proves only that nothing failed; receipts prove which tests ran.
With `GBRAIN_TEST_RECEIPT_DIR` set, every Bun invocation a runner makes
(`test-shard.sh`, `run-unit-shard.sh` per file, the parallel wrapper's rescue
pass, `run-serial-tests.sh` pooled runs and rescues, `run-slow-tests.sh`,
`run-e2e.sh`, and bare `bun test` CI steps through
`scripts/run-with-receipt.sh <lane> <tag> -- bun test …`) writes one receipt:
`<id>.receipt` (lane, kind `primary|rerun|rescue`, shard, backend arm, commit,
run attempt, exit code), `<id>.files` (the assigned files) and Bun's native
JUnit report. `GBRAIN_TEST_RECEIPT_LANE` overrides the runner's lane name.
`scripts/lib/test-env.sh` (`receipts_init`) reads both variables and unsets
them, so tests and nested runners never inherit them. `bun run test` writes
receipts to `.context/test-receipts/` by default, cleared per run.

`bun run verify` records each check as pass, fail, timeout or skip in
`<log dir>/outcomes.tsv` and in a JUnit receipt. A check that skips itself
prints `GBRAIN_CHECK_SKIPPED: <reason>` and exits 0; the recorder counts it as
a skip, never a pass. Verify keeps its per-check logs when a check fails.

`scripts/ci-executed-counts.ts` is the ledger. It accounts for every executed
test by identity, (lane, file, test name, backend arm); repeated names inside
a file are numbered by order (`name [#2]`). One side prints the per-lane
executed/skipped/failed table and every completeness problem; two sides also
list every base identity that no longer executes in head:

```bash
bun scripts/ci-executed-counts.ts --head-run <test-run>,<e2e-run>
bun scripts/ci-executed-counts.ts --base-run <test>,<e2e> --head-run <test>,<e2e> --summary pr-table.md --json ledger.json
bun scripts/ci-executed-counts.ts --base-dir <receipts> --head-dir <receipts>
```

A comparison is `incomplete`, and fails, when an assigned file has no valid
JUnit from any attempt, a report is truncated or comes from an earlier run
attempt, a shard is missing, a lane executed zero tests, or a base artifact is
missing from head. A later rescue or rerun supersedes an earlier attempt for
the files it re-ran. A dropped identity passes only when
`docs/test-audit/2026-10-04/expected-deltas.tsv` declares it as `retire`
(with a Retiring-a-test evidence pointer), `move` (new lane, file or test
name), `skip` or `job`; otherwise the tool prints the exact row to add. New
tests need no row. `--fail-on-additions` compares two baseline runs for
stability. Both workflows upload `receipts-<lane>` artifacts, and the
report-only `executed-receipts` job writes the ledger table to the step
summary.

Failure reporting rides the same machinery. `scripts/capture-test-log.ts`
adds the last 50 failures to a red job's step summary (file, test, backend
arm, first error block and a `bun test … -t` reproduce command), falling back
to the log tail when no `(fail)` line exists. `run-e2e.sh` kills and names any
process still running under a file's `HOME`, and fails that file by name when
its `HOME` cannot be removed. Coverage lanes write `executed-files.txt` on red
runs too; `lane-manifest.json` is written only on a green run.
### Canonical reconciliation

Canonical reconciliation, durable `put_page` acceptance and required-write suites are described next to
their harness in [scripts/persistence/README.md](../scripts/persistence/README.md#test-suites).

### Search and transport regressions

Real-planner search regressions run on Postgres:
`test/e2e/vector-candidate-safety-postgres.test.ts` (natural plans against
forced-HNSW controls, server cancellation of exact fallback),
`test/e2e/search-query-contract-postgres.test.ts`,
`test/e2e/projection-statistics-postgres.test.ts` (owner, restricted-reader and
FORCE-RLS roles) and `test/e2e/vector-plan-real-column-postgres.test.ts`, which
needs CREATEDB and `CREATE EXTENSION vector` for its dedicated 64-dim database
and so runs under `bun run ci:local`. Their PGLite and SQL-shape counterparts
are `test/search/vector-freshness.test.ts` and
`test/search/vector-statement.test.ts`; `scripts/bench/vector-plan-5824.ts` is
the opt-in reporter-scale bench. `test/e2e/projection-recovery-parity.test.ts`
runs the shared recovery contracts and `symbol-resolver-projection-race.test.ts`
on Postgres; PGLite work caps never count a Promise race as cancellation
evidence. `test/pglite-in-memory-create-retry.serial.test.ts` mocks the PGLite
module (own process) to pin one cold retry before an in-memory database opens.
OAuth transport contracts live in `test/e2e/serve-http-oauth.test.ts` and
`test/oauth-scope-hint.test.ts`; each file's header lists its cases.

### Coverage responsibilities before consolidation

Assign ownership to an **assertion and its execution boundary**, not to a test
filename or a shared helper. Record the contract, backend, runtime version,
OS/architecture/libc, source-versus-compiled artifact, transport/authentication,
process/storage/crash boundary, workload size and required cadence. Shared
scenario code across two engines is not duplicate engine coverage: PostgreSQL
JSONB, locking and pooler behavior are not established by a PGLite pass.

| Responsibility | Execution owner | What it does not establish |
|---|---|---|
| Keyless behavior, structural guards and shared contracts | Unit shards and `verify` in `test.yml`; process-isolated serial and dedicated slow lanes where required | Real PostgreSQL, native activation or compiled behavior |
| PostgreSQL behavior and engine parity | Selected E2E and named jobs in `e2e.yml`; the complete nightly runner corpus | Execution of key-gated or native-door assertions merely because their files were discovered |
| Durable publication and recovery under sustained load | `persistence-validation.yml` and `scripts/persistence/README.md` | Power-loss safety, production authentication or equivalence to two smaller databases |
| Native lock ABI and compiled-process exclusion | `native-locks.yml`, compiled smoke and release validation | All compiled CLI features or native-harness activation |
| Browser journeys | Required `admin-browser` job and `admin/e2e/*.pw.ts` | Vendor-native agent behavior |
| Native agent doors and heavier operational scenarios | Explicit jobs in `heavy-tests.yml` | A passing skipped door or generic protocol test is not native activation |
| Live-provider and optional recipe/eval behavior | Their explicitly configured opt-in commands/jobs | A missing key, early return or skipped assertion is not live-provider evidence |
| Line-coverage accounting | PR `prCorpus` and nightly `fullCorpus` reports | Subprocess coverage, all platforms or proof that every discovered case executed |

Before removing repeated work, identify the surviving owner for the same
contract **and every relevant boundary**, prove that owner actually executes,
and retain its cadence, failure gate and coverage artifacts. A shared fixture
can reduce maintenance while keeping both engine arms. Making one crash lane
authoritative or collecting LCOV in a named owner requires a separate ownership
change; nightly sharding alone makes neither change.

The 2026-09-29 test audit's lane reports, inventories and mutation-probe logs
are committed under [docs/test-audit/2026-09-29/](test-audit/2026-09-29/README.md);
cite them for the surviving-owner and probe evidence behind a consolidation.

Recorded ownership changes:

- `test/e2e/reconcile-crash.test.ts` and `test/e2e/reconcile-crash-unactivated.test.ts`:
  the PR owner is `persistence-validation.yml`, called from `test.yml` on every
  PR on both supported Bun versions against pg16. Its "Require all
  reconciliation crash boundaries" step runs both files by name and uploads the
  crash manifests, unchanged. Both files are in `E2E_EXCLUSIONS`
  (`PERSISTENCE_VALIDATION_OWNED` in `scripts/e2e-matrix.ts`), so PR
  `selected-e2e` does not run them a second time; `scripts/e2e-matrix.ts`
  prints `excluded: <file> (owned by persistence-validation.yml)` on stderr. The nightly full-corpus E2E run and the local gates
  (`ci:local`, `ci:ubicloud`, their `:diff` forms) still run them. Run them
  locally with the same command the workflow uses, with `DATABASE_URL`
  exported for the test database from "E2E test DB lifecycle":

  ```bash
  GBRAIN_TEST_ALLOW_DATABASE_URL=1 \
  GBRAIN_TEST_RECONCILE_CRASH_MANIFEST_DIR=.context/reconcile-crashes \
    bun --no-env-file test --timeout=180000 \
    test/e2e/reconcile-crash.test.ts test/e2e/reconcile-crash-unactivated.test.ts
  ```

- Attendance parity (`test/attendance-retrieval.test.ts`,
  `test/attendance-repair.test.ts`, `test/extract-timeline-attendance.test.ts`):
  the unit lane owns the PGLite arm; the `test/e2e/*-postgres.test.ts` wrappers
  load the scenarios through `registerPostgresTests`, so E2E runs only the
  PostgreSQL arm.

Name the profile when reporting “all tests.” The local fast loop, `test:full`,
`ci:local`, required PR checks and nightly `fullCorpus` are not interchangeable
supersets. Native matrices, sustained persistence validation, browser tests and
optional recipe/eval commands have separate responsibilities. A faster nightly
E2E schedule does not shorten a PR critical path dominated by persistence.
Report matched executed timings separately from dry-run partition estimates,
including setup, queueing and retries; never count skip-only output as coverage.

#### Postgres-arm lanes

The unit, serial and slow lanes unset `DATABASE_URL`, so a test file whose
PostgreSQL arm is gated on it (a zero-argument `testBackends()` call, or a
`DATABASE_URL` read used as a condition or connection argument) runs that arm
only where a Postgres lane names it. Those lanes are: a workflow step that
runs with `DATABASE_URL` and names the file, a `test/e2e/` wrapper that
imports it (`registerPostgresTests`), a `tests/heavy/` script that names it,
or a row in `scripts/e2e-backend-matrix.txt`. Unit-lane files with no other
Postgres owner are listed in `test/postgres-unit-arms.txt`, read by
`persistence-validation.yml`'s `unit-postgres-arms` job (one Bun process per
file), the [race hunt](#race-hunt) and the lane guard.
`bun run check:postgres-lanes` (in `verify`) fails on every arm with no lane
and on a bad list row. An arm deliberately left out is an `ALLOWLIST` row in
`scripts/check-postgres-lane-coverage.ts` naming its reason and TODO; a row
for a file that is laned, has no arm or is gone fails.
### Stress gate

`stress-changed-tests` (in `test-status`) runs each touched test file 10x on fresh databases; local twin `bun run test:stress`. Details: [scripts/stress/README.md](../scripts/stress/README.md).

### Race hunt

Nightly: every listed Postgres arm 10x ([details](../scripts/stress/README.md#race-hunt)).

### Scale tier

The gate shape and cadence are defined once, by O-CEO-16 (with O-ENG-16 and
O-CEO-9) in the Foundations 1 plan; `scripts/scale/gates.ts` and
`.github/workflows/scale-tier.yml` implement it. This section says how to run it.

How to run it, what it measures, exit codes, the watchdog and the large-brain
ceilings: [scripts/scale/README.md](../scripts/scale/README.md). The import-rate
gate times PGLite by the import process's CPU time and Postgres by wall time;
the README says why.

### Authoring gate

Before adding a test, answer four questions in the PR description or the test
header:

1. What observable behavior or contract does it protect?
2. What credible regression makes it fail?
3. Why does existing coverage not already catch it?
4. Does it need a production seam that no production caller needs?

A regression test must fail when its fix is reverted; prove it with
`scripts/check-test-discriminates.sh` (see CONTRIBUTING.md). If question 1 has
no answer, or the answer to question 3 names an existing owner at the same
boundary, do not add the test.

Good: a test that runs `gbrain remote ping` against a fake MCP server returning
`{ status: 'failed' }` and asserts exit code 1 with the failure reason in the
JSON output. It protects a user-visible contract, fails if the poll loop reads
the wrong field, and needs no seam.

Bad: a test that reads `src/commands/remote.ts` and asserts it contains
`job.status`. It passes when the loop is broken in a way that keeps the token,
fails on a harmless rename, and duplicates the behavioral test above.

### Contributor audit

`bun run audit:contributors <base>..<head> [--prs <manifest>] [--json]`
(`scripts/contributor-audit.ts`) re-proves discrimination for every
first-parent commit in the range and for each PR head in `--prs`, trial-merged
onto `<head>`. In an isolated worktree of `<head>` it runs the change's test
files, one Bun process per file as the unit loop does (green baseline required), reverses only that change's product hunks
(`git diff M^1 M -- <product files> | git apply -R`; tests and docs stay),
reruns, restores, checks the tree is identical and re-verifies green. Hunks
that no longer apply at `<head>` are audited at the merge commit itself.

Results use the helper's vocabulary (`discriminates`, `does_not_discriminate`,
`vacuous_failure`) plus `setup_failed`, `conflict` and `not_audited`, with a
reason. Human verdicts (`accept`, `rework`, `reject`, `not_yet_proven`) live in
a separate `--verdicts` file and print in their own column. It also runs
`wave-security-scan` (range and each PR) and `check:postgres-lanes` (head and
each trial merge) from the trusted checkout; `--skip-security` and
`--skip-lanes` opt out.

Preflight checks Bun against `engines.bun`, the refs, gitleaks and python3,
and a `--postgres` database (which must be test-shaped). PR heads are pinned
into `<run-dir>/prs.pinned.json`; state and per-step logs live in the run dir
(default `.git/contributor-audit/<base>-<head>/`), so `--resume` skips finished
cases and refuses when refs or pins differ. `--step-timeout` (default 900s)
bounds each step. Exit: 0 clean, 1 needs a human look, 2 usage or preflight
refusal (an agent-contract envelope), 130 interrupted.

Untrusted code (install with `--ignore-scripts`, tests) runs under `env -i`
with an allowlist: temporary `HOME` and `GBRAIN_HOME`, no credential files,
`DATABASE_URL` and `GBRAIN_DATABASE_URL` empty unless `--postgres` is given,
`bun --no-env-file`. For stronger isolation, run the unit audit on an
ephemeral Ubicloud VM with outbound network blocked after `bun install`
(optional). First run: `bun scripts/contributor-audit-fixture.ts <dir>` builds
an offline range covering each result. Tests:
`test/scripts/contributor-audit.test.ts`.

### Retiring a test

Delete or merge a test only with evidence, recorded in the PR body:

1. Name the contract the test claims to protect and classify the evidence case
   below.
2. Probe it: make a behavior-breaking edit to the production code (or, for a
   vacuous assertion, show that such an edit passes), run the test and the
   surviving owner, then revert. Behavior-preserving edits that fail the test
   are useful extra evidence of implementation coupling.
3. Confirm the surviving owner executes ([executed-test receipts](#executed-test-receipts), not skip output)
   at the same or a more frequent cadence, with an equal or stronger failure
   gate, per "Coverage responsibilities before consolidation" above.
4. Remove the deleted file's entries from `scripts/ubicloud/weights.json`,
   `scripts/test-weights.json`, `scripts/serial-weights.json` and
   `scripts/e2e-weights.json` (`bun run check:weight-coverage` fails on a
   leftover), grep `scripts/` and `.github/` for the path, and regenerate `scripts/structural-suites.tsv`
   (`bun scripts/classify-tests.ts`).

Evidence cases:

- **Retained contract:** the contract still matters. Evidence is a surviving
  owner at the same boundary plus an executed mutation that fails it.
- **Intentionally abandoned contract:** the behavior is being removed or was
  never shipped. Evidence is the approved disposition plus reachability proof
  (no production caller) and a check that no user-facing promise (docs, skills,
  `--help`, CHANGELOG) still describes it.
- **Vacuous assertion:** the test asserts nothing about product behavior (a
  constant compared to itself, a copied function, a `typeof` probe that
  typecheck already enforces). Evidence is a demonstration that a
  behavior-breaking edit leaves it passing, or that it imports no product code.

Evidence template:

| Deleted test | Probe edit | Result | Surviving owner | Owner result |
|---|---|---|---|---|
| `test/x.test.ts` › "name" | `src/y.ts`: what changed | deleted test passes (blind) | `test/z.test.ts` › "name" | fails (N of M) |

### Test command tiers

The sequential E2E runner gives each test file a fresh `HOME` and `GBRAIN_HOME`.
Configuration written by a CLI initialization or schema migration remains
available within that file, but cannot change a later file's selected schema or
harness state. Each file's home is removed after it exits, including failures;
the runner's exit trap also cleans up interrupted runs.

Test command tiers, each with a clear scope:

| Command | What it runs | Wallclock | When to use |
|---|---|---|---|
| `bun run test` | Parallel unit loop (`scripts/run-unit-parallel.sh`): weighted shards (CPU-detected, 4 by default, at most 8; CI uses 8), then the serial pass. Excludes `*.slow.test.ts` and `test/e2e/*`; no typecheck. Builds the PGLite schema snapshot first and exports `GBRAIN_PGLITE_SNAPSHOT` (opt out: `GBRAIN_NO_SNAPSHOT=1`). Caps total concurrency to available memory at `GBRAIN_TEST_MEM_PER_FILE_MB` (default 1536) per slot, shedding intra-shard width before shards. Shards that fail with the WASM out-of-memory signature or are killed externally get one serial rescue pass: phantoms go green with an `oom_rescued` note, real failures stay red. Knobs: `GBRAIN_TEST_NO_MEM_ADAPT=1`, `GBRAIN_TEST_NO_OOM_FALLBACK=1`, `GBRAIN_TEST_MAX_CONCURRENCY` (default 4), `GBRAIN_TEST_SHARD_TIMEOUT` / `GBRAIN_TEST_SHARD_KILL_AFTER`, `--shards N` / `--max-concurrency N` / `--dry-run`. | a few minutes on a laptop | Inner edit loop. Default. |
| `bun run verify` | CI's authoritative pre-test gate set, fanned out by `scripts/run-verify-parallel.sh` through a bounded worker pool (default `detect_cpus`; override `GBRAIN_VERIFY_MAX_PARALLEL`) with the heavy checks ordered first (typecheck, the two compile-embed checks, admin build, fuzz bundles, whole-tree greps), then the self-timed `SOLO_CHECKS` alone ([why](operations/verify-and-nightly-e2e.md#verify-solo-checks)). Two evals ride the unit lane instead ([why](operations/verify-and-nightly-e2e.md#evals-in-the-unit-lane)). The `CHECKS` array in that script is the single source of truth — CI literally calls `bun run verify` in a dedicated job. | ~65-85s | Before pushing; before `/ship`. |
| `bun run test:full` | `verify && bun run test && bun run test:slow && [smart e2e]`. Smart e2e runs only when `DATABASE_URL` is set and propagates its failure; otherwise it prints a skip notice to stderr. Use `ci:local` to provision the databases and require PgBouncer execution. | ~3-5min depending on slow + e2e | Pre-merge sanity, before opening a PR. |
| `bun run ci:local` | Independent host gitleaks scans, then frozen dependencies, guards/typecheck, the complete serial and slow lanes, and four unit/E2E shards inside Docker. Each E2E shard has its own pgvector database; selected PgBouncer tests must execute against the transaction-mode pooler. Unit, serial, and slow lanes have database URL overrides unset. Any failed stage fails the command. Complete shard logs survive container teardown under `.context/ci-local-shards/`. `ci:local:diff` runs only gitleaks and the doc checks on a doc-only diff and the full gate otherwise; `--no-shard` runs unit/E2E sequentially. Doc-only diffs still require successful gitleaks scans. | Depends on the full corpus | Full local gate before shipping. |
| `bun run ci:ubicloud` | The `ci:local` lanes (gitleaks, guards/typecheck, serial, slow, unit, all E2E with required PgBouncer execution) fanned out across ephemeral Ubicloud VMs from one heaviest-first work queue; `ci:ubicloud:diff` takes the same doc-only fast path as `ci:local:diff`. Needs `UBICLOUD_API_KEY` or `UBICLOUD_API_TOKEN`, no local Docker. See "Ubicloud fan-out" below. | ~5 min | Full gate before shipping when a Ubicloud token is available. |
| `bun run test:slow` | Just the `*.slow.test.ts` set (intentional cold-path correctness checks). | seconds-to-minutes | When touching slow-path code. |
| `bun run test:serial` | The `*.serial.test.ts` set listed in `scripts/serial-files.tsv`, one Bun process per file, run through a pool of concurrent per-file processes (`min(detect_cpus, 4)`, memory-adapted) heaviest-first from `scripts/serial-weights.json` (absent weights fall back to the corpus p75; scheduling only). The `EXCLUSIVE_FILES` in `scripts/run-serial-tests.sh` (machine-global state, at most 3) run sequentially after the pool, on shard 1 only. Per-test timeout 120s; each pooled file is killed at 300s. `SHARD=N/M` partitions pooled files by duration. Externally killed files get one sequential rescue run. Knobs: `GBRAIN_SERIAL_POOL=N` (`1` is fully sequential), `GBRAIN_SERIAL_FILE_TIMEOUT`. | a few minutes at pool=4 | Debugging quarantined files; CI's serial-tests job. |
| `bun run test:e2e` | Real Postgres E2E. Requires Docker + `DATABASE_URL`. Sequential within a shard; `SHARD=N/M` fans out against separate databases (ci-local runs 4 containers). Activates the PGLite snapshot like every other runner (per-file cold-path opt-outs where the test asserts the path TO post-initSchema state), exporting it as an ABSOLUTE path so CLI children spawned with varying cwd still find it. | ~5-10min | Pre-ship; nightly. |
| `bun run test:compile-smoke` | Self-update integrity verify under a REAL `bun build --compile` binary, offline; also runs unconditionally in the serial lane. The unit suite mocks the network seams; this proves the dependency-free crypto/base64/JSON verify path survives compilation — the failure mode `sigstore-js` would have hit. | under 1s (one small compile) | When touching `src/core/binary-self-update.ts`; pre-ship on self-update changes. |
| `bun run regen:all` | Regenerates every generated artifact (schema, migrations registry, error-code docs, protocol blocks, tool catalog, skills manifest, structural suites, `llms.txt` last, and the others in `scripts/regen-all.ts`) offline and keyless, and lists what changed; a second run changes nothing. `--check` is read-only and runs in `verify` as `check:regen-all`. `--goldens` also regenerates the offline contract goldens, a deliberate act each PR justifies; Postgres goldens are named with their own commands. | about a minute | After any change a freshness check flags; before `/ship`. |
| `bun run test:agent-voice` | The agent-voice recipe's vitest unit suite (`recipes/agent-voice/tests/unit`), via `scripts/test-agent-voice.sh`: installs pinned vitest + ws into a temporary prefix and links it as the recipe's `node_modules` for the run. Needs node + npm and registry access. CI runs it in test.yml's verify job. | ~10s | When touching `recipes/agent-voice/`. |
| `scripts/ship-remote-tests.sh` | Pushes the branch, dispatches `test.yml` (or `--workflow`) on GitHub's runners for that branch or `--ref`, and waits with `gh run watch --exit-status`, so its exit code is the run's. Needs an authenticated `gh`; unlike `ci:ubicloud` it needs no Ubicloud credential and runs the workflow's own job inventory. | one CI run | Offloading the suite from a saturated local machine. |
| `bun run test:profile` | Reads a captured `bun test` log on stdin and prints the N slowest tests (`-n N`, default 10): `bun test 2>&1 \| bun run test:profile`. | seconds | Finding slow tests to fix or demote to `*.slow.test.ts`. |
| `bun run test:admin` | Pinned Playwright Chromium tests for the production embedded admin UI, served with an isolated temporary home/cwd and in-memory PGLite. Exercises owner login, OAuth consent, registration, setup, and lifecycle actions. | seconds-to-minutes | When touching the admin browser flow; required `admin-browser` CI job. |

For the admin browser lane, install frozen dependencies in the repository and
`admin/`, run `bunx playwright install --with-deps chromium` on Linux, then run
`bun run build:admin` before `bun run test:admin`. Tests live in
`admin/e2e/*.pw.ts` so Bun's unit-test discovery does not execute them. The
browser suite proves the GBrain dashboard journey; it does not establish
activation inside a native vendor harness.

There is no `check:all` script: a second, hand-synced guard registry would
drift from `verify`, leaving checks that never run anywhere. The `CHECKS`
array in `scripts/run-verify-parallel.sh` is the single execution list
(including `check:newlines`,
`check:no-legacy-getconnection`). The guard REGISTRY is `scripts/guards-manifest.tsv` (see "Guard registry and
self-test" below).

`bun run typecheck` ([heap ceiling](operations/verify-and-nightly-e2e.md#typecheck-heap)) uses TypeScript's native incremental analysis in
`node_modules/.cache/gbrain-typecheck.tsbuildinfo`. Every invocation still runs
the compiler; source, root-file, configuration and dependency changes invalidate
the affected analysis, and cached diagnostics remain failures. The cache is local
and ignored by Git; CI does not restore prior typecheck results.

The local Docker runner isolates root and admin `node_modules`, plus the generated
admin bundle, in named volumes. Admin build dependencies, Vite's generated cache
and build output stay inside container volumes instead of replacing host files
or leaving root-owned directories behind. `ci:local --clean` removes these volumes
too; build the admin app on the host when updating its committed bundle.

### Ubicloud fan-out (`ci:ubicloud`)

`scripts/ci-ubicloud.ts` runs the `ci:local` gate (uncommitted edits included) on ephemeral Ubicloud VMs
from one heaviest-first work queue; every VM is destroyed on exit. VM setup, scheduling, weights, quota
and flags are in [scripts/ubicloud/README.md](../scripts/ubicloud/README.md).

VMs are named `ubirun-<owner>-<epoch>-<suffix>`; set `UBI_OWNER` to your thread
code. Teardown destroys every VM the run asked for, including creates still in
flight, and stale-VM sweeps run only with `UBI_GC_HOURS` set and only on your
own VMs. `scripts/ubicloud/ubi-runner.sh usage` shows vCPUs by owner.
A sleeping machine kills the run with no signal, so teardown never runs: on Capy, run
`ci:ubicloud` as a watched background operation. After any interrupted run, check
`ubi-runner.sh list --mine` and reap leftovers with `down NAME` (or `gc HOURS`, own VMs only).

The project quota is 512 vCPUs, shared with PR CI; a full gate takes 64, or 160 when it is free.
In a multi-lane wave, lanes run `ci:ubicloud:diff` or targeted suites (`bun
test <files>`, `--lanes`); only the integrator runs the full gate.

### E2E backend matrix

`scripts/e2e-backend-matrix.txt` lists the E2E files that must pass on direct
Postgres and through a transaction-mode PgBouncer: the E5 executor binding
matrix (`test/e2e/executor-binding-matrix.test.ts`, whose PGLite arm is
`test/executor-binding-matrix.test.ts`) and every `test/e2e/*parity*` file.
When `GBRAIN_PGBOUNCER_E2E_URL` is set, `scripts/run-e2e.sh` runs each listed
file twice: first against `DATABASE_URL` with
`GBRAIN_TEST_BACKEND=postgres-direct`, then with `DATABASE_URL` set to the
pooled URL and `GBRAIN_TEST_BACKEND=pgbouncer`. The PGLite arm inside each
parity file runs in both passes. Both passes must execute the same, non-zero
number of tests, and the summary prints the per-backend counts. The pooled
URL must carry `?prepare=false`, because `resolvePrepare` only auto-detects
port 6543 and CI poolers listen elsewhere; the runner refuses a pooled URL
without it. With `GBRAIN_CI_REQUIRE_PGBOUNCER=1`, a listed file fails when no
pooled URL is configured.

Instead of a full URL, a lane may set `GBRAIN_PGBOUNCER_E2E_DB=<name>`: the
runner then reaches that database through the pooler in
`GBRAIN_PGBOUNCER_URL`, pins `prepare=false` itself, and creates the database
on first use through `GBRAIN_PGBOUNCER_DIRECT_URL`
(`scripts/lib/ensure-e2e-database.ts`). `ci:ubicloud` routes each slot's own
pooler at the slot database, `ci:local` gives each shard a
`gbrain_pooled_<N>_test` database behind its single pooler, and `e2e.yml`'s
`tier1-backend-matrix` job runs the list in two weighted shards (`SHARD=N/2`) against a `pgbouncer` service; it is
the PR owner of the listed `test/e2e/` files, which Selected E2E excludes. An entry may carry
`<TAB>pooled-timeout=<seconds>` when its pooled pass needs more than the
per-file cap; `!path<TAB>reason` records a parity file deliberately left out.
`test/scripts/e2e-backend-matrix.test.ts` pins the list's completeness, the CI
wiring and the runner's count assertion.

### Engine-sql

The engine-sql executor (`src/core/engine-sql/`, refactor wave 1 W1) is pinned
by these tests; the `*-parity` and RLS files run on every backend in the matrix
above, and each E2E file keeps a PGLite arm in the unit lane.

- `test/executor-binding-matrix.test.ts` / `test/e2e/executor-binding-matrix.test.ts`:
  the E5 case table runs twice per backend, through `engine.executeRaw` and
  through the dialect adapters (`engineSqlExecutor` factory), so the adapters
  bind, count, fail and cancel exactly like master's raw path.
- `test/engine-sql-executor.test.ts`: `sqlFragment` renders the same text and
  values as the postgres.js tagged template (vendored serializer); Postgres
  driver options (`prepare: true, simple: false` for converted statements,
  master's options for `executeRaw` / `unsafe`), gauge bypass, EO1 transaction
  lane, brand `@ts-expect-error` fixtures.
- `test/e2e/engine-sql-prepare-parity.test.ts`: `pg_prepared_statements` holds a
  converted statement on direct Postgres and nothing through PgBouncer; a
  zero-parameter multi-statement string is rejected on every backend.
- `test/engine-sql-transaction.test.ts` / `test/e2e/engine-sql-transaction-parity.test.ts`:
  per-domain write-then-throw rollback through `engine.transaction()` and
  `transactionDirect()` (dual pool on Postgres), with a concurrent pool read.
  Add a case to `test/helpers/engine-sql-rollback-cases.ts` for every migrated
  domain write. A mutation that caches the executor on the engine fails it
  (`DISCRIMINATE_BASE=<mutation> bash scripts/check-test-discriminates.sh`).
- `test/engine-sql-capabilities.test.ts` / `test/e2e/engine-sql-capabilities-parity.test.ts`:
  each dialect capability with a boundary-size and a concurrent-write case.
- `test/e2e/engine-sql-normalize-parity.test.ts`: every declared column kind
  of `normalize.ts` decodes to one shape on each backend.
- `test/e2e/engine-sql-rls-scope.test.ts`: `ScopedRead` reads under a
  non-owner `NOBYPASSRLS` role (cross-source denial, concurrent isolation,
  nested rollback restoration, connection reuse).
- SQL text: `test/engine-sql-sql-text.test.ts` goldens must stay byte-identical
  after a conversion; only `sql-text/_driver.json` moves (tagged ->
  `runUnsafe`).

### Native writer locks

Native lock tests, the eight-target `native-locks.yml` matrix, compiled smokes and the OpenClaw native-host
fixture are described in [native/locks/README.md](../native/locks/README.md#tests-and-ci).

### Datastore shutdown and lease ownership

`test/pglite-lock.test.ts` proves process pause/crash handoff, metadata damage,
legacy migration refusal and stable ownership across datastore replacement.
`test/pglite-engine-disconnect.serial.test.ts` uses actual disk-backed PGLite
for concurrent opens, consumer/statement drains, persisted reopen, delayed
close and failed close. A close deadline retains the kernel lock; it is never
successful shutdown evidence. Watchdog and telemetry regression suites cover
loop starvation and background statement teardown.

`test/db-lock-concurrency.test.ts` proves unique identities even when two
acquisitions have identical database timestamps, exact successor-safe cleanup,
renewal cancellation/late-completion drain and mandatory loss propagation.
`test/e2e/db-lock-acquisition-token.test.ts` repeats acquisition/cleanup
invariants against real Postgres in Selected E2E. `test/engine-control-routing.test.ts` pins direct/shared pool routing,
nested transaction confinement and the Postgres resident-stop barrier.

### Durable persistence schedules and process crashes

Persistence suites (native-matrix publication, managed writers, schedules, crash boundaries, the runtime
matrix and read latency) are described in [scripts/persistence/README.md](../scripts/persistence/README.md#test-suites).

### Engine graduation

Graduation fixtures and suites: [scripts/persistence/README.md](../scripts/persistence/README.md#engine-graduation-tests).

### PGLite schema snapshot (default-on)

`scripts/build-pglite-snapshot.ts` (`bun run build:pglite-snapshot`) bakes a
post-`initSchema()` PGLite data dir into `test/fixtures/pglite-snapshot.tar`
plus a version file; `PGLiteEngine.initSchema()` restores the tar instead of
replaying the embedded schema + all migrations when the env var
`GBRAIN_PGLITE_SNAPSHOT` points at it. Runners activate it through the shared
`ensure_pglite_snapshot` helper in `scripts/lib/test-env.sh` (also home of
`detect_cpus` and `detect_available_mem_mb`), sourced by
`run-unit-parallel.sh`, `test-shard.sh`, `run-slow-tests.sh`,
`run-serial-tests.sh`, `run-verify-parallel.sh`, and `run-e2e.sh` (which
re-exports the path as ABSOLUTE — its tests spawn CLI children with varying
cwd); `scripts/ci-local.sh` calls the builder directly. The helper builds/refreshes the snapshot and
exports the env var, no-ops on `GBRAIN_NO_SNAPSHOT=1` or an already-inherited
path, and is non-fatal on build failure — tests fall back to cold init, with
a one-line "active" echo so a silent fallback stays visible in CI logs.
Measured effect: ~3.5x per PGLite-booting file (a cold boot replays every
migration, ~3.1s each on a CI shard). Properties:

- **Idempotent.** A hash short-circuit exits in ~40ms when the snapshot is
  fresh, and REBUILDS a stale one. The hash covers the raw file bytes of the
  static import closure of `pglite-schema.ts`, the schema-migration registry,
  `migrate.ts` and the forward-reference bootstrap (`engine-sql/bootstrap.ts`),
  plus `pglite-engine.ts` (`src/core/snapshot-schema-inputs.ts` computes the
  list; no hand list). Imported SQL and handler changes
  invalidate the fixture; coverage instrumentation does not change the hash.
  `test/snapshot-inputs-closure.test.ts` checks that list against an
  independent TS-AST closure, requires every literal dynamic import in the
  closure to be classified, and discovers all 13 `pglite-snapshot-*` CI cache
  keys: identical `hashFiles` inputs covering every hash input, each profile
  restoring its own tar. A failure names the missing file and both workflow
  files to edit.
- **Concurrency-safe.** Each profile has its own lock with a PID/token owner
  and host/process-namespace identity. Only a confirmed dead local owner using
  the current retirement protocol can be reclaimed. Both normal release and
  crash recovery retain a nonempty owner tombstone so a delayed observer cannot
  remove the next builder's lock. Keep those records while builders may run.
  Live, foreign, ownerless, or older-protocol locks time out without building;
  callers visibly fall back to cold initialization.
  Temporary tar/version files are atomically renamed, with the version last.

- **Never authoritative.** The loader (`tryLoadSnapshot` in
  `src/core/pglite-engine.ts`) verifies the schema hash AND the embedding
  shape the snapshot was baked with (`dims=` / `model=` lines in the version
  file) against what this process would create; any mismatch — including a
  version file without shape lines — warns once and falls through to normal
  cold init. A wrong fixture can never poison the suite.
- **Opt out.** `GBRAIN_NO_SNAPSHOT=1` skips the build + env export for a run;
  the migration-replay canary tests clear the env themselves regardless.

Pinned by `test/snapshot-shape-guard.test.ts` (hash + shape refusal matrix,
imported SQL/handler dependency hash sensitivity).

The builder accepts `--profile legacy|default` (legacy remains the default).
Legacy uses the unit preload's embedding shape. Default uses the CLI's canonical
embedding shape and writes `pglite-snapshot-default.tar` plus its `.version`.
The artifacts, locks, and CI caches are separate. `ensure_default_pglite_snapshot`
exports an absolute `GBRAIN_TEST_DEFAULT_SNAPSHOT`; BrainBench applies it only
to CLI children, including `run-all`. The parent unit process retains its legacy
snapshot. The slow runner and direct BrainBench test invocation prepare the
default profile automatically. `GBRAIN_NO_SNAPSHOT=1` clears both paths and
survives test preloads.

### PGLite checkpoint harness (outside PR CI)

`scripts/pglite-checkpoint-harness/` reproduces the large-store PGLite checkpoint freeze outside PR CI;
usage and flags are in its [README](../scripts/pglite-checkpoint-harness/README.md).

### macOS 26 validation (`macos-validation`)

`.github/workflows/macos-validation.yml` runs on a GitHub-hosted `macos-26`
runner nightly, on manual dispatch, and on pull requests that carry the
`macos-validation` label. It uses no secrets and has a 90-minute cap. It checks
the device-identity re-stamp (#5604) on real APFS (the step first asserts an
APFS volume with a non-zero birth time and inode; the device-number change
itself stays simulated because a runner never reboots), runs the PGLite checkpoint
harness on a store of at least 2 GiB with the WAL-bound assertion
(#5449), and verifies the latest published signed `darwin-arm64` release
binary with `codesign --verify --strict` and `--version` against its release
tag (#5286). It also runs the bash 3.2 parse guard under the
runner's `/bin/bash`, then `bun run verify` (#5810), so a script or guard that
only works under bash 4 or later fails there. Maintainers with triage or write access apply the label; an
outside contributor whose change touches macOS-specific persistence, locking
or release code asks for it in the pull request. Scheduled and dispatched runs
use the default branch's workflow file, so the label is the way to get this
evidence for a change before it merges. `test.yml`'s security matrix,
`release.yml`'s darwin build and `native-locks.yml`'s darwin cells pin
`macos-26` / `macos-26-intel` rather than `macos-latest`.

### Keeping CI partitions balanced

Required CI runs eight weighted unit workers, four serial workers with bounded
per-file pools, and up to eight selected E2E workers. E2E selection and exclusions
run once before setup; the resulting file lists are frozen and executed against
separate Postgres services. An explicit empty selection launches no tests;
selection errors, failed workers, cancellations, and unexpected skips fail the
existing aggregate checks. Nightly full-corpus E2E uses four independent
Postgres jobs with the same weighted partitioner and one fresh Bun process per
file, sequential within each job. It does not use the selected-E2E exclusion
list: default discovery includes every `test/e2e/*.test.ts` and
`test/phantom-redirect-engine-parity.test.ts`.
Each full-profile worker first initializes its own service schema with the
guarded `setupLegacyEmbeddingDB()` helper, in a temporary home with provider
keys stripped and local environment-file loading disabled. No partition relies
on a preceding file to create shared tables. Bootstrap is a separate timed CI
step and must be included in end-to-end comparisons.

Refresh after a large test wave or when the longest shard repeatedly exceeds
the mean shard execution time by 25%. `bun run check:weight-coverage` (in
`verify`) fails on an entry naming a missing file and, when a lane's unweighted
share passes 5% (unit) or 10% (serial, E2E), warns on pull requests and pushes
and fails the scheduled run, printing the lane's miner command:

```bash
bun run weights:mine --lane unit --run <successful-test-run>
bun run weights:mine --lane serial --run <successful-test-run>
bun run weights:mine --lane e2e --run <successful-e2e-run>
bun run weights:mine --lane e2e --e2e-profile full --run <successful-full-corpus-run>
```

The miner accepts `--from-file` or stdin for timestamped GitHub-format logs and
`--out` for inspection before replacing a checked-in map. Unit timing uses only
unit matrix jobs, includes `evals/`, and closes the final file at the Bun summary.
Serial timing uses runner durations, never timestamps of buffered output. E2E
uses each file's Bun summary and merges partial selections into known weights.
File/stdin imports also merge unobserved entries; only a complete GitHub unit,
serial or explicit full-profile E2E run replaces that lane's entire map. Captured artifacts need their final
successful completion marker, and GitHub imports verify every expected job.
Incomplete or failed inputs leave the existing map intact. Sidecar metadata
records the source run/commit, units, and counts. Unit/E2E weights are milliseconds;
serial weights remain seconds. New files receive the corpus p75 estimate. Empty
maps and zero-cost ties distribute files deterministically; corrupt serial
weights warn and retain safe fallback scheduling.

The default E2E miner reads selected jobs and merges partial observations.
`--e2e-profile full` instead requires a successful GitHub run with a source SHA
matching checkout HEAD. It pins the run attempt and full-job IDs, reconstructs
default discovery using the committed runner and tracked test paths, and
requires every source file exactly once across complete successful job logs.
Missing/extra files, ambiguous basenames, duplicate execution or failed evidence
leave weights and metadata untouched. Basename resolution preserves the
outside-directory parity entry. Full mode replaces the complete map and records
source SHA, attempt, jobs, log hash and corpus hash; file/stdin imports cannot
claim full-profile provenance. These weights schedule work; they are not an
observed parallel runtime.

CI retains timestamped unit/E2E logs, frozen E2E selection, and serial attempt
records for 14 days. Compare push-to-required-green time including queueing,
first failure, rescues/reruns, runner minutes, unique file counts, and coverage
completeness. Compare cold and warm caches separately. Snapshot timings and
partition estimates are projections until matched workflow runs confirm them;
successful test results are never cached.

### E2E selection

`prepare-e2e` reads the pull request's changed files from the GitHub API
(`scripts/ci-changed-files.sh`, shallow checkout) and passes them to
`scripts/select-e2e.ts`: a doc-only change selects nothing, every other change
selects every `test/e2e/*.test.ts`. Diff narrowing is retired: a typical E2E
file imports most of `src/`, so a file-to-test map selected every file on 40 of
40 merged pull requests. An incomplete list (more than 3000 files, a compare
capped at 300, an API error, no pull request or merge-group context) fails
closed to the whole corpus. `scripts/e2e-matrix.ts` then drops
`E2E_EXCLUSIONS`, the files a named job owns, printing each owner: Tier 1's
named files, `tier1-backend-matrix` for every `test/e2e/` row of
`scripts/e2e-backend-matrix.txt` (direct Postgres and PgBouncer, so a
Selected E2E direct-only run would duplicate it), persistence-validation.yml and the live-key lanes.
`test/scripts/e2e-wiring.test.ts` requires every excluded file to have a named
owner. Locally, `ci:local:diff` and `ci:ubicloud:diff` run gitleaks and
`scripts/ci-doc-checks.sh` (llms freshness, KEY_FILES byte caps, documented
paths, skill references, privacy guards) on a doc-only diff and the full gate
otherwise, printing "E2E narrowing is retired".

### Refactor wave 1 goldens

Outputs captured on master before refactor wave 1 moves any code live under
`test/fixtures/goldens/`; `test/fixtures/goldens/README.md` maps each file to
its owning test and named normalizer. `test/helpers/golden.ts` writes and
compares them (`expectGolden`) and proves each normalizer by capturing twice
(`expectNormalizerStable`). Regenerate only deliberately, never in a refactor
commit: `GBRAIN_TEST_UPDATE_GOLDENS=1 bun test <file>` (the switch carries the
`GBRAIN_TEST_` prefix because the unit preload scrubs other `GBRAIN_*`
overrides). Performance baselines are a bench, not a test:
`docs/designs/refactor-wave-1/perf-baseline.md`.

### Doctor check registry

`gbrain doctor` runs `DOCTOR_CHECK_REGISTRY` (`src/commands/doctor/registry.ts`)
in order: one `{ name, emits, run(ctx) }` entry per topic block under
`src/commands/doctor/checks/`, each returning its checks or `STOP_DOCTOR`.
`test/doctor-registry.test.ts` fails with a `FAIL` / `Why` / `Fix` / `See`
block when an entry's `name` or any `emits[]` name is missing from
`src/core/doctor-categories.ts`, when `emits[]` differs from what the entry's
`run` can push (AST walk in `test/helpers/doctor-registry-ast.ts`), or when a
STOP gate moves away from where master's `buildChecks` returned early.
`test/doctor-mode-matrix.serial.test.ts` wraps every entry and the engine
with recorders and asserts, per mode (default, `--fast`, `--fix`,
`--fix --dry-run`, no engine, connection failure), which entries ran, where
the run stopped, which engine calls happened and which mutations landed (the
SKILL.md DRY auto-repair, the dead-holder lock reap). The W0 registry,
early-stop and `--json` goldens pin the output itself.

### Move-only verifier

`scripts/verify-move-only.ts` proves a commit tagged `Move-Only: yes` moves code
without editing it: every top-level statement of every touched TS file on the
base side reappears token for token on the head side (tokens from
`scripts/lib/normalize-tokens.ts`, so whitespace and comments are ignored and
string/SQL text is exact). Imports, `export ... from` lines and toggling the
`export` modifier on a moved statement are allowed and counted. Run
`bun scripts/verify-move-only.ts <commit>` (default `HEAD~1..HEAD`);
`--wrapper migration` inlines `export const vNNN: Migration = {...}` files into
the generated registry array so the W3 split must reproduce the base side's
single `MIGRATIONS` literal entry for entry; `--wrapper doctor-entry` inlines each
`run<Topic>(ctx: DoctorContext): Promise<Check[]>` body (minus its ctx
destructure / `connectedEngine` / `const checks` prologue and `return checks;`)
at its `checks.push(...(await runX(ctx)));` call in `buildChecks`, drops the
`const ctx: DoctorContext = {...};` glue and resolves relative `import()` /
`require()` specifiers to repo paths, so the W4 doctor peel must reproduce the
original `buildChecks` body; and `--rename-map <json>` applies identifier rewrites for
`Mechanical-Rename: yes` commits. Failures print `FAIL: <file:line>` with the
first differing token. Pinned by `test/scripts/verify-move-only.test.ts`.

### Schema migration registry

Schema migrations live one per file in `src/core/schema-migrations/v<NNN>-<name>.ts`
(NNN zero-padded to 3, `name` = the slug with `-` → `_`, one
`export const v<NNN>: Migration = {...}` per file). `bun run new:migration <snake_name>`
scaffolds the next version; `bun run build:schema-migrations` regenerates the committed
static-import registry `registry.generated.ts` (regenerate, never hand-merge). The
array order is master's historical order (`HISTORICAL_ARRAY_ORDER` in
`scripts/build-schema-migrations.ts`), then ascending; the runner sorts by version.
Two guards run in `bun run verify`:

- `check:schema-migrations` (`scripts/check-schema-migrations-fresh.sh`) regenerates
  the registry into a temp file and diffs it; the generator also fails on a
  filename/version/name mismatch and on a version defined twice, naming both files
  with the `git mv` + `version:` + regenerate recipe.
- `check:schema-migration-order` (`scripts/check-schema-migration-order.ts`) fails
  when a migration origin/master does not have is numbered at or below origin/master's
  latest version (it would be skipped forever on current brains) or reuses a version
  with a different name. Base ref: `GBRAIN_MIGRATION_BASE_REF` (default
  `origin/master`); skipped with a notice when the ref is missing, failed under `CI=true`.

Collision recovery: an unapplied branch migration is renumbered (`git mv`, edit
`version`, regenerate); one already applied to a disposable dev DB means rebuilding
that DB and replaying; one applied to retained data needs explicit `schema_version`
reconciliation, never just a counter edit. `bun run release:restamp` does the
renumbering at merge time and prints the old-to-new mapping with these steps
([RELEASING.md](RELEASING.md#release-restamp)). Pinned by
`test/scripts/build-schema-migrations.test.ts` and `test/migrations-golden.test.ts`.

### Schema generator freshness

`check:schema-fresh` (`scripts/check-schema-fresh.sh`) runs `scripts/build-schema.ts
--out-dir <tmp>` (fragments -> `src/schema.sql` regions -> `schema-embedded.generated.ts`
-> `pglite-schema.generated.ts`) and diffs every output, naming the source to edit.
Canonical sources and PGLite capability rules: `docs/ENGINES.md#canonical-schema-sources`.
Pinned by `test/scripts/build-schema.test.ts`; the end state by the E4 catalog goldens.

### Guard registry and self-test

The privacy and test-isolation guards use `scripts/lib/guard-candidates.sh` to
scan fresh file contents in bounded batches before applying their detailed
per-file rules. They do not cache passing results. Candidate scanner failures
fail the guard, and matching files retain the same allowlists and diagnostics.

`scripts/guards-manifest.tsv` is THE single registry of `scripts/check-*`
guards, each classified `scanner` (greps/parses repo sources —
must eventually carry fixtures), `buildfresh`, or `repostate` (build/freshness
guards are exempt-with-reason, not fixture-tested).
`scripts/guard-self-test.sh` (`bun run check:guard-self-test`, wired into
`bun run verify`) proves every `selftest=yes` scanner CAN fail: it runs each
one against known-bad (must exit non-zero) and known-good (must pass) fixture
trees under `test/fixtures/guards/<guard>/{bad,good}/` via the
`GBRAIN_GUARD_ROOT` env seam (guards run 4 at a time, `GUARD_SELF_TEST_JOBS`
overrides; results print in manifest order; the whole pass must finish inside
its 30 s budget), and enforces manifest completeness — a new
`scripts/check-*` script that isn't registered in the manifest fails the
build. A guard whose pattern rots into a permanently-green no-op fails CI
instead of masquerading as coverage.

A guard may carry extra known-bad trees named `bad-<variant>/`; each one must
fail on its own. Refactor wave 1 uses them to prove that every scanner naming
a file the wave splits also scans the new module locations
(`src/core/engine-sql/`, `src/core/schema-migrations/`, `src/commands/sync/`,
`src/commands/doctor/checks/`, `src/commands/serve-http-*.ts`,
`src/core/minions/handlers/`): `check-jsonb-pattern.sh`,
`check-engine-dynamic-import.sh`, `check-source-config-leak.sh`,
`check-no-legacy-getconnection.sh`, `check-operations-filter-bypass.sh`,
`check-source-id-projection.sh` (engine-sql) and `check-search-path.sh` (the
generated PGLite template) each have a bad fixture placed inside the new path. The checklist
of every script, workflow, helper and doc that names a split file is
[`docs/designs/refactor-wave-1/path-consumers.md`](designs/refactor-wave-1/path-consumers.md).

#### Layering guard

`scripts/check-layering.ts` (`bun run check:layering`, in `bun run verify`)
parses every file under `src/core/engine-sql/`, `src/core/schema-migrations/`
and `src/core/persistence/` and fails on any import, type-only included, of an
engine façade (`pglite-engine.ts`, `postgres-engine.ts`, `engine-factory.ts`)
from engine-sql, of `src/core/migrate.ts` from schema-migrations, or of
`src/core/ai/gateway.ts` from persistence. The first two directories are loaded
by the engines and by `migrate.ts`, so an import back up is an ESM cycle that
can fail with a temporal-dead-zone error at module load. Take the executor as a
parameter and import types from `src/core/engine.ts`; migration helpers live in
`schema-migrations/helpers.ts` and the `Migration` type in
`schema-migrations/types.ts`; persistence embeds via `src/core/embedding.ts`. Fixtures:
`test/fixtures/guards/check-layering.ts/`; forms are driven in
`test/scripts/layering.test.ts`.

#### Write-path model guards

`scripts/check-ai-sdk-importers.ts` (in `bun run verify`) fails when a file
outside `scripts/ai-sdk-importers.allowlist` imports a provider SDK (`ai`,
`@ai-sdk/*`, `@anthropic-ai/sdk`, `openai`) as a value, so every model call
goes through `invokeAI`. Each mutating op has a
write-inference class (`src/core/ops/write-inference.ts`).
`test/write-path-zero-llm.serial.test.ts` asserts no generative call before
commit and only attributed facts extraction after it.
`test/write-path-no-egress.serial.test.ts`: keyless CLI writes open no
connection. Helper: `test/helpers/ai-tripwire.ts`.

#### Durable-flush guard

`scripts/check-durable-flush.ts` (`bun run check:durable-flush`, in
`bun run verify`) fails on an `fsyncSync(fd)` anywhere in `src/` outside
`src/core/fs-durable.ts` whose `fd` is assigned from a read-only `openSync`
(flags omitted, a flag string without `w`/`a`/`+`, or `O_RDONLY` without
`O_WRONLY`/`O_RDWR`), file or directory, and on one whose flags it cannot
read. Windows refuses fsync on a read-only handle and has no directory flush
(EPERM), which wedges the managed write queue (#5595) and every skill-bundle
publication (#5475). Flushes of descriptors opened for writing pass. Each
failure prints `FAIL [durable_flush_read_handle]: <file>:<line>`, the open it
traced, a `Fix:` line and this anchor. Fix: fsync the descriptor you wrote
through before closing it (set its final mode with `fchmodSync(fd)` first), or
call `flushFile(path)` / `flushDirectory(path, { bestEffort? })` from
`src/core/fs-durable.ts`. A file that cannot migrate yet goes in the guard's
`ALLOWLIST` with a reason (empty today); an entry whose file no longer needs it fails as
`durable_flush_stale_allowlist`. Fixtures:
`test/fixtures/guards/check-durable-flush.ts/`; forms are driven in
`test/scripts/durable-flush-guard.test.ts`. The helper and the #5595/#5475
regressions run natively on the `windows-latest` row of the test.yml
`security-regressions` job; `test/helpers/win32-flush-semantics.ts` makes them
discriminate on POSIX hosts too.

#### Engine-sql ratchet

`scripts/check-engine-sql-ratchet.ts` (`bun run check:engine-sql-ratchet`, in
`bun run verify`) keeps each storage domain's SQL in one place,
`src/core/engine-sql/<domain>.ts`, by stopping SQL from growing back into the
engines. It parses `src/core/pglite-engine.ts`, `src/core/postgres-engine.ts`
and every file under `src/core/pglite-engine/` and `src/core/postgres-engine/`,
and names each class member (`PostgresEngine.getPage`), top-level function and
top-level variable (`insertFact`). A unit is SQL-bearing when the literal text
of a string, template, tagged template or `+` chain inside it has SQL
structure: `SELECT ... FROM <x>`, `SELECT <fn>(`, `INSERT INTO <x>`,
`UPDATE <x> [alias] SET`, `DELETE FROM <x>`, `WITH <x> AS (`,
`CREATE|ALTER|DROP <object kind>`, `TRUNCATE <x>`, `SET LOCAL <x>`,
`ON CONFLICT`, `WHERE ... ORDER BY|GROUP BY|LIMIT`, or a `$<n>::type` cast.
Comments and identifiers never count. Keywords match in upper or lower case
but never Title Case, and a lowercase match also needs a second SQL signal
(`where`, `returning`, `$1`, `::`, `;`, `*` and similar), so "Select a file"
or "could not delete from cache" is not SQL.

`scripts/engine-sql-baseline.tsv` lists `migrated<TAB><domain>` rows (the
domain's module must exist under `src/core/engine-sql/`) and
`method<TAB><path><TAB><QualifiedName>` rows for the SQL-bearing members that
remain. Rows only shrink. The guard fails on:

- a new SQL-bearing member with no row: move the SQL into
  `src/core/engine-sql/<domain>.ts` and delegate, or mark the declaration (on
  its line or the line above) with `// engine-sql-ok: <reason>`; an empty
  reason fails;
- a stale row, whose member is gone, no longer SQL-bearing or now marked:
  delete it, or run `bun scripts/check-engine-sql-ratchet.ts --prune`, which
  drops stale and duplicate rows and never adds one;
- a duplicate or malformed row, or a `migrated` row with no module.

When a domain moves, delete its members' rows and add its `migrated` row in
the same commit. Fixtures: `test/fixtures/guards/check-engine-sql-ratchet.ts/`;
forms are driven in `test/scripts/engine-sql-ratchet.test.ts`.

#### Engine-sql dynamic SQL

`scripts/check-engine-sql-dynamic.ts` (`bun run check:engine-sql-dynamic`, in
`bun run verify`) parses every file under `src/core/engine-sql/` except
`fragment.ts`, the renderer, which writes `$n` and splices trusted text by
design. In engine-sql every value reaches SQL as a bound parameter through
`sqlFragment`, and only constant text is spliced. Trusted text is a string
literal; a `const` in the same file initialized with trusted text or an
`as const` object or array literal (members and element accesses included); a
`CONSTANT_ALLOWLIST` name (`ENRICH_ORDER_SQL`); a call to a `VETTED_BUILDERS`
entry (`pageReadFilter`, `buildRecencyComponentSql`,
`privatePagesFilterFragment`, `currentCodeEdgeFilter`, `buildCJKKeywordSql`,
`currentTextProjectionFilter`); a template or `+` chain whose parts are all
trusted or are numbers the same function checked earlier with
`Number.isFinite(<same expression>)`; or a conditional whose branches are both
trusted. Both registries live in the script with a one-line reason each. The
guard fails on:

- `trustedSql(arg)` with an arg that is not trusted text: bind the value with
  `${value}` in `sqlFragment` instead, or register a new builder with its
  reason after review;
- an untagged template or `+` concatenation, passed directly or through a
  local variable (`let` appends included) as the SQL of `.query(`,
  `.unsafe(`, `.executeRaw(` or `executeRawJsonb(`, with an untrusted part:
  compose with `sqlFragment` and run it with `executor.run(fragment)`;
- a literal `$<digit>`, or a `$` right before a substitution, in a composed
  string (a template with substitutions, any `sqlFragment` template, any `+`
  operand): let `renderFragment` number the parameters. A static string passed
  as-is may carry `$1`;
- an expanded list, `IN (` right before a substitution or a non-literal `+`
  operand: bind the array as one parameter, `= ANY(${ids}::text[])`, so
  prepared-statement caches stay bounded.

Fixtures: `test/fixtures/guards/check-engine-sql-dynamic.ts/`; forms are
driven in `test/scripts/engine-sql-dynamic.test.ts`.

#### Engine-sql brands

`scripts/check-engine-sql-brands.ts` (`bun run check:engine-sql-brands`, in
`bun run verify`) keeps the RLS read brands in
`src/core/engine-sql/brands.ts` unforgeable. `ScopedRead` records a read that
ran inside `withScopedReadTransaction` on master and `LegacyUnscopedRead` one
that ran unscoped on the pool (EO4), so a forged brand silently changes how a
read is scoped. The guard fails on:

- a brand key (any `__obtainVia...` name) in a text file under `src/`,
  `test/` or `scripts/` other than `brands.ts` and the guard's own script,
  fixtures and test: get a branded executor from `scopedRead(tx)` inside
  `withScopedReadTransaction`, or from `unscopedExecutor(executor, '<reason>')`;
- in `src/`, a cast onto `ScopedRead` or `LegacyUnscopedRead` outside
  `brands.ts`, an `as unknown as T` where `T` names `SqlExecutor`,
  `ScopedRead` or `LegacyUnscopedRead`, or a double cast passed straight to
  `scopedRead(` or `unscopedExecutor(`. Driver-handle casts such as
  `tx as unknown as PgConn` in `dialect-postgres.ts` pass;
- an import of `unscopedExecutor` or `LegacyUnscopedRead` (value, type,
  alias, re-export or `import('...').X` type) from outside engine-sql, the two
  engine façades, doctor (`src/commands/doctor.ts`, `src/commands/doctor/**`,
  `src/core/doctor*`), maintenance (`src/core/maintenance/**`), admin
  (`src/commands/admin*.ts`, `src/core/admin/**`), migrations
  (`src/core/migrate.ts`, `src/core/schema-migrations/**`,
  `src/commands/migrations/**`) and `test/`; an import of `scopedRead` from
  outside engine-sql, the façades and `test/`; or a namespace, dynamic or
  `require` import of `brands.ts` from outside that `scopedRead` list.
  `src/core/ops/**`, the MCP-facing surface, is always denied. Take the
  branded executor from the engine façade instead.

The allowlists live in the script. Fixtures:
`test/fixtures/guards/check-engine-sql-brands.ts/`; forms are driven in
`test/scripts/engine-sql-brands.test.ts`.

#### Retired-phrase guard

`scripts/check-retired-phrases.sh` (`bun run check:retired-phrases`, in
`bun run verify`, under a second) keeps the instructions agents follow
literally in step with refactor wave 1. It greps `CLAUDE.md`, `AGENTS.md`,
`CONTRIBUTING.md`, `docs/` and `skills/` for the contributor-workflow phrases
the wave retired: the old migrations-array wording and appending to it, the
rule that every engine method is written twice, the CLI switch-case step, the
migrate.ts region policy, and schema text listed as a hand-synced pair of
`schema.sql` and the PGLite schema module. The patterns and the current
instruction for each live in the script's `RETIRED` table. Historical records
may quote them and are exempt: `docs/designs/`, `docs/test-audit/`,
`docs/incidents/`, `docs/plans/`, `docs/proposals/`, `docs/research/`,
`docs/issues/`, `docs/superpowers/`, `docs/migrations/`, `skills/migrations/`
and the wave 1 porting kit (`docs/architecture/wave-1-*`); `CHANGELOG.md` is
not scanned. Each hit prints `FAIL: <file:line> retired phrase "<match>"`,
then `Why:`, `Fix:` with the current instruction, and `See:`. The fix is to
rewrite the sentence to the current workflow, never to exempt the file. To
retire another phrase, add a row to `RETIRED`. Fixtures:
`test/fixtures/guards/check-retired-phrases.sh/` (one `bad-<location>` tree per
scanned location); every pattern and the exemptions are driven in
`test/scripts/check-retired-phrases.test.ts`.

#### Bash 3.2 parse guard

macOS ships GNU bash 3.2.57 as `/bin/bash`, and its parser rejects shapes
bash 5 accepts. The one that broke every Mac (#5810) is a heredoc inside
`$(...)` whose body holds an odd quote. `scripts/check-bash32.sh`
(`bun run check:bash32`) runs the real 3.2 parser, `bash -n`, over every
tracked `*.sh` except the guard fixtures under `test/fixtures/guards/`. It
uses the first parser available: `GBRAIN_BASH32=<path>` (a bash 3.x binary),
`/bin/bash` when it is bash 3.x (stock macOS), or the digest-pinned `bash:3.2`
Docker image (`GBRAIN_BASH32=docker` forces the image). With none it prints
one skip line and exits 0; `GBRAIN_TEST_BASH32_REQUIRE=1` makes that exit 2. Each
failure prints `FAIL: <file:line>`, `Why:` (macOS `/bin/bash` is 3.2), `Fix:`
(read heredoc text with `IFS= read -r -d '' VAR <<'EOF' || true`) and `See:`.
To reproduce one file by hand:
`docker run --rm -v "$PWD":/w -w /w bash:3.2 bash -n <file>`.

The guard checks parsing only. It is not in `bun run verify`, which must not
need Docker. The `test.yml` verify job runs it with `GBRAIN_TEST_BASH32_REQUIRE=1`
together with `test/scripts/check-bash32.test.ts`, whose real-parser cases
feed it the `test/fixtures/guards/check-bash32.sh/{bad,good}` trees. The
macOS 26 job runs it under `/bin/bash` and then runs `bun run verify` there,
which covers bash-4 runtime features the parser cannot see.

### Placeholder assertions

`scripts/check-test-placeholders.mjs` (`bun run check:test-placeholders`, in
`bun run verify`) parses every `test/**/*.test.ts` file outside
`test/fixtures/` with the TypeScript compiler API and fails on the no-op forms
`expect(true)` with no matcher, `expect(true).toBe(true)`,
`expect(true).toBeTruthy()` and `expect(1).toBe(1)`. Text inside strings and
template literals is ignored, and `expect(true).toBe(false)` fail sentinels
are allowed. Remaining sites (type-only contracts enforced by typecheck,
skip-arm markers, gates that fail by throwing) sit in a reasoned allowlist in
the script, keyed by file, test name and exact count; a site above its count
fails as new, and an entry whose file, test or count shrank fails as stale.
This is a hygiene check for one pattern, not a detector of low-value tests in
general; the authoring gate above owns that.

### Function-size ratchet

`scripts/check-function-size.ts` (`bun run check:function-size`, in
`bun run verify`, about 1.5 s) measures every function-like node in
`src/**/*.ts` except `*.generated.ts` and `.d.ts` with the TypeScript compiler
API: function declarations, methods, constructors, accessors, arrow functions
and function expressions, including object-literal and class-property forms.
A nested function is measured on its own, and its lines also count toward the
function that contains it. Code under `test/` is out of scope.

`scripts/function-size-baseline.tsv` holds one row per function over 300
lines: `path`, `name`, `lines`, `justification`. The name is a path built from
declarations, property names and call context, never line numbers, so edits
above a function do not touch its row: `PGLiteEngine.initSchema`,
`runServeHttp>app.post('/mcp')`, `MIGRATIONS[v131].handler`. `>` enters a
function, `.` a member, `=` a call whose result is bound, and a repeated key
gets a `#2` ordinal. The guard fails when a function over 300 lines has no
row, a baselined function grows, a baselined function drops to 300 lines or
fewer (remove the row), a row has more than 50 lines of stale slack (lower
it), a row names a function that no longer exists, or a row is malformed,
duplicated or out of order. A row raised above, or added since, the baseline
at the merge-base with `origin/master` needs an issue or TODO id (`#1234`,
`TODOS.md:12`, `TODO: <slug>`) in its justification; the summary prints every
raise.

Each failure prints `FAIL: <file:line> <what>` with the computed key, then one
`Why:` / `Fix:` / `See:` block. The fix is extraction: move a cohesive block
into a named helper or sibling module (phase, stage or handler-table pattern).
After a move-only commit changes a function's key, run
`bun scripts/check-function-size.ts --transfer`. It rewrites a missing row to
the one unbaselined over-limit function whose whitespace-normalized text is
identical to the old function at `HEAD` (`--from <ref>` for another base),
apart from an added leading `export` and module specifiers re-relativized to
the new directory (each resolved against its own file, so a retargeted
specifier still refuses), keeping lines and justification, and leaves
everything else for review.
Fixtures: `test/fixtures/guards/check-function-size.ts/{bad,good}`; every rule
is driven in `test/scripts/check-function-size.test.ts`.

### SyncRun state guard

`scripts/check-sync-run-state.ts` (`bun run check:sync-run-state`, in
`bun run verify`, well under a second) protects the refactor wave 1 `SyncRun`
rule (A17). `SyncRun` (`src/commands/sync/sync-run.ts`) holds the state one
incremental sync shares between closures that interleave across awaits: the
checkpoint flush and its cadence, the import workers, the stall watchdog and
the partial exit. Its mutable fields are the members of `interface SyncRun`
not marked `readonly`. Over `src/commands/sync/**/*.ts` the guard fails when a
mutable field is destructured from a SyncRun value (`const { bankedFiles } =
run`, or a `{ checkpointDead }: SyncRun` parameter) or copied into a local
(`const banked = run.bankedFiles`), because such a copy goes stale at the next
await. A SyncRun value is a binding named `run`, annotated `SyncRun`, or
initialized from `createSyncRun()`. Readonly fields (collection references,
fixed configuration) may be destructured. Fields tagged `@checkpoint` in their
JSDoc (the flush cadence, banked count, single-flight flag, dead flag, SIGTERM
deregistration and yield counter) have one owner: only functions in
`sync-run.ts` may assign them, so the flush, the SIGTERM hook and `partial()`
cannot disagree about checkpoint state. Each failure prints
`FAIL: <file:line>` plus `Why:` / `Fix:` / `See:`; the fix is to use
`run.<field>` at each read and write, and to change checkpoint state through a
`sync-run.ts` function. Fixtures:
`test/fixtures/guards/check-sync-run-state.ts/{good,bad,bad-alias,bad-param,bad-owner}`.

### Source reads in tests

`test/test-reads-source-smell.test.ts` finds test code that reads `src/` text:
`readFileSync`, `readFile` (including `fs.promises.readFile`) and `Bun.file`
calls whose arguments name a `src/` literal, a `'src'` path segment, or a
constant holding such a path. Each read site needs a tagged marker on its line
or within the three lines above:

```ts
// test-reads-source-ok[structural]: <why a source read is the right tool>
```

The category is one of `prompt-byte`, `trust-boundary`, `generated-artifact`,
`structural` or `raw-bytes`, and every marker must carry one. Files that
predate the rule are ratcheted by their exact count of unjustified read sites,
so a new untagged read in such a file fails and a count that drops must be
lowered. The ratchet counts read sites only: a new assertion over an existing
source binding is not detected and remains the authoring gate's job. Rerun with
`bun test test/test-reads-source-smell.test.ts`.

Structural guards over the files that refactor wave 1 decomposes read them
through `test/helpers/source-surface.ts` rather than `readFileSync`. A surface
is one façade plus the modules it is split into (`sync`, `cli`, `serve-http`,
`jobs`, `hybrid`, `autopilot`, `migrate`, `pglite-engine`, `postgres-engine`,
`doctor`). `surfaceSource(surface)` concatenates the surface with file
boundary markers and serves containment assertions (`toContain`,
`not.toContain`, single-line regexes). `surfaceFileSource(surface, path)`
returns one named file and serves positional assertions (`indexOf` ordering,
slice windows, `[\s\S]` spans, line math); a file outside the surface
throws. A lane that moves code adds the destination to the surface in the
same commit: a new directory is globbed automatically, while a module in an
existing directory or flat file set is listed explicitly so today's
assertions are not widened. `test/helpers/doctor-source.ts` is the doctor
instance of the same loaders.

### Registry-walking ratchets

Structural suites that walk a registry so the NEXT gap of a known class
cannot ship silently. All allowlists below are shrink-only unless noted.

- `test/operations-coverage-ledger.test.ts` — every op in
  `src/core/operations.ts` maps to a covering test file in a checked-in
  ledger; the `UNCOVERED` allowlist only shrinks. Shares one
  registry-enumeration helper (`test/helpers/ops-registry.ts`) with the
  jobs-ops token-redaction sweep so two walkers can't drift.
- `test/operations-source-isolation-matrix.test.ts` — every non-localOnly
  read op runs under a scoped remote ctx and a federated grant; nothing
  carrying the other source's identity may return. Deliberate brain-wide
  behavior requires an explicit `BRAIN_WIDE_READS` entry with a rationale
  string. Anti-vacuity is mandatory: each op's control call must SEE the
  cross-source marker before its scoped assertions count; an op that can't
  be driven is an explicit counted SKIP disposition, never a silent pass.
- `test/scripts/e2e-wiring.test.ts` — every `test/e2e/*.test.ts` runs in
  Selected E2E or is in `E2E_EXCLUSIONS` with a named owning job, and every
  exclusion names a real file.
- `test/engine-surface-coverage.test.ts` — two-way census of the
  `BrainEngine` interface against the PGLite prototype (new methods force a
  visible list edit) plus a runtime `UNCALLED` ratchet scanning the whole
  test corpus for references, so a never-called engine method can't ship.
- `scripts/check-orphan-modules.mjs` (verify battery, guard-manifest
  registered with bad/good fixtures) — transitive import walk from the
  cli/mcp/engine entrypoints; see [Orphan-module guard](#orphan-module-guard).

#### Orphan-module guard

`bun run check:orphan-modules` walks static, dynamic and `require` relative
imports from the runtime entrypoints (CLI, MCP server, plugin engines, admin,
package `exports`). Every `src/` module it cannot reach needs a disposition:

- Imported by nothing, not even tests: fails as `hard-orphan` unless it has a
  reasoned `ALLOWLIST` entry (shrink-only).
- Imported only by tests (or scripts): fails as `unpermitted-test-only`
  unless it is named in `PERMITTED_TEST_ONLY` with a `reason`. The set may
  grow only with a reason in a reviewer-visible edit; modules reached from
  `scripts/**` use reason `script-reachable`, which the guard verifies.
- A permitted entry whose module was deleted, wired into a runtime
  entrypoint, dropped by every test, or tagged `script-reachable` without a
  `scripts/**` importer fails as `stale-permitted-entry`. Remove or correct
  the record; never restore code to satisfy the list.

Each failure prints the rule, the module, the tests that import it, the
reason, the remedy, the rerun command and this anchor. Fixture mode
(`GBRAIN_GUARD_ROOT`) reads the permitted set from
`<root>/permitted-test-only.json`; `test/scripts/check-orphan-modules.test.ts`
proves every rule fails on a bad tree.

The takes-bootstrap graduation instrument (`evals/takes-bootstrap/`: 123-case
corpus, scorer, live harness + $0 replay) is CI-guarded keyless by
`test/eval-takes-bootstrap.test.ts` — the guard proves the instrument, not
the score; the autopilot tier flips only on a committed GRADUATED live run.

### Shell dispatch and Windows

All four of `test`, `verify`, `ci:local` and `test:e2e` hand off to shell scripts
under `scripts/`, so every `check:*` entry in `package.json` invokes its script as
`bash scripts/<name>.sh` instead of relying on the shebang — bun on Windows cannot
exec a `.sh` directly. Add a new shell-script check with that same prefix. The
`scripts/*.ts` entries run under bun and take no prefix.

The scripts must also be on disk with Unix line endings. A strict bash (WSL, Linux
CI, macOS) rejects CRLF and dies on the script's first meaningful line; the Cygwin
bash that ships with Git for Windows tolerates it, so a green local run is not by
itself evidence that a script is CRLF-clean.
The root `.gitattributes` pins `*.sh text eol=lf`, which overrides the
`core.autocrlf=true` default that Git for Windows installs. It pins `*.md` the
same way, because the frontmatter readers anchor on a `---` fence followed by a
Unix line ending and a CRLF checkout makes a document parse as having no
frontmatter, silently. Working copies cloned
before those pins need a one-time `git rm --cached -r . -q && git reset --hard` to
pick them up; see the Windows section of `CONTRIBUTING.md`.

Windows is substantially slower: each check pays full process-creation cost, and three
tree-walking checks (`check:privacy`, `check:test-names`, `check:test-isolation`)
plus `typecheck` can exceed the 120s per-check cap in `run-verify-parallel.sh`
there even though they pass on Linux and macOS.

### CI vs local: intentionally divergent file sets

- **CI matrix** (`.github/workflows/test.yml`) runs `scripts/test-shard.sh` across 8 shards partitioned by weight-aware LPT bin-packing (`scripts/sharding.ts`; unweighted files get the p75 weight) and includes `*.slow.test.ts` files without a dedicated job (`eval-longmemeval-e2e.slow.test.ts` runs inside the shards; entity-resolve-perf, entity-card-perf, export-scale and brainbench-e2e have dedicated jobs, and the `reconcile-crash-*.slow.test.ts` files runs only in persistence-validation) plus keyless-allowlisted `evals/**/*.test.ts` (`test/scripts/evals-collection.test.ts`). Shards keep planned file order (`test-shard.sh --dry-run-list <i> 8`). Every Bun job activates the PGLite schema snapshot (built in-runner, cached across jobs with the runner's hash check authoritative). Serial files run across four `serial-tests` workers via `bun run test:serial`; `verify` and the BrainBench memory-conformance gate (`scripts/ci-brainbench-gate.sh`, compared against `evals/brainbench/baselines/main.json`) have their own jobs, all aggregated by `test-status`. `e2e.yml` aggregates through `e2e-status`, with jsonb-parity gating Tier 2's token spend; scheduled runs also require the full-corpus lanes. Both aggregates reject failures, cancellations and unexpected skips, and successful test results are never reused. CI is the ground truth for "did everything pass."
- **Local fast loop** (`scripts/run-unit-shard.sh` via the parallel wrapper) uses the same weighted partitioner as CI and EXCLUDES `*.slow.test.ts` AND `*.serial.test.ts`. Each shard runs its complete ordered selection with a fresh Bun process per file, without adding workers. Later groups still run after failures; missing summaries or file-completion evidence fail the shard. Local trades coverage for inner-loop speed; CI catches what local skips.

This divergence is intentional; the two scripts solve different problems.
`test/scripts/run-unit-shard.test.ts` pins what the local loop includes, and
that no unit file spawning the CLI through `test/helpers/cli-spawn.ts` pins a
per-test timeout below the bunfig default (an explicit `test(name, fn, N)`
overrides `--timeout`, so `GBRAIN_TEST_TIMEOUT_MULTIPLIER` never reaches it).
`test/scripts/run-unit-parallel.test.ts` pins memory-adaptive concurrency, the
rescue pass and operator-interrupt teardown (Ctrl-C kills every shard
descendant).

### Coverage lanes and gates

Line coverage is opt-in via `COVERAGE_DIR`: when set, the shell lanes
(`scripts/test-shard.sh`, `scripts/run-serial-tests.sh`, `scripts/run-e2e.sh`)
pass `--coverage --coverage-reporter=lcov` to Bun; when unset, the exec line is
byte-identical to a non-coverage run. Every Bun process gets its own coverage
directory (`$COVERAGE_DIR/shard`, `serial-$idx`, `e2e-$idx`) because a reused
directory silently overwrites `lcov.info`; the shard runner pins xargs to one
batch so an argv overflow fails loudly. Each coverage invocation atomically
creates its own `COVERAGE_DIR` and refuses an existing one, so a rerun needs a
new path and cannot inherit or delete another run's output. A green lane writes
`$COVERAGE_DIR/lane-manifest.json` (`{lane, sha, lcovCount, complete}`); a red
run writes none, which merging treats as an incomplete lane. E2E lanes
(`e2e-1` to `e2e-4`, or `e2e` unsharded) also write `executed-files.txt`, and
`run-e2e.sh` counts a file complete only with a fresh parent-owned JUnit report
whose testcase counts match the console totals. Skip-only files emit no LCOV,
so execution-file counts and LCOV counts are different measures. `run-e2e.sh`
normalizes `COVERAGE_DIR` to an absolute path before moving `HOME`, and
`E2E_FILE_TIMEOUT_SECS` caps each file (default 180s; 300s in the nightly
coverage lane). Both names avoid the `GBRAIN_` prefix so the env scrub keeps
them.

**Two corpora.** `prCorpus` is the 14 coverage-collecting lanes in
`test.yml` (8 unit shards, 4 serial partitions, `slow-entity-resolve-perf` and
`slow-brainbench-e2e`), identical on every PR; the gates run against it.
`fullCorpus` is the nightly (or manual `full_corpus=true`) set in `e2e.yml`:
`coverage-full-{unit,serial,slow,e2e}` plus `coverage-full-report`, every lane
re-run with coverage inside that workflow including full E2E discovery across
four isolated Postgres workers, kept as the `coverage-full-merged` trend
artifact. A manual full run has its own concurrency group; dispatch `e2e.yml`
with `full_corpus=true` to measure a branch before the next schedule.
Full-profile `e2e-status` validates the four same-commit receipts against the
exact expected partitions with `scripts/verify-nightly-e2e.ts`: missing
artifacts, duplicates, wrong commits, omitted or repeated files, failures and
cancellations cannot report complete execution, and the report refuses to
publish without that evidence. Receipts prove file execution, not every
optional assertion within a file.

Shard cancellation versus failure in `coverage-full-report`: [full-corpus report states](operations/verify-and-nightly-e2e.md#full-corpus-report-states).

**Merge** (`scripts/merge-lcov.ts`) sums DA hits per file and line across the
input directories, normalizes paths, and emits a merged lcov plus a summary
JSON (src-only totals, per-directory and per-file percentages, the `lineHits`
map the diff gate reads, and the never-loaded src file list).
`--manifest-expect` pins the lane set and `--sha` the commit. A missing or
incomplete manifest, unparseable lcov, duplicate identity or a `shard` lane
with `lcovCount != 1` marks the summary `degraded: true`; the merge still exits
0 and both gates print `WOULD PASS`/`WOULD FAIL` instead of enforcing.

**Diff gate** (`scripts/coverage-diff-gate.ts`) requires at least 80% of the
added or changed executable lines of `git diff origin/master...HEAD` in
`src/**.ts` (minus tests, generated files and `.d.ts`) to be covered, and no
changed gate-scoped file to be absent from the coverage data. Doc-only diffs
pass. Escape hatches: a commit body with `[coverage-exempt: reason]` (loud
warning), and `scripts/coverage-gate-exemptions.txt`, read from
`origin/master` so a PR cannot self-exempt, shrink-only. Exit 0 is pass or
report-only, 1 a failure while `COVERAGE_GATE_ENFORCE=1`, 2 an infrastructure
error.

**Baseline gate** (`scripts/coverage-baseline-gate.ts`) reads
`scripts/coverage-baseline.json` from `origin/master` and compares like for
like by corpus: a global drop over 0.5pp, a per-directory drop over 1.0pp or
more never-loaded files fails. A `null` corpus section is an ungated first
landing, and `provisional: true` keeps the gate report-only; the committed
baseline is provisional with both sections unseeded.
`scripts/update-coverage-baseline.ts --summary <json> --corpus <c> [--promote]`
writes it, and `--promote` flips `provisional: false` at graduation.

**CI wiring.** The 14 PR lanes upload `coverage-*` artifacts; the advisory
`coverage-report` job merges them, renders `scripts/render-coverage-summary.ts`
(with behavioral-vs-structural counts from `scripts/structural-suites.tsv`) to
the step summary, and runs both gates with `COVERAGE_GATE_ENFORCE: '0'`. It is
not in `test-status` needs until the gate graduates. Test results are never
cached. `e2e-status` requires the four `coverage-full-*` execution lanes on
scheduled runs; only the percentages stay advisory.

**Bun caveats.** Bun emits line records only, so function coverage is
informational. There is no subprocess coverage: code reached only through
spawned CLI processes undercounts, and `src/cli.ts` carries a permanent
`[subprocess-undercount]` exemption. A src file no test imports has no lcov
record; the summary lists those as a count and a sorted list, never a
percentage.

**Local smoke** (one shard of ten; this checks the plumbing, not the number):

```bash
COVERAGE_DIR=$PWD/.coverage bash scripts/test-shard.sh 1 10 \
  && bun scripts/merge-lcov.ts --out-lcov .coverage/merged.lcov --out-json .coverage/summary.json .coverage \
  && bun scripts/render-coverage-summary.ts --summary .coverage/summary.json --structural scripts/structural-suites.tsv
```

### Failure-first logging

When `bun run test` finds any failure, the wrapper:

1. Writes failure blocks (each prefixed with `--- shard N: <test name> ---`) to `.context/test-failures.log` (workspace-local, gitignored). On systems without a writable `.context/`, falls back to `/tmp/gbrain-test-failures.log`.
2. Prints a loud stderr banner with the absolute log path, plus the last 30 lines of the failure log inlined. Banner survives `| head` / `| tail` / agent-side log truncation.
3. Writes a one-line-per-shard summary to `.context/test-summary.txt` (`shard N/M: pass=X fail=Y skip=Z rc=W`).
4. Exits non-zero. Empty failure log + non-zero exit = infrastructure problem (wedged shard, killed child); the banner says so.

If a shard hits the per-shard `GBRAIN_TEST_SHARD_TIMEOUT` cap (default 3000s — sized so the heaviest count-balanced shard finishes under 4-way contention; `GBRAIN_TEST_SHARD_KILL_AFTER` sets the grace after TERM before KILL, default 30s), the wrapper classifies the kill one of two ways:

- **EXIT-HANG → warn-pass.** If the shard's log had been silent for ≥300s at kill time AND shows zero `(fail)` markers, the shard finished all its work, leaked a handle, and never exited (a known PGLite-adjacent handle leak — see TODOS.md "unit-shard exit hang"). The wrapper prints a `⚠️ shard N/M: EXIT-HANG ... Treating as pass-with-warning` banner, writes `EXIT-HANG (idle Ns, 0 fails) ... warn-pass` to the summary, and does NOT fail the run. Its pass counts are undercounted (bun never printed its final summary). Bun's per-test `--timeout` turns a genuinely hung TEST into a printed `(fail)` — new output — so this classification cannot mask a hung test; the residual maskable case is a file-level import hang in the very last file, which the banner keeps visible.
- **WEDGED → hard failure.** Anything else (failures present, or the log was still growing) writes `--- shard N: WEDGED after ${SHARD_TIMEOUT}s ---` to the failure log with the last 50 lines of the shard log, marks the run failed, and proceeds with other shards' results.

Triage rule: a `warn-pass` EXIT-HANG line in `.context/test-summary.txt` is NOT a test failure — don't burn time bisecting it; a `WEDGED` line is.

### File taxonomy

- `*.test.ts`: the parallel unit loop.
- `*.slow.test.ts`: `bun run test:slow` only (intentional cold-path or long workloads that would dominate the fast loop). In CI they run in named slow jobs or inside the unit shards.
- `*.serial.test.ts`: `bun run test:serial` after the parallel pass, one Bun process per file (`--max-concurrency=1` in a shared process still leaks `mock.module` through the module registry), with those processes pooled. Each file is listed with its class and reason in `scripts/serial-files.tsv` (see [When to quarantine](#when-to-quarantine-instead-of-fix)); machine-global files (launchd/cron) run on the sequential `EXCLUSIVE_FILES` lane, at most three. Do not put parallelism back on a serial file without fixing the contention root cause.
- `test/e2e/*.test.ts`: real-Postgres E2E, skipped when `DATABASE_URL` is unset. `test/phantom-redirect-engine-parity.test.ts` also rides this lane (its PGLite arm lives in `test/`; its Postgres arm needs a `DATABASE_URL` lane). `run-e2e.sh` wraps each file in a hard outer timeout (default 180s, `GBRAIN_E2E_FILE_TIMEOUT=<seconds>` overrides) because a blocking PGLite WASM call can outlive Bun's timer-based `--timeout`; LLM-bound Tier 2 files get four times the cap.
- `tests/heavy/*.sh`: ops-shape shell scripts (pg_upgrade matrix, RSS budget, read latency under sync, sync lock regression) costing minutes; `bun run test:heavy` or the nightly `heavy-tests.yml`. Files prefixed `_` are helpers the runner skips. `tests/heavy/README.md` says when a script belongs here instead of `*.slow.test.ts`.
- `test/fuzz/*.test.ts`: property-based fuzzing in the default loop (about 3s). Targets in `pure-validators.test.ts` must pass `scripts/check-fuzz-purity.sh` (in `verify`), which bundles each target and rejects `node:fs`, `node:child_process` and engine imports; others live in `mixed-validators.test.ts` or `filesystem-validators.test.ts`.

The taxonomy above is LANE-based (where a test runs). A second, orthogonal axis is INTENT:

- **Behavioral** tests execute product code and assert on behavior — the default.
- **Structural** (source-shape) suites read repo source/doc TEXT and assert on its shape (wiring guards, drift pins, `doctorSource()` consumers). They are real invariants but execute no product paths, so they inflate the headline test count without adding line coverage. The committed inventory is `scripts/structural-suites.tsv`, generated by `scripts/classify-tests.ts` (suite-level, content-based detectors: repo-anchored `readFileSync`/`Bun.file` readers, grep-style exec scanners, the doctor-source helpers) and freshness-checked in `bun run verify` (`check:structural-manifest` — regenerate with `bun scripts/classify-tests.ts` when suites change shape). The inventory is approximate by design; fix misclassifications in the classifier's detector list, never by hand-editing the TSV. CI's coverage report renders behavioral vs structural counts side by side.

Guards that pin doctor source text read it through `test/helpers/doctor-source.ts` (`doctorSource()` = the façade + every `src/commands/doctor/**` module, for containment assertions; `doctorFileSource(rel)` = one named file, for positional/ordering assertions) so peeling doctor.ts into modules can't silently move a pinned string out of a guard's sight.

### TTY and interactive-CLI testing

Four escalating tools; reach for the cheapest one that answers the question:

| Question | Tool | Example |
|---|---|---|
| Does the TTY/non-TTY branch logic pick right? | Inject `isTTY` into the pure function — no subprocess | `test/init-provider-picker.test.ts`, `test/jobs-watch-mode.test.ts` |
| Does the real CLI behave right when stdin is NOT a terminal? | Spawn the CLI with piped/ignored stdio | `test/cli-stdin-hang.test.ts` (fast loop); `test/init-fresh-pglite.slow.test.ts` (slow lane) |
| Does the real CLI render menus and read typed input under a REAL terminal? | `launchTty` from `test/helpers/tty-harness.ts` | `test/init-picker-pty.test.ts` |
| How does the install FEEL (stalls, copy, silence windows)? | `scripts/dx-explore.ts` — instrument, not a test; nothing asserts | transcripts under `.context/dx-runs/` (see `docs/guides/bootstrap.md`) |

Real-PTY test rules: keep the file in the unit or serial lane, which need no
database (make it serial only when it touches process-wide state);
assert NON-default picker values (bare Enter and each prompt's 60s
`readLineSafe` timeout both resolve to the default, so a defaults-asserting
test passes with dead input); always `await session.close()` in a `finally`
(only `close()` clears the harness wall timer); and point `HOME` plus
`GBRAIN_HOME` at a temp root with pass-through auth keys stripped via
`dropEnv` so picker state is machine-independent.

### Skills-manifest freshness guard

`skills/skills.lock.json` is a committed sha256 inventory of every bundled file under
`skills/` (tamper evidence, not signatures — see `src/core/skills-integrity.ts`).
Any change under `skills/` must regenerate it: `bun run scripts/generate-skills-manifest.ts`.
`scripts/check-skills-manifest-fresh.sh` (`bun run check:skills-manifest`, wired into
`bun run verify`) regenerates to a tmp file and diffs, failing CI on drift; at runtime
`gbrain doctor` reports the same drift as a warn-only `skills_manifest_integrity` check.

### Docs CLI truth check

`test/docs-cli-commands.test.ts` checks every `gbrain <verb>` in code fences and
inline code across README, docs and skills against the registered verbs. In
`docs/guides/`, `docs/migrations/` and `skills/` it also runs each invocation's
flags through the CLI's own validator, via `test/helpers/cli-command-surface.ts`.
When a hit is stale, fix the doc. When the example documents an older release,
put `<!-- gbrain-cli: historical -->` on the line above its code fence, or on the
line with the inline code. The test's `ALLOWLIST` is a last resort: it only
shrinks, every entry needs a reason, and stale entries fail.

`test/docs-navigation.test.ts` checks local links and fragments in the primary
install/memory guides and all `docs/architecture/key-files/` references, requires
every subsystem to be linked from `KEY_FILES.md`, and guards against blanket
graph-write and preference-routing claims. The fixture suite
`test/scripts/check-key-files-current-state.test.ts` covers history markers,
cross-subsystem duplicate entries, and byte caps for the entry docs and references.

### Test-isolation lint and helpers

**The canonical home of the test-isolation rules** (other docs link here). `scripts/check-test-isolation.sh` (in `bun run verify`) enforces them on non-serial unit files; `*.serial.test.ts` and `test/e2e/*` are skipped:

| Rule | What it bans | Fix |
|---|---|---|
| **R1** | `process.env.X = ...`, bracket assignment, `delete`, `Object.assign(process.env, ...)`, `Reflect.set(process.env, ...)` | `withEnv()` (`test/helpers/with-env.ts`) or `*.serial.test.ts` |
| **R2** | `mock.module(...)` anywhere in the file | `*.serial.test.ts` (no DI on production code for testability) |
| **R3** | `new PGLiteEngine(` outside ~50 lines after a `beforeAll(` line | Use the canonical block (below) inside `beforeAll(` |
| **R4** | `new PGLiteEngine(` without `engine.disconnect(` in an `afterAll(` block | Add `afterAll(() => engine.disconnect())` |
| **R5** | `configureGateway(` with no `resetGateway(` (comments ignored): the global gateway leaks to later files | `afterAll(() => resetGateway())`; a child-script-only call takes `isolation-lint: R5-subprocess-only` |

Files that violated these rules at the lint baseline are listed in `scripts/check-test-isolation.allowlist`. **The allow-list MUST shrink over time**: never add entries.

#### Opt-in naming rule

`test/helpers/operator-env-preload.ts` deletes every `GBRAIN_*` variable
outside the keep-list in `test/helpers/operator-env-policy.ts` before any test
file loads, so an opt-in under any other name is a silent no-op. Name test
opt-ins `GBRAIN_TEST_<AREA>_<WHAT>`, and paid ones `GBRAIN_TEST_LIVE_<WHAT>`.
The `GBRAIN_REAL_*`, `GBRAIN_E2E_*` and `GBRAIN_CI_*` prefixes and the
`GBRAIN_TRIAGE_CALIBRATION_LIVE` and `GBRAIN_LIVE_TYPESAFE` names are kept for
compatibility. Renamed opt-ins are listed in the policy's `RENAMED` map
(for example `GBRAIN_BASH32_REQUIRE` is `GBRAIN_TEST_BASH32_REQUIRE` and
`GBRAIN_SKIP_SUBPROCESS_TESTS` is `GBRAIN_TEST_SKIP_SUBPROCESS`); setting an
old name stops the run with the rename command. `bun run check:test-env-opt-ins`
(in `verify`) fails on a test that gates execution on a stripped name.

#### Canonical PGLite block (R3 + R4 compliant)

Every test file that needs a PGLite engine should use this exact pattern:

```ts
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
});
```

Why this exact shape: `beforeAll` creates a single engine per file (PGLite WASM cold-start + initSchema is ~20s); `beforeEach` clears user data via `resetPgliteState`; `afterAll` disconnects so the engine doesn't leak across file boundaries within a shard process. Ordinary resets atomically delete rows with cleanup-only trigger suppression and restart owned sequences, retaining table/index storage. The helper restores trigger behavior before reseeding and falls back to `TRUNCATE CASCADE` for schemas whose triggers, rules, inheritance, external foreign keys or privileges require its original semantics. Schema/generation infrastructure survives, and each reset rotates the logical brain identity.

Every full reset measures aggregate target-table storage, including indexes and
TOAST, with `pg_total_relation_size`. Above 8 MiB it uses the same atomic TRUNCATE
path to reclaim storage; no reset counter or stale size estimate is retained.
The helper regression suite checks repeated TOAST-heavy resets, cleanup and
sequence parity, restored triggers and foreign-key enforcement.

#### `withEnv` pattern (R1 fix)

```ts
import { withEnv } from './helpers/with-env.ts';

test('reads OPENAI_API_KEY', async () => {
  await withEnv({ OPENAI_API_KEY: 'sk-test' }, async () => {
    expect(loadConfig().openai_key).toBe('sk-test');
  });
});

// Delete a var (override is undefined):
await withEnv({ GBRAIN_HOME: undefined }, fn);

// Multiple keys:
await withEnv({ A: '1', B: '2', C: undefined }, fn);
```

`withEnv` saves the prior value of every key it touches and restores via try/finally — including when the callback throws. An absent `TZ` is restored as the zone that was in effect, because Bun keeps the last explicitly set zone when `TZ` is deleted; a `TZ` override therefore never leaks into later files in the same process. **It is cross-test safe but NOT intra-file concurrent-safe.** `process.env` is process-global; two `test.concurrent()` calls in the same file both touching the same key will race. Files using `withEnv` stay outside the `test.concurrent()` codemod's eligibility filter.

#### Speed + environment helpers (`test/helpers/`)

Reach for these before hand-rolling; the five speed helpers each have their
own unit test, and the two environment probes are exercised through their
consumer suites:

- `cli-spawn.ts` — `runCli(argv, opts)` (async, hermetic env, timeout-killed),
  `runCliBatch(argvs, {width})` (bounded pool, DEFAULT WIDTH 2 — the cap is
  per-invocation and 4 shards × width multiplies CLI children machine-wide;
  each child can boot a ~1.5GB PGLite), `runCliMemo` (argv-keyed memo for
  read-only calls like `--help`; `clearCliMemo()` drops the memo when a test
  mutates what a memoized call would observe). Replaces the per-file spawn wrappers; a file
  of N independent sequential spawns becomes one width-2 batch in `beforeAll`.
- `wait-for.ts` — `waitFor(predicate, {timeoutMs, intervalMs})` /
  `waitForValue`. Replaces fixed `setTimeout` sleeps: polls resolve as soon as
  the condition holds, and generous deadlines make slow-CI runs LESS flaky
  than a tuned sleep, not more.
- `with-snapshot.ts` — `withColdPglite(fn)`: per-TEST scoped
  `GBRAIN_PGLITE_SNAPSHOT` opt-out (save/delete/restore);
  `withSnapshotValue(value, fn)` is the general form (pin any snapshot path
  for fn's scope; `undefined` = deleted). Use instead of a
  file-level `delete process.env.GBRAIN_PGLITE_SNAPSHOT`, which forces every
  engine in the file to cold-boot. Caution: a snapshot-restored engine does
  not replay migrations on a later `initSchema()` after a version rewind —
  rewind-arc tests need the cold path (see `test/bootstrap.test.ts`).
- `reset-pglite.ts#resetPgliteStateNarrow(engine, tables)` — explicit-table
  truncate for hot loops (the full reset clears the whole catalog). The
  table list is REQUIRED — a default would silently under-truncate.
- `wait-for.ts#testWaitMs(ms)` — scales a test deadline by
  `GBRAIN_TEST_WAIT_MULTIPLIER` (1 to 4, default 1; any other value fails the
  test loudly), capped at 50s so a slow condition fails as a labeled `waitFor`
  error, never an anonymous Bun timeout. `waitFor` applies it to its own
  deadline. `scripts/lib/test-env.sh` sets the multiplier to 2 whenever
  `COVERAGE_DIR` is set, and `run-e2e.sh` keeps it through its environment
  scrub. It is separate from `GBRAIN_TEST_TIMEOUT_MULTIPLIER`, which scales
  Bun's `--timeout` in `run-unit-shard.sh`.
- `brain-template.ts` — disk-backed PGLite brains cloned from one initialized
  template per process and embedding shape (about 1s instead of about 3s of
  migration replay). The template is captured right after `initSchema` with no
  source, writer or physical-root reservation, nothing outside the data
  directory is copied, and each clone regenerates its brain identity. Use it
  for fixtures that need any initialized disk brain; tests of `gbrain init` or
  migrations keep a real `initSchema` on an empty directory.
- `git-fixture.ts` — `makeGitFixture(dir)`: build-once git repo +
  `reset()`/`commitAll()` between tests, replacing per-test `git init` chains.
- `fs-perms.ts` — `permsEnforced()` / `crontabAvailable()` probes: some hosts
  (FUSE/overlay sandboxes, root) don't enforce permission bits or lack a
  crontab; tests asserting "this write MUST fail" / "cron registered" use
  `test.skipIf(!probe())` so they skip visibly there and still run in CI.
- `git-stderr-probe.ts` — `gitStderrLeads()`: skips raw-git-stderr-slice
  assertions behind ambient git PATH shims that print their own diagnostics
  first (e.g. Conductor's auth-broker wrapper).

#### When to quarantine instead of fix

Rename to `*.serial.test.ts` when:
- The file uses `mock.module(...)` (R2 — there's no clean fix without changing production code).
- The file is genuinely env-coupled (e.g. `gbrain-home-isolation.test.ts`, `claw-test-cli.test.ts`) — module-load env readers + ESM caching defeat dynamic-import-after-env tricks.
- The file touches other process-wide state (`process.exitCode`, `console`, `process.argv`, signal handlers, bound ports).
- The file's tests intentionally share state across `it()` boundaries.

`scripts/serial-files.tsv` is the serial manifest: every `*.serial.test.ts`
outside `test/e2e/` with its class (`R1` env mutation, `R2` `mock.module`,
`global-state`, or `exclusive` for the `EXCLUSIVE_FILES` lane in
`scripts/run-serial-tests.sh`) and a reason taken from what the file actually
touches. `test/scripts/serial-files.test.ts` requires the manifest to match the
tree exactly and rejects boilerplate reasons ("flaky", "needs serial"). Before
adding a row, lint the file as if it were parallel:

```bash
bash scripts/check-test-isolation.sh --as-parallel test/<name>.serial.test.ts
```

When that passes and the file touches no process-wide state, rename it to
`*.test.ts` instead; it then runs in the parallel shards. The quarantine is
debt: prefer fixing the contention root cause when one exists.

### Test preloads

`bunfig.toml`'s `[test]` preloads apply to runs started at the repo root.

**GBRAIN_HOME isolation preload.** `test/helpers/gbrain-home-preload.ts` points
`GBRAIN_HOME` at a per-run scratch directory unless it is already set, so unit
tests never read or clobber the operator's `~/.gbrain`. `GBRAIN_HOME` is a
parent directory and `.gbrain` is appended (`config.ts:configDir()`).
Subprocess-spawning tests set both `HOME` and `GBRAIN_HOME` in the child env
(`HOME` alone loses to the inherited preload value, and in-process `HOME`
mutation loses to Bun's cached `os.homedir()`). The unit and slow wrappers
strip an ambient `GBRAIN_HOME` at their boundary; the E2E wrapper sets its own.
`GBRAIN_DEBUG_PRELOAD=1` prints the allocated home. Installer fixtures never
delete `GBRAIN_HOME` to test a fallback against the operator's home: they spawn
a disposable child with `HOME` set before Bun starts.
`real-home-guard-preload.ts` compares metadata of the real-home autopilot
wrapper, env file, start script, launchd plist and systemd unit around tests
(detection, not interception; it never reads env-file contents);
`GBRAIN_TEST_ALLOW_REAL_HOME_WRITES=1` permits a deliberate one-shot installer
test inside an isolated child home, with a warning.
`test/real-home-guard-preload.test.ts` checks fake-live sentinels stay untouched.

**Provider-key strip preload.** `test/helpers/provider-keys-preload.ts` strips
the ambient provider credentials listed in `test/helpers/provider-env.ts`
(checked against every recipe credential, endpoint and alias) and defaults
`GBRAIN_MODEL_DISCOVERY=off`, so model routing resolves as in keyless CI and no
test makes a discovery call. Tests that want keys inject them explicitly
(`configureGateway({env})`, `withEnv`, serial-file `process.env`). `run-e2e.sh`
opts back in with `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1`, because E2E is where real
keys are deliberate. The routing-only `qm-provisioning`,
`serve-http-surface-ceiling`, `serve-stdio-roundtrip` and `thin-client`
fixtures still strip provider state in every child, point `HOME` and
`GBRAIN_HOME` at their temporary brain and pass `--no-env-file`, so they never
spend provider tokens even in a keyed lane.

**Database-URL run guard.** `bun test` refuses to start while `DATABASE_URL` or
`GBRAIN_DATABASE_URL` is ambient (`test/helpers/database-url-guard-preload.ts`),
because some tests run destructive SQL against whatever those URLs name; it
fails with instructions instead of unsetting, which would turn gated E2E tests
into green skips. The E2E wrappers opt in with
`GBRAIN_TEST_ALLOW_DATABASE_URL=1`; the unit and slow wrappers strip both
variables, so `bun run test:full` works with `DATABASE_URL` exported. After the
opt-in, every test that runs destructive SQL on the ambient URL calls
`assertSafeE2eDatabaseUrl()` (`test/helpers/db-guard.ts`: the database name
must contain a `test` segment, or be named in `GBRAIN_E2E_ALLOW_DB`) or carries
an inline floor the coverage scan recognizes (`test/e2e/schema-drift.test.ts`
also accepts `*_e2e`); `test/db-guard-coverage.test.ts` fails on an unguarded
file. Local CI sets `GBRAIN_TEST_DB=1` for its Docker databases, relaxing only
the localhost requirement. The heavy lane gets the same floor through
`tests/heavy/_db_floor.sh`, which checks both variables and strips query
strings before reading the database name.

### API keys and running ALL tests

ALWAYS source the user's shell profile before running tests:

```bash
source ~/.zshrc 2>/dev/null || true
```

This loads `OPENAI_API_KEY` and `ANTHROPIC_API_KEY`. Without these, Tier 2 tests
skip silently. Do NOT skip Tier 2 tests just because they require API keys — load
the keys and run them.

When asked to "run all E2E tests" or "run tests", that means ALL tiers:
- Tier 1: `bun run test:e2e` (mechanical, sync, upgrade — no API keys needed)
- Tier 2: `test/e2e/skills.test.ts` (requires OpenAI + Anthropic + openclaw CLI)
- Always spin up the test DB, source zshrc, run everything, tear down.

Real-agent door suites (`test/e2e/install-real-*.serial.test.ts`) run in
`heavy-tests.yml`. The newest door agent runs nightly; a door drops to the
`real-agent-e2e` label after two stable monthly cycles with unchanged pins.

Key-gated live files that no CI job has keys for are left out of the
`scripts/run-e2e.sh` default glob, so the nightly full corpus and the local
gates stop counting their skips as discovered coverage. Naming a file on the
command line still runs it (the runner keeps provider keys):

| File | Required key | Command |
|---|---|---|
| `test/e2e/openrouter-anthropic-subagent-replay.live.test.ts` | `OPENROUTER_API_KEY` | `OPENROUTER_API_KEY=... bash scripts/run-e2e.sh test/e2e/openrouter-anthropic-subagent-replay.live.test.ts` |
| `test/e2e/openrouter-deepseek-subagent-replay.live.test.ts` | `OPENROUTER_API_KEY` | `OPENROUTER_API_KEY=... bash scripts/run-e2e.sh test/e2e/openrouter-deepseek-subagent-replay.live.test.ts` |
| `test/e2e/voyage-rerank-live.test.ts` | `VOYAGE_API_KEY` | `VOYAGE_API_KEY=... bash scripts/run-e2e.sh test/e2e/voyage-rerank-live.test.ts` |
| `test/e2e/voyage-multimodal.test.ts` | `VOYAGE_API_KEY` | `VOYAGE_API_KEY=... bash scripts/run-e2e.sh test/e2e/voyage-multimodal.test.ts` |
| `test/live/decide-typesafe.live.test.ts` | `TYPESAFE_API_KEY` (or `JEV_TYPESAFE_API_KEY`) + `GBRAIN_LIVE_TYPESAFE=1` | `GBRAIN_TEST_KEEP_PROVIDER_KEYS=1 GBRAIN_LIVE_TYPESAFE=1 TYPESAFE_API_KEY=... bun test test/live/decide-typesafe.live.test.ts` |


### E2E test DB lifecycle (ALWAYS follow this)

The sequential E2E runner requires Python 3 for standard-library XML validation
of Bun's native JUnit reports. CI and the local Docker runner provide it; direct
host runs must have `python3` on `PATH` before launching tests.

`setupDB()` clears rows while preserving physical schema. Fixtures that seed
fixed legacy-width text vectors use `setupLegacyEmbeddingDB()` instead: it
establishes the canonical test shape after clearing the database, including
facts and takes, so a preceding CLI-init test cannot change their assumptions.
Custom-dimension and migration tests continue using ordinary `setupDB()`.
For fixtures testing schema/index creation or source-scoped cleanup, preserve
that lifecycle and derive incidental text-vector widths from the database.

You are responsible for spinning up and tearing down the test Postgres container.
Do not leave containers running after tests. Run E2E tests without asking
permission whenever a relevant suite exists: the lifecycle takes seconds, and
skipping with "DATABASE_URL unset" is a silent regression, not caution.

1. **Check for `.env.testing`** — if missing, copy from sibling worktree.
   Read it to get the DATABASE_URL (it has the port number).
2. **Check if the port is free:**
   `docker ps --filter "publish=PORT"` — if another container is on that port,
   pick a different port (try 5435, 5436, 5437) and start on that one instead.
3. **Start the test DB:**
   ```bash
   docker run -d --name gbrain-test-pg \
     -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres \
     -e POSTGRES_DB=gbrain_test \
     -p PORT:5432 pgvector/pgvector:pg16
   ```
   Wait for ready: `docker exec gbrain-test-pg pg_isready -U postgres`
4. **Bootstrap the schema** (required — fresh containers have no `oauth_clients`,
   `mcp_request_log`, `pages` etc.; tests like `serve-http-oauth.test.ts` will fail
   with `relation "oauth_clients" does not exist` if you skip this):
   ```bash
   DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test \
     bun run src/cli.ts doctor --json > /dev/null 2>&1
   ```
   `gbrain doctor` triggers `initSchema()` on first connect, which is the canonical
   way to bring a fresh DB to head. `apply-migrations --yes` alone does NOT seed
   the base schema — it runs ALTER-style migrations on top of `initSchema`. Tests
   that bypass the engine (raw `execSync`-spawned `auth register-client`) hit the
   schema directly and need this step to have run first.
5. **Run E2E tests:**
   `DATABASE_URL=postgresql://postgres:postgres@localhost:PORT/gbrain_test bun run test:e2e`
6. **Tear down immediately after tests finish (pass or fail):**
   `docker stop gbrain-test-pg && docker rm gbrain-test-pg`

Never leave `gbrain-test-pg` running. If you find a stale one from a previous run,
stop and remove it before starting a new one. If `.env.testing` is missing, copy
it from a sibling worktree: `find ../ -maxdepth 2 -name .env.testing -print -quit`.

## Authorization regression gates

`test/data-frontmatter.test.ts` and `test/frontmatter-security.test.ts` pin inert
frontmatter parsing, opaque serialization, scalar compatibility, and import
errors. `test/authorization-boundaries.test.ts` covers scalar source grants,
foreign/private facts, and delegated tool exclusions.

`test/oauth-consent-security.test.ts` covers pending consent, CSRF, policy
changes, duplicate decisions, and uncertain completion. Production HTTP flows
live in `test/e2e/serve-http-consent.test.ts`; client-lock races and grant rollback
on Postgres live in `test/e2e/oauth-grant-transactions.test.ts`.

`test/minions-submission-authority.test.ts` covers submission schemas, durable
policy, lifecycle operations, legacy approval snapshots, file confinement, and
both workers. `test/e2e/minions-authority-parity.test.ts` exercises real Postgres
JSONB and authorization behavior. Filesystem write concurrency is pinned by the
existing fence and timeline suites.

`test/guarded-http.test.ts` and `test/guarded-http-tls.serial.test.ts` cover DNS,
TLS identity and ports, redirects, deadlines, body limits, and cleanup. CI runs
these boundaries on Bun 1.4.0 and 1.4.2, audits root and admin dependencies, and
executes `scripts/test-gitleaks-config.sh` to prove fixture exceptions still
report an unrelated secret in the same file. `scripts/scan-worktree-secrets.sh`
scans tracked files plus new files eligible for commit; tracked ignored files
remain included. Full-history scans use `gitleaks git . --log-opts=--all` from a
complete clone and reports must remain private.

The Docker gate sets `GBRAIN_CI_DISABLE_TEST_ENV_FILE=1` so a bind-mounted
developer `.env.testing` cannot add credentials or change the isolated test
database. Explicit local provider E2E runs can continue using that file.
