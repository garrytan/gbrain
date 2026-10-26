# CI event parity

The classification table [docs/TESTING.md](TESTING.md#event-parity) links to.

A red that only a push to master can produce is a red no PR could have
caught. So every event-conditional behavior in the workflows is either
parity (pull requests and merge-queue runs do the same work) or a named
exception whose comment, beside the condition, names the scheduled run that
covers it. A condition with no covering scheduled run defaults to parity;
anything else needs a new scheduled run or a decision recorded beside the
condition. `test/scripts/ci-pr-scope.test.ts` fails on an event-conditional
job or block in a test workflow without that comment, and on a Bun-version
cell excluded on any event. Merge reads the `full-suite` and `e2e-full-suite`
checks ([below](#full-ci-on-pull-requests)), never per-cell matrix names.

## Classification

| Workflow | Condition | Class | Covered by |
| --- | --- | --- | --- |
| `test.yml` | `security-regressions` Bun matrix | Parity: both Bun versions on every OS, every event | — |
| `test.yml` | `changes` native scope (`smoke`/`primary`/`full`) | Named exception | Every push to master and the nightly Test schedule (`full`) |
| `test.yml` | `gitleaks` commit range by event | Parity: each event scans the range it introduces | — |
| `test.yml` | `dependency-audit` blocking scope | Named exception with a rule ([below](#dependency-audit-rule)) | Every push to master and the nightly Test schedule (always blocking) |
| `test.yml` | `export-scale` pages, 10,001 vs 100,001 | Named exception | Every push to master and the nightly Test schedule |
| `test.yml`, `stress.yml` | `stress-changed-tests` file set | Named exception: PR-only gate; succeeds with "not a PR event" elsewhere | Push and nightly runs run every file; the nightly race hunt repeats the Postgres arms |
| `test.yml` | `race-hunt` | Named exception: schedule and dispatch only, outside `test-status` | Itself (nightly Test schedule) |
| `e2e.yml` | `order-hunt` | Named exception: schedule and `order_hunt` dispatch only, outside `e2e-status` | Itself (nightly E2E schedule) |
| `test.yml` | `native_only`, `race_hunt`, `stress_*` dispatch inputs; concurrency suffixes | Parity: manual modes and run grouping, never applied to PR, push or schedule events | — |
| `persistence-validation.yml` | Bun matrix of read latency, deployment matrix, unit-lane PostgreSQL arms, soak, crash robot, reconciliation, convergence | Parity: both Bun versions on every event that runs the lane | — |
| `test.yml`, `persistence-validation.yml` | Cheap tier on pull requests: no unit shards, serial, slow, BrainBench, admin-browser, shared-skills, coverage or `test-status`; of the persistence lanes only the crash robot and convergence, and those and the native cells only when the diff selects them | Named exception ([below](#full-ci-on-pull-requests)) | The full-ci dispatch on the head before merge (merge-train requires `full-suite`), every push to master, the merge queue and the nightly Test schedule |
| `e2e.yml` | No `pull_request` trigger | Named exception ([below](#full-ci-on-pull-requests)) | The full-ci dispatch on the head before merge (merge-train requires `e2e-full-suite`), every push to master, the merge queue and the nightly E2E schedule |
| `test.yml`, `e2e.yml` | A push to master skips its full lanes when it reuses a passed full-suite run of its exact tree | Named exception ([below](#master-push-reuse)) | The reused run (same tree, full profile); schedules never reuse |
| `persistence-validation.yml` | `convergence` selected on pull requests by `scripts/ci-convergence-scope.sh` (test.yml `changes`; never by `package.json` alone) | Named exception | Every merge-queue run and every push to master; the nightly cell runs in `convergence-nightly.yml` |
| `convergence-nightly.yml` | The convergence gate's nightly cell (2,000 pages, 50 ms, 20 kills, run-id seed): schedule and dispatch only, outside `test-status`; the PR cell (200 pages, 10 ms, 6 kills, seed 6650) runs in `persistence-validation.yml` | Named exception | Itself (nightly Convergence schedule) |
| `persistence-validation.yml` | `SOAK_OPERATIONS` 2,500 vs 10,000 | Named exception | Every push to master and the nightly Test schedule |
| `persistence-validation.yml` | Crash robot `--robot-scope=pr` (Postgres lease-bound seams skipped, 820 s PGLite and 620 s Postgres ceilings) vs `full` (1200 s PGLite, 880 s Postgres; [ceilings](#crash-robot-ceilings)); the nightly adds that day's exploration seeds | Named exception | The full-ci dispatch, every push to master (same fixed list, so it may reuse that run) and the nightly Test schedule |
| `native-locks.yml` | `inputs.scope` (OpenClaw, musl, Windows probes, Bun 1.4.0 and cross-target cells) | Named exception | Every push to master and the nightly Test schedule (`full`) |
| `e2e.yml` | Doc-only merge-queue entry selects no E2E file | Named exception | Every push to master (whole corpus) and the nightly E2E schedule |
| `e2e.yml` | Full-corpus coverage lanes and their `e2e-status` checks | Named exception | Nightly E2E schedule (or a `full_corpus` dispatch) |
| `heavy-tests.yml` | Label-gated jobs on pull requests | Named exception | Nightly Heavy Tests schedule |
| `heavy-tests.yml` | `grok-door` (label or input only) | Recorded decision: no scheduled run until the `XAI_API_KEY` secret exists | None yet, by decision |
| `heavy-tests.yml` | `opencode-door-canary` | Named exception: schedule-only, non-gating canary | Itself |
| `macos-validation.yml` | Label-gated on pull requests | Named exception | Nightly macOS validation schedule |
| `scale-tier.yml` | Path- or label-gated 10k on pull requests | Named exception | Nightly Scale tier schedule (10k-50k) |
| `semgrep.yml` | PR diff scan vs full-tree scan | Named exception | Weekly Semgrep schedule |
| `osv-scanner.yml` | Pull requests scan only on a manifest change | Named exception | Weekly OSV schedule; `dependency-audit` on every PR |
| `nightly-watch.yml` | `workflow_run` event guard | Not a test scope: it files issues from qualifying scheduled and push-to-master runs | — |
| `fix-wave-gate.yml`, `fix-wave-closeout.yml` | Pull-request action and merge state | Not a test scope: merge-process automation | — |
| `harness-check.yml` | `pull_request` only; a missing `HARNESS_EVALS_READ_TOKEN` skips the job (succeeds with a notice); a fork head is refused | Named exception: advisory, non-required check ([below](#harness-check)) | None: pushes to master and schedules do not run it; the pin bump runs its steps by hand on master |
| `full-ci.yml` | `full-ci` label, later pushes to a labeled pull request, same-repository head | Not a test scope: dispatches the full profile on the head | — |

## Full CI on pull requests

Every pull-request push runs the cheap tier in Test: `verify`, `typecheck`,
`gitleaks`, the security regressions, the dependency audit, the stress gate
on changed tests, and the GitHub-only lanes the diff selects. The crash robot
and convergence run when `scripts/ci-convergence-scope.sh` selects
persistence or sync paths. The native cells run when
`scripts/ci-native-scope.sh` selects more than `smoke`. The
`cheap-tier (full suite not run)` check aggregates them
(`scripts/ci-cheap-tier.sh`): a selected lane that skipped fails it, and its
summary says the full suite did not run. E2E does not run on pull requests.

The full suite runs on the exact head before merge, with the same shape as a
push to master: every unit shard, serial, slow, both PostgreSQL arms and the
whole E2E corpus. A maintainer adds the `full-ci` label (a label needs triage
access, so contributors cannot add one). `full-ci.yml` then dispatches Test
and E2E on the head branch, and again on every later push while the label
stays. A fork's branch is never dispatched. A thread that wants the full suite
earlier, for a risky change, dispatches it itself:
`gh workflow run test.yml --ref <branch> && gh workflow run e2e.yml --ref <branch>`.

merge-train requires the `full-suite` (Test) and `e2e-full-suite` (E2E)
checks to have succeeded on the exact head. Each one succeeds only when its
own run's aggregate did (`test-status`, `e2e-status`). A pull-request run
skips both and names them `full-suite-not-run`, so a cheap green can never
produce either one. Each uploads `full-suite-tree` / `e2e-full-suite-tree`,
a `tree.json` recording the tested tree (`scripts/ci-full-suite-tree.sh`).
Pushes to master, the merge queue and schedules always run the full profile.

## Master-push reuse

A push to master runs nothing again when its tree equals the tree of a passed,
complete full-suite run of the same workflow (`scripts/ci-reuse.ts`, in Test
`changes` and E2E `prepare-e2e`). The candidate must meet all of these:

- It is a `workflow_dispatch` or `push` run from this repository.
- Its latest attempt completed with success.
- Its single `full-suite` (or `e2e-full-suite`) job succeeded in that attempt.
- Its `tree.json` matches the run (id, attempt, commit, event, workflow,
  profile `full`).
- The recorded tree equals both the push tree and the tree of the run's head.

The push itself must be a merge commit. Anything else, an API error or a
partial, cancelled or diagnostic run included, leaves reuse unset, so the push
runs in full. A reusing push skips every full lane and both aggregates, records the
reused run in its summary, and runs the `reused-full-suite` job with the
`reuse.json` artifact. The release gate (`scripts/release-gate.ts`) accepts a
reusing push only with a readable `reuse.json` naming the same workflow, the
push head and a valid source run. It prints the reused run per workflow and
writes `test_reused_run_id` / `e2e_reused_run_id`. Schedules never reuse.

## Dependency-audit rule

`dependency-audit` blocks on pushes, schedules, manual runs and pull requests
or merge-queue entries that change a dependency manifest or carry the
`dependency-audit` label; on other pull requests a new upstream advisory is a
warning, so one published advisory cannot turn every open PR red at once.
The red it produces lands on master instead, and is handled like any other:
a push-to-master red opens the Test `master-red` issue, a scheduled red the
`nightly-red` issue. The repair PR bumps, overrides, patches or removes the
dependency. When no fix exists, an ignore entry needs Garry's approval and an
expiry date.

## Crash robot ceilings

Every crash-robot run executes one fixed schedule list (`scripts/persistence/robot-driver.ts`
`ROBOT_RANDOM_SEEDS`), so a master push can reuse a passed run of its tree. `--robot-seconds`
is a ceiling, not a budget: a run past it fails with `over_budget` instead of covering less.
Each cell writes its elapsed time as a share of its ceiling to the job summary, so drift
shows long before a run fails.

Measured on ubicloud-standard-4, full scope, run 39996381819:

| Cell | Wall | Cross-boundary crashes | Process faults | 8 random seeds |
|---|---|---|---|---|
| pglite / Bun 1.4.0 | 724 s | 89 runs, 494 s | 67 s | 128 s |
| pglite / Bun 1.4.4 | 880 s | 89 runs, 618 s | 72 s | 157 s |
| postgres / Bun 1.4.0 | 1,290 s | 27 runs, 884 s | 188 s | 190 s |
| postgres / Bun 1.4.4 | 967 s | 27 runs, 767 s | 68 s | 100 s |

- **PGLite, 1200 s.** The slowest cell ran 880 s. The nightly's two exploration seeds
  add about 45 s, and the slower cells in the previous week's manifests project to
  about 985 s. 1200 s is that projection plus about 20%.
- **Postgres, 880 s.** Before #7454 the slowest cell ran 1,290 s, including one 128 s wait
  for a dead owner's effect-claim lease, under an 1800 s ceiling. Since #7454 releases that
  claim early, measured on master with a full-scope dispatch (run 40062601017):

  | Cell | Wall | Cross-boundary crashes | Process faults | 8 random seeds |
  |---|---|---|---|---|
  | postgres / Bun 1.4.0 | 391 s | 27 runs | 4 runs | no lease wait |
  | postgres / Bun 1.4.4 | 679 s | 27 runs | 4 runs, one 127 s | no lease wait |

  The 679 s cell includes one 127 s `pooler_disconnect` process fault on
  `overlapping_slugs_two_sources` (2.4 s in the other cell). 880 s is the slowest cell plus
  about 30%; the nightly's two exploration seeds (about 15–20 s each on Postgres) fit inside
  that margin.
- **Pull requests, 820 s PGLite and 620 s Postgres.** Scope `pr` crashes each seam once
  and skips the Postgres lease-bound seams. PGLite measured 510 s and 427 s (run
  40003479271), then 529 s and 474 s (run 40018836178); 820 s is the slowest plus about 30%.
  A Postgres crash run takes about 10 s. Before #7454 it took about 130 s when the killed
  process held an effect claim, because recovery waited out that claim's 2-minute lease;
  since #7454 a dead owner's effect claim is released early, so no cell waits on a lease.
  Measured on master after #7454 (run 40059909892, two attempts):

  | Attempt | Cell | Time |
  |---|---|---|
  | 1 | postgres / Bun 1.4.0 | 357 s |
  | 1 | postgres / Bun 1.4.4 | 367 s |
  | 2 | postgres / Bun 1.4.0 | 475 s |
  | 2 | postgres / Bun 1.4.4 | 362 s |

  620 s is the slowest plus about 30%. The cells before #7454 ran 567 to 785 s with one to
  three lease waits, under a 1020 s ceiling.

## Cost of parity

Measured from the 15 latest green pull-request Test runs before parity (job
start to finish, PR parameters): the Bun 1.4.0 twins add 14 cells per
`pull_request` run, 55.9 runner-minutes in total: 233 Ubicloud vCPU-minutes
(the two unit-lane PostgreSQL arm shards, 19.8 minutes, are the largest share)
and 2.4 GitHub-hosted minutes (macOS 0.9, Windows 1.5). At the week's 713
completed PR runs that is about 40,000 runner-minutes a week. Wall time does
not grow on an idle pool: on the 10 latest push runs, which already run both
versions, the 1.4.0 cells finished between 2.6 minutes before and 2.1 minutes
after every other job (median 0.1 minutes before), and the PR critical path
stays the unit `test` shards (median 13.9 minutes). A `merge_group` run uses
the same profile and costs the same per run; the merge queue is inert, so it
adds nothing today. If the added median PR wall time exceeds 15 minutes over
a week, the agent on release duty records it on the CI health issue.

## Harness check

`.github/workflows/harness-check.yml` runs on every pull request to master from a branch of this repository, on a 4-vCPU Ubicloud runner with a 45-minute limit. It is not a required check. It clones [harness-evals](https://github.com/garrytan/harness-evals) at the commit `HARNESS_EVALS_PIN` names (`2c45a247f6`, harness-evals v0.0.9, main on 2026-10-26), builds the gbrain sidecar image for the pull request's head commit with harness-evals' `scripts/build-gbrain-image.sh` (the keyword target: gbrain at that commit run from source, four keyword PGLite brains over the messy-company-v1 corpus, the install bundle from `gbrain skillpack scaffold`, `compile-context` and `gbrain setup`; no key anywhere), and runs the keyless rungs of `scripts/gbrain-check.ts` against that image with `--no-build`: the fake harness through harness-evals' real runner and its world's gbrain tap, one trial on the starter surface, one on the verbs surface, one with the gbrain-docs bundle mounted, one on the company brain under scope `sources` with two members, plus a direct probe of the company brain that searches and queries once per member and query under that member's `source_ids` (15 members, 344 calls, 1,062 rows in the sample run). It gates on one number: the count of pages or rows returned to a member whose grant does not hold their source (cross-scope). The job fails when that count is not zero, when the scoped probe did not run, or when no `check.json` was written (the image did not build or the check did not finish); every other failed assertion of gbrain-check (a tool count off harness-evals' pin, a missing search tool or verb, a retrieval that misses the known dev page, an install bundle or view digest, the Hermes context, the installer's brain-first block or per-turn hook files) is a `::warning::` in the job log and a line in the job summary, so a pull request that changes the tool list or the install output is told and not blocked. The only secret it reads is `HARNESS_EVALS_READ_TOKEN`, a fine-grained token with Contents: read on the private harness-evals repository; it reads no model key and runs no paid trial (the metering proxy runs with placeholder keys the fake harness never uses). When the secret is not set, the job's first step writes a `::notice::` and a "skipped" job summary naming the missing secret, every later step is skipped, and the job succeeds. A pull request from a fork is refused before that check: the image build fetches the commit from this repository, where a fork's commit does not exist. The artifact `harness-check-keyless` holds `summary.md`, `keyless/check.json` (every assertion and the evidence behind it, including `evidence.scoped` the gate reads) and `trials.jsonl`; never a trial's state or a token file.

Measured by hand on 2026-10-26 against master at `b06ac32b` (0.60.465.0) on a 2-core, 7 GB Linux machine (Docker 29.9.2, bun 1.4.4): image build 359 s, check 59 s (30 assertions passed, 0 failed, 0 pin diffs, cross-scope pages 0), 457 s end to end. A CI runner is not measured yet.

**Bumping the harness-evals pin.** The pin is one line in the workflow, `HARNESS_EVALS_PIN`, and it must be a commit on harness-evals main. To move it, read the new head with `git ls-remote https://github.com/garrytan/harness-evals refs/heads/main`, run the workflow's steps once by hand against master with the new pin (clone at the pin, `bun install --frozen-lockfile`, `scripts/build-gbrain-image.sh`, `scripts/gbrain-check.ts --no-build`, then the gate step's shell), and read its last lines (`gate passed` and the warning count). Then change the line and open the bump as its own pull request, so the first run under the new pin is on a commit whose gbrain did not change. A pin diff reported as a warning after a deliberate gbrain change is fixed on the harness-evals side (its `gbrain/pin.json`), and the bump that follows picks it up.
