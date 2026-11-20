# The brain store: the job status reads

Part of the store contract in [rust/README.md](../../README.md) and of the jobs family ([jobs.md](jobs.md)): the rules
there apply to every method here.

Eleven reads over `minion_jobs` (and `pages`, for one of them) that `gbrain status`, `gbrain jobs stats`, the facts
drain backlog, the source health report and the sync status report ask for. The SQL engines run the statements in
`src/core/engine-sql/jobs-status.ts`; this store answers them from the job rows (`src/jobs/status.rs`). The members are
in `src/core/rust-engine/store-members/jobs-status.ts`, which turns the ISO strings into `Date`s as PGLite returns them.
The cases are in `test/engine-parity/jobs-status.test.ts` and `tests/jobs_status.rs`.

| Member | Answer |
| --- | --- |
| `readLastAutopilotCycles()` | `{ full, targeted }`: the newest completed `autopilot-cycle` row and the newest completed `autopilot-%` row, each `{ finished_at, name, status, started_at, result }` or null. Newest by `finished_at DESC NULLS LAST, id DESC` |
| `countJobsByStatus(filter?)` | `{ status, count }` per status, in status (bytewise) order. A filter is a `name`, a `queue` and a `statuses` list; an absent field matches all, an empty list matches nothing |
| `readWaitingQueueDepths()` | `{ queue, depth, oldest_waiting_age_seconds }` for each queue with `waiting` rows, deepest first, then by queue |
| `readLastCompletedJobAt()` | the largest `updated_at` of a `completed` row, or null |
| `countTtlCancelledByName(like, secs)` | `{ name, count }` of `cancelled` rows whose `error_text` matches the LIKE pattern and whose `finished_at` is inside the window; most first, then by name |
| `readWaitingScopeState({ name, queue, jobId })` | `{ waiting, live_id, age_min }`, always one answer (see below) |
| `countRecentCompletedJobs(name, secs)` | the `completed` rows of a name with `finished_at` inside the window |
| `listRecentFailedJobErrors(secs)` | `{ id, last_error }` of `dead` and `failed` rows with `updated_at` inside the window, by id |
| `listBudgetOwnerJobs()` | `{ owner_id, remaining_cents }` of the newest five rows (by id) that own their budget and are not `completed`, `failed`, `dead` or `cancelled`. The `listBudgetOwners` member answers `[]` when none come back and otherwise refuses: the spend total reads the budget log, which this store does not keep. No admit path writes the budget columns (`budget_remaining_cents`, `budget_owner_job_id`, `budget_root_owner_id`) on any engine: the SQL insert does not name them and their only writer was removed in v0.59.20.0, so none come back today. A seeded Rust brain holds no primary job rows (the shadow seed does not copy `minion_jobs`), so budget owners an older release wrote on Postgres do not carry over and this answer is `[]` by construction. If `minion_jobs` is ever seeded, a source row with budget columns set must carry over equal, or the seed or `listBudgetOwners` refuses by name; never a silent `[]` |
| `readQueuedPageChars({ name, queue, maxChars })` | the average of `LEAST(length(compiled_truth), maxChars)` over the `waiting` and `delayed` rows of a name and queue, joined to their pages; null when none join |
| `readSourceJobCounts(secs)` | per `data.sourceId` over `sync` and `embed-backfill` rows: `failed_24h`, `queue_depth`, `backfill_active`, `backfill_queued`; by source |
| `readEmbedBackfillBySource(ids)` | per requested source: `queued`, `active`, `last_completed_at`; by source |

Windows are seconds, as the TypeScript caller passes them, and cut at `now - round(secs * 1e6)` µs with `>`: a row
exactly on the edge is outside. One call reads one snapshot and one reading of the store's clock.

## Matched to the SQL, on purpose

- `oldest_waiting_age_seconds` is `EXTRACT(EPOCH ...)::int`, which rounds half away from zero; so does the store.
- `countTtlCancelledByName` implements LIKE: `%` is any run, `_` is any one character (so `waitingXttlXexpired`
  matches `waiting_ttl_expired%`), a backslash makes the next character literal, a pattern ending in one is refused
  (`invalid_argument`), and the match is case sensitive and anchored. A NULL `error_text` or `finished_at` never matches.
- `readWaitingScopeState`: the target is the job with that id, name and queue. Its scope is
  `COALESCE(data->>'sourceId', data->>'source_id')`; `waiting` counts the `waiting` rows of the same name and queue in
  that scope, and a NULL scope equals a NULL scope. `live_id` and `age_min` (`floor` of the minutes since
  `started_at`) are set only while the target is `active` with `lock_until > now`. No target: `{ 0, null, null }`.
- `readQueuedPageChars` joins on `data.slug` and `data.sourceId` (`default` when absent). A job with no slug or no page
  adds nothing. A soft-deleted page still counts (the statement never read `deleted_at`). A page whose
  `compiled_truth` is NULL (a segmented shell) counts as `maxChars`, as `LEAST` skips NULL. Lengths are characters.
- A source id of `''` is a source (`IS NOT NULL`), not a missing one.

## Orders the SQL left open

The statements carry the same tiebreakers as the store, so the engines list ties alike: `id DESC` on the autopilot
reads, `queue` on the depths, `name` on the TTL counts, `id` on the failed errors, `status` and `source_id` on the
group-bys (all bytewise, `COLLATE "C"`).

## Differences

- `readQueuedPageChars` averages in `f64`; PostgreSQL averages a `numeric` and casts. The two can differ by one unit
  in the last place on an average that is not a whole division. The parity data divides exactly.
- Every read scans the rows it needs (the status index where the filter allows). The SQL engines also scan.
