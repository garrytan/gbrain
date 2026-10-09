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
cell excluded on any event. Required checks stay keyed on the `test-status`
and `e2e-status` aggregators, never on per-cell matrix names.

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
| `persistence-validation.yml` | Bun matrix of read latency, deployment matrix, unit-lane PostgreSQL arms, soak, crash robot, reconciliation | Parity: both Bun versions on every event | — |
| `persistence-validation.yml` | `SOAK_OPERATIONS` 2,500 vs 10,000 | Named exception | Every push to master and the nightly Test schedule |
| `persistence-validation.yml` | `ROBOT_SECONDS` 150 vs 600 | Named exception | Every push to master and the nightly Test schedule |
| `native-locks.yml` | `inputs.scope` (OpenClaw, musl, Windows probes, Bun 1.4.0 and cross-target cells) | Named exception | Every push to master and the nightly Test schedule (`full`) |
| `e2e.yml` | Doc-only pull request selects no E2E file | Named exception | Every push to master (whole corpus) and the nightly E2E schedule |
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
