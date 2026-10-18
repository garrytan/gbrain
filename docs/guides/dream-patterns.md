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
| `dream.patterns.min_interval_hours` | hours, 0 to 720 | `6` | Time an in-cycle run waits after the last completed run. `0` turns it off. See [Cadence](#cadence). |
| `dream.patterns.child_read_budget_kb` | whole KB, 0 to 100000 | `200` | `get_page` output the child reads in full before reads come back summarized. `0` turns it off. See [Child read budget](#child-read-budget). |

```bash
gbrain config set dream.patterns.subagent_timeout_ms 2400000
```

## Updating an existing pattern page

Since #5385 a `put_page` of a page that already exists must send the page's
`revision` as `expected_revision`, or it is refused `revision_required`. The
child's prompt says so (#6779): it keeps an existing page's slug, skips the
page when its cited evidence already covers the pattern, and otherwise reads
it with `get_page` and writes the merged page back with that revision. If the
child still sends no revision, the refusal it gets names the page's current
revision, so it can merge and resend instead of failing the phase with
`PATTERNS_CHILD_DEAD`. Only the subagent tool path adds the revision; MCP and
CLI callers get the refusal and its `get_page` fix as before.

## Timeline appends

A patterns child often updates an existing pattern page by appending a dated
entry (`add_timeline_entry`) instead of rewriting the page. The phase treats
those pages as written:

- It finds the entries the child newly published from their write receipts.
  An entry that was already on the page, or a replayed call, is not a new
  append.
- With `dream.quote_verify` on (the default), only the new entries are
  checked against the reflections this run read. An entry whose quote is not
  in them moves to the page's `unverified_claims`, like a failing claim on a
  rewritten page. Everything else on the page, including quotes an earlier
  run verified against older reflections, stays as it is.
- The page gets the dream provenance stamp and counts in `patterns_written`.
- Segmented pages (bodies stored in segments) work too. A segmented reflection
  is read back through the segment reader, so its quotes still ground, and a
  segmented pattern page is read back as text, checked and rewritten. A page
  over the single-string ceiling (24 MiB) is skipped instead: a reflection
  that large is not checked against, and a pattern page that large keeps its
  appended entries unchecked, counted in
  `quote_verify.timeline_appends.segmented_skipped` and logged.
  `timeline_appends` counts the new entries, and `quote_verify.timeline_appends`
  reports how many were checked, quarantined and repaired.

`appended_unverified` (the number of completed `add_timeline_entry` calls) is
deprecated and will be removed two releases after this one; read
`timeline_appends` and `patterns_written` instead.

**Say to your agent:** *"Did the last dream patterns run check the quotes it added to my pattern pages?"*
The agent reads the phase result (`gbrain dream --phase patterns --json` on a
direct run) and reports `quote_verify.timeline_appends`.

## A page that fails quote grounding

After a completed child, every pattern page it wrote and every pattern page an
earlier run left without `quote_verified_at` is grounded and written back. One
page whose write-back is refused does not fail the run:

- It is listed in `grounding_failed` with its error code and the command that
  retries it, gets no provenance stamp and does not count in
  `patterns_written`. The other pages still ground, the evidence watermark is
  stamped (so no new child is paid for the same evidence) and the phase warns.
- A leftover page refused with the same content error on 3 runs, while its
  content and the gbrain version stay the same, is held: it leaves the
  leftover list and appears in `grounding_held`, and the phase keeps warning.
  Editing the page or upgrading gbrain retries it on the next run;
  `gbrain config unset dream.patterns.grounding_holds.<source>` followed by
  `gbrain dream --phase patterns --once --source <source>` retries every held
  page now.
- A page the child only appended timeline entries to is different: those
  entries exist in that run alone. When its write-back is refused, the entries
  and the reflections they are checked against are saved in
  `dream.patterns.grounding_appends.<source>` before the evidence watermark is
  stamped. Every later run retries them first, before the evidence check and
  before any paid child, and reports the retry in `timeline_append_retry`. A
  retry that fails warns (even when the run otherwise skips). After 3 content
  refusals at the same page content and gbrain version the page's entries are
  held: they stay saved, are listed in `grounding_held` with
  `timeline_appends`, and editing the page or upgrading gbrain retries them.
  Don't unset that key: it is the only copy of the entries still to check.
- A lost database connection, a cancelled run, or most pages failing at once
  still fails the phase and holds nothing.

**Say to your agent:** *"Which pattern pages failed quote grounding, and why?"*
The agent reads `grounding_failed` and `grounding_held` from the phase result.

## Cadence

Every maintenance pass writes new reflections, so the evidence check alone
started a paid patterns child on every pass. An in-cycle run (autopilot or a
bare `gbrain dream`) now waits `dream.patterns.min_interval_hours` (default 6)
after the last **completed** run. A timed-out or failed child does not start
the clock, so the next pass retries it.

A skipped run reports `reason: patterns_min_interval` with
`last_completed_at` and `next_eligible_at`, and submits nothing. A direct
`gbrain dream --phase patterns` and `--once` are not held to the interval; a
direct run is paid, so ask the user first.

The stamp is state, not a setting: it lives in
`dream.patterns.last_completed_at.<source>.<incarnation>`, so a re-created
source starts fresh. Reflections from external sources run in their own pass
with their own stamp (the same key plus `.external`), so the owner pass never
holds them back.

```bash
gbrain config set dream.patterns.min_interval_hours 12   # 0 turns the cadence off
```

## Child read budget

A CLI-backed model replays the whole transcript on every turn, so a child that
read every existing pattern page in full could fill half the model window.
The child's `get_page` output is budgeted at
`dream.patterns.child_read_budget_kb` (default 200 KB). The bytes it has read
are counted from the job's own tool-execution ledger, so a resumed job keeps
what it already spent. Past the budget a read returns a short summary
(`truncated: true`, `code: read_budget_exhausted`, the slug, title, type, the
page's `revision` and an excerpt of up to 400 bytes of the rendered page) instead of the page. Writes still work, and
the summary tells the child to append with `add_timeline_entry` instead of
rewriting a page it has not read in full. Reads are sized by the bytes of the
result, never by reading the body, so a segmented page is sized like any
other read. Its summary also names the stored `body_bytes` when the result
carries them (`get_page` with `body: 'none'`).

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
  most half its size. A child the job queue stopped at its own timeout
  (`timeout exceeded` or `wall-clock timeout exceeded`) counts as timed out
  too. A completed run after shrinking restores the estimate.
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

The linear cost model has not been measured on a real paid run yet. It scales
cost with the number of reflections submitted, but a child also reads the
existing pattern pages, so on a brain with many of them the cost falls more
slowly than the reflection count and halving may take several cycles to fit.

## Changelog

- Fix wave 11: budget sizing from `dream.patterns.last_run` (#6177).
- Fix wave 13: a child stopped at its own timeout records `timeout`, so the
  next plan halves (#6296). Timeline entries a child appends with
  `add_timeline_entry` are counted in the phase result as
  `appended_unverified`; unlike pages written with `put_page`, they were not
  quote-verified or provenance-stamped yet (#6302).
- Fix wave 18b: appended timeline entries are quote-verified, their pages are
  provenance-stamped and counted in `patterns_written`; `appended_unverified`
  is deprecated (#6302). In-cycle runs wait
  `dream.patterns.min_interval_hours` after the last completed run, and the
  child's `get_page` reads are budgeted by `dream.patterns.child_read_budget_kb`
  (#6297).
