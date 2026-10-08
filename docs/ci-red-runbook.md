# CI red runbook

What to do when a CI check on master is red, which issue tracks it, and what
closes it. The watchers are `scripts/nightly-issue.ts` (run by
`.github/workflows/nightly-watch.yml`), `scripts/ci-health-report.ts` (run by
`.github/workflows/ci-health.yml`) and `scripts/release-gate.ts` (run by
`.github/workflows/release.yml`). Ownership and response times live in
[`docs/RELEASING.md`](RELEASING.md#master-red-issues).

## CI issue labels

| Label | Who opens it | What closes it | Owner |
|---|---|---|---|
| `master-red` | nightly-watch, on a red push-to-master run of Test or E2E Tests (one issue per workflow). A hand-opened tracking issue for a "cause not found" row uses this label with a different title, so no green rule touches it. | nightly-watch, on a later green push run where every previously failing job ran and passed with complete evidence (E2E Tests: every previously failing test file was among the files that run executed and passed). The scheduled full run or an issue-bound replay also counts. Hand-opened issues close by hand when their row is fixed. | The agent on release duty; first response within 1 hour (measured, not enforced). |
| `flake` | nightly-watch, when a `master-red` issue closes on green with no merged repair PR linked: one issue per previously failing test (at most 10 per close; the rest are listed in the close comment). | nightly-watch, after the repair PR linked to it merged and a later complete run passed that test's file and arm (a Windows or macOS flake: the job that failed passed). | The agent on release duty; review by the `expires` date in its JSON block. |
| `nightly-red` | nightly-watch, on a red scheduled run of any watched workflow (one issue per workflow). | nightly-watch, on a later green scheduled run with complete evidence where every previously failing job executed. | The agent on release duty; respond within 24 hours. |
| `known-red` | nightly-watch adds it to a `nightly-red` issue whose only failures match `.github/nightly-known-red.tsv` rows. | Removed when the run no longer matches only known rows. Rows never apply to push runs, and race-hunt jobs cannot have rows. | The TODOS.md entry each row names. |

Every issue body ends with a "Next step for the agent" block and a fenced JSON
block (`master-red:json`, `flake:json`, `nightly-watch:json`). Read the JSON
instead of parsing the prose. A `master-red` or race-hunt failure has one
response: a repair PR whose body says `Fixes #<issue>`.

## Master-red reconciliation

- **Which runs count:** completed push-to-master runs of Test and E2E Tests from
  this repository. Pull-request, fork, other-branch and other-workflow push runs
  are refused with a next step. Scheduled runs go to `nightly-red`.
- **Order:** every watch reads that workflow's push runs and evaluates each run
  above the high-water mark (`evaluated`: run number, then attempt) in the newest
  issue's JSON block. A dropped or superseded watch therefore loses nothing; a
  run that completes after a newer one was evaluated is ignored; a successful
  re-run is a newer attempt; a run cancelled by a newer push changes nothing.
  The first watch for a workflow with no master-red issue yet opens only an
  incident that is still red.
- **Cancelled jobs are not run:** a job cancelled with its run (a newer push,
  a user, fail-fast) neither fails nor clears anything, in master-red and
  nightly-red alike. A run whose only failures are aggregators of cancelled
  jobs changes no state. A cancelled job whose annotation says it exceeded its
  timeout is a timed-out failure.
- **Missing or malformed JSON block:** the state is rebuilt from the actions API
  by folding from the last green run before the newest red one. The body says
  so. If the API cannot be read, the watch fails and writes nothing.
- **Suspect range:** the last green push SHA, the first red SHA, the compare link
  and the PRs merged in that range.
- **Not run since:** a failing job that has not run and passed since (renamed,
  skipped, or an E2E file the selection skipped) keeps the issue open. Close it
  by hand with a comment naming the replacement, or replay E2E files:
  `gh workflow run e2e.yml --ref master -f full_corpus=true`, then
  `gh workflow run nightly-watch.yml -f run_id=<that run id> -f replay_issue=<issue>`.
- **Serialization:** each watch queues on one group per repository, target
  workflow and track (`schedule` or `push`; a replay writes `push`). Before the
  first write it re-reads the issue and re-plans when the issue moved. When two
  watches create the same issue at once, the newer one closes itself as a
  duplicate and re-plans.
- **Re-check:** `gh workflow run nightly-watch.yml -f run_id=<run id>`, with
  `-f dry_run=true` to preview.

## Flake issues

A `flake` issue records one intermittent failure: the file, test name, lane,
arm, platform, failing job, failure signature, first red run, owner and an
expiry date 14 days out. The stress gate can exempt only a failure that matches
an open issue's test name, backend and signature. The watcher writes those as
`<!-- gbrain-stress-exemption -->` JSON records (file, exact test name,
backend `pglite`, `pglite+postgres` or `postgres`, the gate's failure
signature, owner `agent on release duty`, expiry) in `master-red`, `flake` and
`nightly-red` bodies, one per failing test identity from the manifest. A
failure without an exact test name, or whose message carries a credential,
gets no record. Master-red and nightly-red records expire 14 days after the
watcher last saw the failure; flake records at the flake's expiry. Next step: run the reproduce
line (`bun run test:stress <file> --iterations 10 [--postgres]`) until it fails,
find the race, and open a repair PR with `Fixes #<issue>`. Never widen a
timeout or weaken an assertion. When the signature names a runner, disk or
secret problem, ask the repository owner for that fix instead of a code PR.

## Order hunt

The nightly E2E workflow's `order-hunt` job (also `gh workflow run e2e.yml -f order_hunt=true`, optionally `-f order_seed=N`) runs every E2E file in a seeded random order, sequentially, on one shared Postgres database per shard. It catches a file that leaves state behind (a config row, a session setting, leftover rows) that breaks the next file, which the stress gate and race hunt cannot see because each of their iterations gets a fresh database.

- **Seed:** the UTC day number by default, so each night tries a different order; the seed and shard are in the step summary.
- **A failure** is rerun alone. A file that passes alone is reported as `order-dependent test` with `bash scripts/run-e2e.sh <the files before it, in order> <file>` to replay it; bisect the files before it to find the one that leaks, and fix that file's teardown. A file that also fails alone is only a warning here, since the full E2E lanes report it.
- The job is keyless and outside `e2e-status`, so it never blocks a PR; a red order hunt turns the E2E nightly red.

## CI failure manifest

The `executed-receipts` job of test.yml and e2e.yml runs `scripts/ci-manifest.ts`
and uploads the `ci-manifest` artifact: a versioned JSON file
(`gbrain-ci-manifest/v1`) bound to the workflow, event, SHA, run id and run
attempt. It lists every failing test identity (lane, file, test, arm) and, per
file, how many tests executed, failed and were skipped. It is `complete` only
when every lane's receipts are valid (no killed shard, truncated report, older
attempt, or lane that executed nothing without a declared skip row).

nightly-watch also reads the failing jobs' annotations. A manifest or annotation
that cannot be read, or a manifest from another SHA or attempt, is incomplete
evidence. It is reported, never read as zero failures, and never clears a
failure, closes an issue or grants an exemption. After a partial re-run
("re-run failed jobs") the manifest is incomplete. Wait for the next push run,
or replay E2E files as above.

## CI health report

`bun scripts/ci-health-report.ts --since <date> --until <date> --dry-run` prints
the report for a window. `gh workflow run ci-health.yml -f since=<date> -f until=<date> -f dry_run=false`
writes it as `CI health (<since>..<until>)`. The weekly schedule writes
`CI health (week of <date>)`. The report covers:

- first-attempt pass rates for pull-request and push-to-master runs (a re-run
  counts as a failed first attempt; cancelled, skipped, dispatch and scheduled
  runs are excluded);
- the exit criteria: master Test and E2E at least 95%, PR test.yml and e2e.yml
  at least 90%. A window that cannot be read in full is indeterminate, which is
  never satisfied. In an explicit window, a missed target opens
  `CI health targets missed (...)` listing the top failing files;
- stress-gate failures and the failure classes (stress gate, test or check,
  infrastructure), plus cancellation and completion coverage;
- master-red time to first response: the first comment by the repository owner,
  a member, a collaborator or a `--responders` login (bots do not count), or
  the first linked PR from anyone;
- the nightly-watch residual: skipped watch runs, and watched-workflow runs on
  master outside the schedule and push allowlist, which still start a skipped
  watch run.

The agent on release duty dispatches the report on day 8 after a wave merges,
with the window starting at the merge date, and records the numbers on the CI
health issue.
