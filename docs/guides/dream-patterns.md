# Dream patterns

The `patterns` phase of the dream cycle reads your recent reflections and
writes pattern pages for themes that recur across at least
`dream.patterns.min_evidence` (default 3) distinct reflections. It runs one
paid subagent per run. Inside the cycle it is sized to the time the cycle has
left, so a run that cannot finish is shrunk or skipped before it spends
anything.

## Settings

| Key | Type | Default | Meaning |
|---|---|---|---|
| `dream.patterns.enabled` | boolean | `true` | Turns the phase off (`gbrain dream --phase patterns --once` still forces one run). |
| `dream.patterns.min_evidence` | integer ≥ 1 | `3` | Distinct reflections a pattern needs; also the smallest run worth submitting. |
| `dream.patterns.subagent_timeout_ms` | milliseconds | `1800000` (30 min) | The child job's own timeout. Inside the cycle it is clamped to the time left. |
| `dream.patterns.subagent_wait_timeout_ms` | milliseconds | `2100000` (35 min) | How long the phase waits for the child. Clamped the same way. |

```bash
gbrain config set dream.patterns.subagent_timeout_ms 2400000
```

## Budget sizing

After every child, finished, timed out or failed, the phase records its cost
in `dream.patterns.last_run`:

```json
{ "duration_ms": 1801000, "reflections": 100, "at": "2026-10-06T19:00:00.000Z", "outcome": "completed", "budget_skips": 0 }
```

This is state, not a setting: `gbrain config set` refuses it, and
`gbrain config unset dream.patterns.last_run` resets it.

An in-cycle run sizes itself from that record:

- With history, it estimates milliseconds per reflection with a 1.25× margin
  and submits the newest reflections that fit in the remaining budget. A
  timed-out run counts as a lower bound on cost, so the next run is also at
  most half its size. A completed run after shrinking restores the estimate.
- With no history (or after a failed child), it submits a conservative first
  batch: 25 reflections, or `min_evidence` if larger.
- When fewer than `min_evidence` reflections fit, the run is skipped with
  `insufficient_cycle_budget` (`cause: budget_below_recent_runtime`) before
  anything is submitted. The skip reports the selected and fitting counts.
- After 3 consecutive budget skips, or when the record is more than 7 days
  old, the next cycle submits a `min_evidence`-sized probe, so the phase
  never skips forever.

A direct `gbrain dream --phase patterns` has no cycle deadline: it keeps its
full size (up to 100 reflections) and records `last_run` like an in-cycle
run. It is the skip's `fix`; it is a paid run, so ask the user first.

The linear cost model has not been measured on a real paid run yet.

## Changelog

- Fix wave 11: budget sizing from `dream.patterns.last_run` (#6177).
