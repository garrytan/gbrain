# auto_chronicle date quality (`capy/chronicle-date-quality`, v0.60.49.0)

The gbrain-evals off-versus-on lift eval (garrytan/gbrain-evals#62, foresights
`739e5cc`) failed auto_chronicle's quality gate: 0.96 false + premature events
per judged labeled page against a gate of 0.20. Two patterns caused it:

- **CL-1, premature events.** Plans, follow-ups and scheduled meetings in a
  past page were written as events on their future dates.
- **CL-2, invented days.** A vague past date became a specific day ("back in
  2024" → 2024-01-01, "last month" → the first of the month).

## Fix

1. **Prompt.** The judge extracts only what happened by the end of the page's
   day, dates a commitment on the meeting day rather than its due date, and
   writes a vague past date at its real precision (`2024`, `2026-03`).
2. **`future_dated` (deterministic).** A proposal dated after the page's own
   day is dropped before publication. The page's own day is the latest of the
   eligibility date (authored effective date, else frontmatter `date`/`start`),
   a calendar invite's `end` and a conversation's last parsed message, as a
   day in `chronicle.tz`; a date-only value keeps its own day in every time
   zone. Nothing after today passes either, which also bounds undated pages.
3. **`date_imprecise` (deterministic).** A proposal whose `when` has no day
   (`YYYY`, `YYYY-MM`) is dropped. The schema has no date precision:
   `timeline_entries.date` is `DATE NOT NULL`, event slugs and `event_date` are
   days, and `chronicle_day`/`since`/`last_seen` read days. Storing a partial
   date would need a precision column and changes to every reader, so the
   extractor drops it rather than invent a day. No migration.
4. **Reporting.** Drops are counted in the phase result's `events_dropped`,
   the row outcome and the direct extractor result. A page whose every
   proposal was dropped records the drop reason on its extracted ledger row
   (and counts as `no_events` in the phase details). Both codes are
   `CHRONICLE_REASONS` entries and `chronicle_skipped` reasons.

`CHRONICLE_EXTRACTOR_VERSION` is unchanged: bumping it would re-extract every
page once at one paid call each. Existing premature events are retired when
their page is extracted again.

## Measured run

gbrain-evals branch `capy/eval-repin-739e5cc` (`chronicle-lift.ts run --arms
on-a --no-qa`), corpus amara-life-v1 (48 judged pages; 38 labeled events on
28 meeting and calendar pages; 96 controls), judge
`anthropic:claude-sonnet-4-6`, `node_modules/gbrain` pointed at each checkout.
Scored with `chronicle-lift.ts score --review` and the published
`review.json`; unmatched events the published review did not cover were
classified by hand with the same rubric. Counted strictly, as the published
review does, a quarter result dated on the meeting that discussed it is false.

| | master `5bd9e849` | branch, run 1 | branch, run 2 |
|---|---|---|---|
| Recall | 35/38 (92.1%) | 38/38 (100%) | 38/38 (100%) |
| Meetings / invites | 15/18, 20/20 | 18/18, 20/20 | 18/18, 20/20 |
| Premature | 26 | 0 | 0 |
| False | 5 | 2 | 3 |
| False + premature per judged labeled page | 1.11 | 0.07 | 0.11 |
| Slack events dated after their page | 32 of 299 | 0 of 227 | 0 of 236 |
| Dropped `date_imprecise` / `future_dated` | — | 9 / 0 | 6 / 0 |
| Events written | 386 | 303 | 315 |
| Control pages judged | 0 | 0 | 0 |
| Metered cost | $0.5719 | $0.5044 | $0.5112 |

The false events on master: two quarter results on the meeting day, one
"back in 2024" on 2024-01-01, and the two the published review already
classified. On the branch every false event is a quarter result on the meeting
day ("CarbonLoop Q1 revenue reported at $2.1M", "Meridian Labs Q1 numbers came
in strong"). Read as statements made at the meeting, each run has one.

In both branch runs the prompt alone kept every proposal on or before its
page's day, so `future_dated` dropped nothing; the deterministic rule is the
guarantee for models and pages where the prompt does not hold, and the unit
and E2E tests exercise it. `date_imprecise` dropped 9 and 6 proposals.

Total provider spend: $1.59.

The labeled 31-page fixture from the auto_chronicle fix wave
(`capy-fix-wave-chronicle.md`) is not committed, so it was not rerun.
`foresights eval chronicle` (deterministic): 6/6.
