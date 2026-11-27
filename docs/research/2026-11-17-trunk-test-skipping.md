# Trunk Dynamic CI test skipping: keep it in learning mode, don't enforce (2026-11-17)

- **We learned that letting a test-selection service skip CI jobs would have hidden real failures.** Replayed on gbrain's own red pull-request runs, enforcement would have skipped 10 of 52 gated failures (19%), one of them a security-regressions failure, and shown 5 red runs as green.
- **We learned that the savings were smaller than first reported.** You should replay a test-skipping tool against your own failed runs before you let it skip anything.
- The filter stays in learning mode, where it records a verdict and skips nothing ([ci-event-parity.md](../ci-event-parity.md#trunk-dynamic-ci)).

## Question

Should gbrain let Trunk Dynamic CI skip test jobs on pull requests, to cut CI cost?

## What was tried

- **Observer trial (five days, ending 2026-11-08).** The filter ran in learning mode on pull requests, and two reviewers counted what enforcement would have done.
- **Replay (2026-11-17).** A read-only replay of the 154 red pull-request Test runs in a one-week baseline window, part of a wider CI cost trial.

## Results

| Measure | Result | Source |
|---|---|---|
| Observer trial: misses | 1 (a security-regressions Windows flake on its first attempt) | Reported by the trial's reviewers |
| Observer trial: savings | 31% / 22%, not the 37.7% first claimed; zero wall-clock saved | Reported by the trial's reviewers |
| Observer trial: would-skip on failed jobs | 15 of 37 | Reported by the trial's reviewers |
| Replay: runs with a usable verdict | 66 of 154 (46 had no dynamic-ci job; 42 failed open because no token was supplied, cause not found) | Internal CI trial report |
| Replay: gated failures enforcement would have skipped | 10 of 52 (19%), including one security-regressions failure | Internal CI trial report |
| Replay: red runs that would have shown green | 5 | Internal CI trial report |

Sources: internal reports (refs GST-1398, GST-3002, GBRA-618); the wiring guard is `scripts/check-dynamic-ci.ts`.

## Decision and why

Don't enforce. The filter skips real failures and saves less than claimed. The maintainer chose to keep the service in learning mode rather than remove it, and the merge path never runs the filter. Tuning of what it decides continues in learning mode, where it skips nothing.

## Cost

The replay was part of a CI cost trial that cost about $64 of model use and roughly $15 to $20 of Ubicloud time in total; the replay alone wasn't priced separately.

## What would reopen it

- A filter that fails closed when it has no verdict, and a replay showing it skips no gated failure in a week of red runs.

The rest of that CI cost trial (smaller shard plans, right-sized test machines, a `full-ci` label that fires once per head) shipped as ordinary changes, and its after-measurement is still pending; it gets its own page when it concludes.
