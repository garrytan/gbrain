---
name: measure-before-you-fix
version: 1.0.0
description: |
  Before fixing a slow/stale/timeout alert, measure the step yourself.
  Kill the theory with a stopwatch, not a code change. Measure-first ops
  triage for temporal alerts (stale, timeout, freshness, wedged, N hours
  behind) from gbrain doctor, autopilot, sync, and cron monitors — runs
  BEFORE any timeout raise, threshold change, or pipeline rewrite.
triggers:
  - "keeps timing out"
  - "ETIMEDOUT"
  - "why is this data stale"
  - "freshness alert"
  - "wedged"
  - "job is slow"
  - "sync is stuck"
  - "raise the timeout"
mutating: false
writes_pages: false
writes_to: []
upstream: measure-before-you-fix@fc834ee
---

# Measure Before You Fix

> **Convention:** see [conventions/brain-first.md](../conventions/brain-first.md) —
> before re-deriving a diagnosis, `search` the brain for prior incidents of
> the same alert. A recurring alert usually has a recorded verdict already.

Route here on any alert whose claim is **temporal** — "X is stale", "step
timed out", "pipeline wedged", "job is slow", "N hours behind". These alerts
invite an immediate structural fix (raise the timeout, split the step,
reorder the pipeline). Do the measurement first. It is almost always cheaper
than the fix, and it frequently invalidates it. (Routing is a harness
convention, not a mechanical guarantee — the contract below is the
discipline that makes it stick.)

On gbrain surfaces this covers: `gbrain doctor` staleness checks (e.g. sync
freshness, cycle freshness), autopilot cycle alerts, the sync stall watchdog
(`reason: 'stall_timeout'`), and any cron monitor built on top of them.

## The rule

**One stopwatch measurement of the suspect step, before any code change.**

If you cannot state the measured duration of the thing you claim is slow, you
do not yet know the root cause, and any fix you write is a guess wearing a diff.

## Contract

This skill guarantees:

- No structural fix (timeout raise, step split, pipeline reorder, wrapper
  rewrite) is proposed before a measured duration of the blamed step exists.
- The measurement targets the *specific* entity the alert named, not the
  aggregate (`--all` hides which member is slow).
- The alert's threshold is compared against the authoritative one
  (`gbrain doctor`'s warn/fail lines) before the system is declared unhealthy.
- The verdict explicitly distinguishes "needs more time" from "is wedged" —
  they have opposite fixes.
- Read-only: this skill changes no timeouts, thresholds, or code. It produces
  a measurement verdict that sizes the fix; the fix itself is a separate,
  now-informed change.

## Procedure

1. **Read the alert's own numbers.** They often contradict the theory already.
   (`Locks: none` means it isn't lock contention. Note it and drop that branch.)

2. **Time the suspect step directly.** Isolate the smallest unit that the alert
   blames, and run it with a clock:

   ```bash
   time gbrain sync --source source-a --no-embed
   ```

   Run it on the *specific* named entity, not the aggregate. A whole-brain run
   hides which member is slow; `--source source-a` answers the question.
   Cross-check state with `gbrain sources status` (per-source sync lag).

3. **Compare measured vs. budgeted.** Grep every timeout in the wrapper, not
   just the default in the helper signature:

   ```bash
   grep -n "timeoutMs\|timeout:" <the wrapper or cron script>
   ```

   A generous per-call override makes the helper's default irrelevant. Check the
   call site before blaming the default.

4. **Check the alert threshold against the authoritative one.** Before
   concluding the system is broken, confirm the alerter and the audit agree on
   what "bad" means. `gbrain doctor`'s sync-freshness check defaults to
   24h warn / 72h fail (env-overridable via `GBRAIN_SYNC_FRESHNESS_WARN_HOURS`
   / `GBRAIN_SYNC_FRESHNESS_FAIL_HOURS`); a cron monitor paging at 12h is
   speaking below the authoritative warn line. A monitor that *acts* early is
   correct; a monitor that *speaks* at its act-line is a false-positive
   generator.

5. **Only now design the fix** — against the number you measured.

## The threshold-mismatch failure mode

A cron monitor legitimately acts earlier than the doctor fails, to keep drift
out of FAIL territory. That is good design. The bug is reusing the
act-threshold as the alert-threshold: everything between "act" and "warn"
becomes a recurring page about a healthy system.

**Separate the two constants.** Act at the aggressive line, speak at the
authoritative one:

```js
const ACT_HOURS = Number(env.MONITOR_ACT_HOURS || 12);      // act early — fine
const ALERT_HOURS = Math.max(ACT_HOURS, DOCTOR_WARN_HOURS); // speak at the audit's line
```

Symptom to recognize instantly: **a repeating alert whose numbers sit below the
doctor's own warn line**, while the underlying resource looks fine when queried
directly.

## Red flags that you are theorizing, not diagnosing

- You have a root cause but no measured duration.
- Your fix is a rewrite and you have not run the step once.
- You revise the theory twice without taking a new measurement between revisions.
- The alert says "no recovery in flight" — verify whether recovery is in fact
  running before believing it (`ps` for the worker; check the launch flag;
  `gbrain jobs list` for queued work).
- "Already up to date" in the step output. That step is not your bottleneck.

## Anti-Patterns

- **Raising a timeout to fix a stall.** If the step is genuinely hung, a bigger
  budget just hangs longer. Measure, then decide between "needs more time" and
  "is wedged" — they have opposite fixes. (gbrain's sync stall watchdog makes
  the same distinction natively: it keys on forward progress, not elapsed time.)
- **Rewriting a pipeline on an unmeasured starvation theory.** Splitting steps to
  fix starvation that does not exist adds surface area and fixes nothing.
- **Trusting the alert's causal claim.** Alerts report symptoms accurately and
  causes badly. The staleness number is real; the reason attached to it is a guess.
- **Skillifying or persisting a root cause you have not measured.** A confident
  wrong diagnosis baked into a playbook is worse than the original bug.

## Known failure modes handled

- **Triple-wrong diagnosis on a freshness alert.** A cron monitor paged
  repeatedly about two sources (`source-a`, `source-b`) reported hours-stale.
  Three successive root causes were asserted and a wrapper rewrite approved —
  before any measurement. The measurement:
  `time gbrain sync --source source-a --no-embed` finished in single-digit
  seconds with "Already up to date" (same for `source-b`), and
  `gbrain sources status` showed every source synced that morning. Every
  theory died at once. Actual cause: the monitor alerted at its
  act-threshold, hours below `gbrain doctor`'s authoritative warn line. The
  fix was two lines (`ALERT_HOURS = max(ACT_HOURS, WARN_HOURS)`), not a
  rewrite. Lesson: when a page repeats about a system that measures healthy,
  suspect the thresholds before the system.
- **Contention-theory corollary caught in the same pass:** a CPU-contention
  worry about a deprioritized (`nice`'d) step was equally unfounded — the step
  finished in seconds while the host was under sustained concurrent load.
  Contention theories need the same stopwatch as staleness theories.

## Output Format

The output is a measurement verdict (conversation-level; this skill writes no
brain pages). Only after the verdict is a fix proposed, sized against the
measured number:

```
## Measurement verdict
- Alert:      <the alert text and which monitor emitted it>
- Claim:      <the temporal claim, e.g. "source-a 14h stale">
- Measured:   <exact command> → <duration> (<key output, e.g. "Already up to date">)
- Budgeted:   <timeout constant + any call-site override, file:line>
- Thresholds: monitor act-line <X>h vs doctor warn-line <Y>h → <match | MISMATCH>
- Verdict:    false page on healthy system | needs more time | wedged | genuine regression
- Fix:        <the change, justified by the measured number — or "none; adjust the alert line">
```

## Dedup (sharp boundaries)

- **GStack `investigate`** — systematic debugging of code bugs ("why is this
  broken", 500 errors, wrong output). Boundary: `investigate` root-causes code
  *behavior*; this skill is the measure-first gate for temporal *ops alerts*
  (stale/timeout/freshness/wedged) that runs before any timeout or threshold
  is touched. If the stopwatch confirms a genuine slowness or regression, hand
  off to `investigate` with the measured number.
- **`skills/maintain/SKILL.md`** — runs brain health checks and repairs
  (doctor, extraction, dream cycle). Boundary: maintain *emits and acts on*
  health output; this skill governs how to respond when one of those checks
  pages, before budgets or wrappers change.
- **smoke-test (host-side)** — binary post-restart health checks with
  auto-fix. Boundary: smoke-test answers "is it up after a restart"; this
  skill answers "is this slow/stale claim even true".
- **`skills/cron-scheduler/SKILL.md`** — schedules monitors and jobs.
  Boundary: cron-scheduler decides *when* monitors run; this skill supplies
  the act-line vs alert-line rule their thresholds must encode.
- **`skills/conventions/test-before-bulk.md`** — trial-before-bulk for
  mutations. Same spirit (evidence before action), different object: that
  convention gates bulk *writes*; this skill gates timeout/threshold/pipeline
  *changes*.
