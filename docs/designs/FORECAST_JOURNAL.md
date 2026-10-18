# Private forecast journal (wave 4b W7)

Status: all four slices in #6886. Plan: gbrain-evals `docs/plans/2026-10-07-10x-memory-advantage/PLAN.md`, wave 4, row W7.

W7 makes each prediction in a brain auditable for its owner: what was predicted, when, by when it had to come true, how it was resolved and on what evidence, and how many predictions are still open. It extends `takes_scorecard` and `gbrain takes scorecard` instead of adding a `track_record` op. Everything new is private, which means trusted local only. `takes_scorecard` keeps returning exactly what it returns today to remote callers. Nothing public about real people ships from this wave.

## Slice 1 (this change): the horizon

The horizon of a take is the last day its claim can come true: `2024-12-31` for "by the end of 2024", `2024-09-30` for "by Q3 2024". Without it, the journal cannot tell a prediction that is overdue from one that is still open.

**Where it lives.** It goes in a table of its own, `take_horizons`, one row per take (migration v251 for now; the number is taken when the merge slot is called). It does not go in either of the two obvious places:

- **The takes fence.** Changing the fence format would make sync hold files. Garry's decision is an additive DB column, not a fence-format change.
- **A column on `takes`.** `takes_list` and `takes_search` return `t.*`, so a new column would reach remote callers. That would break the rule that remote output stays the same, and it would leak a private field.

| Column | Type | Meaning |
|---|---|---|
| `take_id` | `BIGINT PRIMARY KEY REFERENCES takes(id) ON DELETE CASCADE` | The take. The row is deleted when its take is. |
| `claim_sha256` | `TEXT NOT NULL` | The sha256 of the claim the horizon was set for. If the claim is later edited, the row stays as written but reads as not current, so a horizon never carries over to a different proposition. |
| `horizon_date` | `DATE NOT NULL` | The last day the claim can come true. |
| `basis` | `TEXT NOT NULL`, one of `stated`, `stated_relative`, `owner` | How the horizon was set (see below). |
| `set_at` | `TIMESTAMPTZ NOT NULL DEFAULT now()` | When it was set. |

The three bases:

- `stated` is an absolute deadline in the claim's own words: "by the end of 2024", "by the end of Q1 2025", "by Q3 2024", "by March 2025", "before 2025", "by 2026".
- `stated_relative` is "within N months" or "within N years", counted from `since_date`. It is only as certain as `since_date`. On a source without recording, that date is the uncertified one, and the journal labels it `uncertified` (Garry, 2026-10-17).
- `owner` is set by the owner. A scan never overwrites it.

**No page text is stored.** The table holds dates, an enum, a hash and a timestamp. That keeps it outside the purge surface (`text_free_ledger` in the deletion inventory). Graduation copies it as user data. Postgres's RLS event trigger covers it.

**Nothing is written on upgrade.**

- `gbrain takes horizon scan` lists each take's stated horizon. It writes them only with `--apply`.
- `gbrain takes horizon set <slug> --row N --date YYYY-MM-DD` and `clear` are the owner's own edits.
- None of these has an MCP op. A thin client refuses them as host-bound.
- The parser returns nothing in three cases: when a claim states no deadline, when it states two different deadlines, or when it states a relative deadline without a usable `since_date`. It does not guess.

**What stays the same.** `takes_list` and `takes_scorecard` return byte-identical output, locally and to remote callers, whether or not horizons exist. Tests on PGLite and Postgres check this.

## Slice 2: prediction time and the journal

`src/core/forecast-journal.ts` reads every active take that is not a fact as a prediction.

**Prediction time.** The prediction time is when the belief ledger recorded the exact claim (claim, kind and holder) on its page:

- **A take added after its page was created** has a live `take.asserted` event. Its first one gives the time.
- **A take the page was created with** has no event of its own, because a page creation is one `page.published` snapshot (BELIEF_LEDGER.md section 4). Such a take gets the snapshot's time, but only when the ledger has recorded the source without a stop or restore since then, with no drift mark on the page. Otherwise the take could have been added while the ledger was not recording, so it falls back.
- **A take whose first event is `take.transferred`** came from another page. It gets no recorded time.

A recorded time is certified only where `coverageAt` certifies that instant, which means a managed source. Every other take shows its `since_date`, labelled `uncertified`. Tests on PGLite and Postgres cover four cases: a managed source (certified), an unmanaged one (recorded, uncertified), a take added later, and a coverage stop. A forced probe fails the stop case when the guard is removed.

**The journal.** `gbrain takes journal` (trusted local) shows each prediction with:

- its time and certification;
- its claim, holder and weight;
- its horizon and basis;
- its state: `resolved`, `overdue`, `open` or `undated`;
- its resolution: quality, `resolved_by` and `resolved_source`.

It filters by `--holder`, `--about <slug-prefix>`, `--state`, `--since`, `--until` and `--source-id`, and `--limit` caps the list. The totals always count every match, so the unresolved denominator survives any filter on state or limit. A thin client refuses it as host-bound. There is no MCP op. Each entry also carries `grade`: the newest verdict `grade_takes` cached for the take (W6, the one `gbrain takes grades` lists), applied or not, with `judge_measured` saying whether the W6 eval measured its judge and prompt.

## Slice 3: `takes_scorecard {group_by}`

With `group_by` set to `holder` or `source`, a trusted local caller gets the plain card unchanged plus two additions.

**`groups`** has one row per group, with:

- `n`, `correct`, `incorrect`, `partial` and `unresolvable`;
- `accuracy`;
- `accuracy_shrunk`: a Beta prior of 10 pseudo-observations centred on the pooled accuracy;
- `accuracy_wilson95`;
- `accuracy_recent`: weighted by a 365-day half-life since resolution;
- `brier` and `brier_skill`: skill is measured against the group's own base rate;
- `citations`: resolutions that name a source;
- `open`, `overdue`, `undated` and `unresolved`;
- `low_n`: below `min_n`, which defaults to 10.

**`journal`** holds the journal totals.

A remote caller that passes `group_by` or `min_n` is refused with `scorecard_group_by_local_only`. Without them, its output is what it was. `gbrain takes scorecard --group-by holder|source [--min-n N]` is the CLI form, and thin clients refuse it.

## Slice 4: the $0 gate

`evals/forecast-journal/`: the preregistration was frozen before the scored run. The gate uses 20 seeded cohorts of placeholder holders with known skill, 5,622 predictions in all. It passed:

- median Spearman ρ of 0.905;
- who-was-right set-F1 of 1.000;
- exact denominator, `low_n` and labelling counts;
- 8/8 remote probes.

The details are in that directory's README.

The resolution policy for auto-resolve is out of W7's scope. Garry's decision (2026-10-16) is recorded with the take-grading follow-ups in gbrain-evals: a take whose numeric target was missed is never auto-applied, neither as `partial` nor as `incorrect`. It is held for manual review until the real sample settles which.
