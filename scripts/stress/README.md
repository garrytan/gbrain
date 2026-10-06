# Stress runner, PR stress gate and race hunt

`bun run test:stress` runs test files repeatedly on one checkout to prove they
are deterministic. The same runner drives three callers: local runs, the PR
stress gate (`stress-changed-tests`, inside `test-status`) and the nightly
race hunt (`race-hunt`, outside `test-status`). Both CI lanes live in
`.github/workflows/stress.yml`, called from `test.yml`.

| File | Role |
| --- | --- |
| `scripts/stress/run.ts` | The runner (`bun run test:stress`) |
| `scripts/stress/plan.ts` | Changed files, helper fan-in, profiles, shards, reproduce lines |
| `scripts/stress/gate.ts` | CI planner and reporter for both lanes (`plan`, `report`) |
| `test/postgres-unit-arms.txt` | The race hunt's file list (shared with `unit-postgres-arms`) |

## Running it locally

```bash
bun run test:stress                                   # files changed versus origin/master, 10 iterations
bun run test:stress test/a.test.ts --iterations 20    # explicit files
bun run test:stress --postgres                        # include PostgreSQL arms and E2E files
bun run test:stress --base <ref> --head <ref>         # the files a commit range touched
bun run test:stress --dry-run                         # print the plan only
```

Without files the runner takes every `test/**/*.test.ts` added or modified
versus the merge base with `origin/master` (renames at the new path,
deletions skipped, working tree and untracked files included), plus direct
importers of changed `test/helpers/` files by the fan-in rule below.
`--postgres` uses the server in `GBRAIN_STRESS_ADMIN_URL`, else a
test-shaped `DATABASE_URL`, else starts `docker-compose.ci.yml`'s
`postgres-1` (the `ci:local` service) under its own compose project and
removes it afterwards.

Every run prints one line per iteration, setup and run time, and for each
failing file a reproduce command plus its context line:

```
FAIL [stress_failure]: test/a.test.ts failed in 2 iteration(s) (first: iteration 7, …)
    bun run test:stress test/a.test.ts --iterations 10 --first-iteration 7 --seed 412207 --postgres
    # sha 1a2b3c4d5e6f, Bun 1.4.2, backend pglite+postgres, profile postgres-arm (database), iteration 7, seed 412213, artifact <run url>
```

The reproduce line is the exact command with the recorded values; database
credentials never appear in it or in any log (`redact()`). The manifest
(`.context/test-stress/stress-manifest.json`) records SHA, Bun version,
backend, profile, iteration, seed and every failure. Exit codes: 0 every file
passed, 1 a failure, 2 a usage or setup error, 130/143 cancelled.

## Execution profiles

| Profile | Files | Command and environment |
| --- | --- | --- |
| `unit` | `*.test.ts` | `bun test --timeout=60000`, `DATABASE_URL` unset |
| `serial` | `*.serial.test.ts` | `bun test --max-concurrency=1 --timeout=120000`, `DATABASE_URL` unset; files run one at a time |
| `slow` | `*.slow.test.ts` | the workflow's pull-request values (`SPECIAL_FILES` in `plan.ts`: export scale at 10,001 pages, the pre-feature executable built for the old-binary suite) |
| `postgres-arm` | a file with a `DATABASE_URL`-gated arm laned by `test/postgres-unit-arms.txt` or a `DATABASE_URL` workflow step, with `--postgres` | `bun --no-env-file test --timeout=120000` with a fresh `DATABASE_URL`: both arms, as in `unit-postgres-arms`. A file whose arm runs only through a `test/e2e/` wrapper (`registerPostgresTests`) runs in its suffix profile and its wrapper is stressed as an `e2e` file |
| `e2e` | `test/e2e/*.test.ts`, with `--postgres` | `bash scripts/run-e2e.sh <file>` with a fresh `DATABASE_URL` |

Paid-provider files (`*.live.test.ts`, `test/live/`,
`scripts/e2e-live-key-only.txt`) are listed as not stressed. A file whose
every test skips on this platform, skips without an unavailable secret, or
skips without a prerequisite its owning job in `heavy-tests.yml`,
`native-locks.yml` or `macos-validation.yml` installs, is listed as not
stressed with that reason; any other run with zero executed tests fails.

## Isolation and receipts

Each database iteration gets its own database, `CREATE DATABASE … TEMPLATE`
from a blank template the run creates once. Names carry a `test` segment
(`gbrain_stress_<pid>_<rand>_i<n>_test`). Every database and container the run
creates is recorded under `.context/test-stress/owned/` and dropped after the
iteration, on Ctrl-C (SIGINT/SIGTERM stop the running file first), and by the
next run when the owning process is gone.

Every iteration writes an executed-test receipt (`<out>/receipts/<file>--i<n>/`:
the receipt, its file list and Bun's JUnit report). The first iteration's
executed tests are the expected set: a later iteration that does not run one
of them is an unexpected skip and fails. A `postgres-arm` iteration whose fresh
database served no transaction fails too (the arm never connected). Each
iteration has a 15-minute wall cap (`GBRAIN_STRESS_ITERATION_TIMEOUT_MS`).
Seeds: iteration `n` exports `GBRAIN_TEST_SEED=<base>+n-1`; the base is
`--seed` or a hash of the commit and file, and `--randomize` passes it to
Bun's test-order randomizer.

## PR stress gate

`stress-changed-tests` runs on every event and always concludes success or
failure: outside `pull_request` and `merge_group` it succeeds with "not a PR
event"; if the changed-file list cannot be computed it fails with the fetch
step. Otherwise every changed test file runs 10 times in Postgres-backed
shards.

- **Helper fan-in.** A changed helper with at most 25 direct test importers
  stresses all of them. Above 25 it stresses the helper's own tests and 10
  importers sampled deterministically from the head SHA, and lists the rest;
  their Postgres arms join that night's race hunt. Changed test files are
  never sampled or skipped.
- **Shards.** Work items (a file's iterations, split when ten exceed the
  budget) pack into the fewest shards whose measured estimates stay under 25
  minutes. There is no shard-count cap; `max-parallel: 12` keeps a large PR
  from starving other jobs. Shard jobs record results and exit 0 on test
  failures; the result job decides, so a planned iteration without a receipt
  fails the check as incomplete.
- **Failure.** The result names the file, the failing iteration and the
  reproduce line, and says a flaky touched file must be root-caused in this PR.
- **Exemptions.** A failure passes only when its file, test name, backend and
  failure signature match an unexpired record in an open `master-red`, `flake`
  or `nightly-red` issue that predates the PR and was opened or labeled by the
  nightly-watch bot or a maintainer (write access). Records live in the issue
  body or in a comment by the bot or a maintainer. Any other failure in that
  file, or a new signature, still fails. A GitHub API failure grants nothing.
  There is no override label. Record format:

  ````
  <!-- gbrain-stress-exemption -->
  ```json
  {"file":"test/a.test.ts","test":"suite > case","backend":"pglite+postgres","signature":"<from the manifest>","owner":"@release-duty","expires":"2026-10-20"}
  ```
  ````

- **Dispatch.** `gh workflow run test.yml -f stress_files="test/a.test.ts test/b.test.ts"`
  or `-f stress_base=<ref> [-f stress_head=<ref>]` runs only the gate,
  labeled diagnostic. Inputs reach the planner through `env:` only; paths must
  match `^test/[\w./-]+\.test\.ts$` and refs must pass `git check-ref-format`
  or be 40-hex SHAs.
- **Summary.** Files stressed, not-stressed files with reasons, touched files
  with an open issue, runner-minutes, and p95 queue and completion time of the
  shard jobs.

## Race hunt

The scheduled Test run (and `gh workflow run test.yml -f race_hunt=true`, a
diagnostic) runs every file in `test/postgres-unit-arms.txt` 10 times against
Postgres, plus the Postgres-arm and E2E importers of helpers changed on master
since the previous night that the gate sampled out. Budget: at most 55-minute
shards, 6 by default, growing to 12; past that every file runs at least 3
iterations nightly and the spare capacity rotates by day, so each file still
reaches 10 iterations within the week. Files are never dropped: what does not
fit fails the job with "race hunt over budget" and the unrun files. A red
prints one `::error` line per failing file with its reproduce command, which
the Test nightly-red issue carries; the response is a repair PR, never a
known-red row.
