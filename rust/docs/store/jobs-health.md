# The brain store: queue health reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here. The rows are the ones in [jobs.md](jobs.md).

The reads `gbrain doctor`'s queue checks (`queue_health`, `wedged_queue`, `orphaned_private_queue`), the advisor's stalled-jobs collector and the submit-time queue probe make of `minion_jobs`. The TypeScript statements are in `src/core/engine-sql/jobs-health.ts`; the store module is `rust/crates/gbrain-store/src/jobs/health.rs`, the binding `rust/crates/gbrain-napi/src/families/jobs/health.rs` and the members `src/core/rust-engine/store-members/jobs-health.ts`. All eight are reported under the capability `minion_queue`.

Every window and cut-off is an argument. The clock is the store's, read once per call. Counts cross the binding as numbers.

| JS | Resolves |
| --- | --- |
| `brain.readQueueHealthSignals(spec)` | `{ stalled, depth, rss_kills, prompt_too_long, old_embed_backfill }`. `spec` is `{ waitingThreshold, oldWaitingHours, windowHours, stalledAfterHours }`. `stalled`: up to 5 active rows started more than `stalledAfterHours` ago (oldest first, `total` on each row). `depth`: up to 5 `(name, queue)` groups of waiting rows deeper than `waitingThreshold`. `rss_kills`: dead or failed rows finished inside the window with error `aborted: watchdog`. `prompt_too_long`: dead `subagent` rows finished inside the window with an error starting `prompt_too_long:`, counted by dream phase. `old_embed_backfill`: waiting `embed-backfill` groups whose oldest row is older than `oldWaitingHours` |
| `brain.listWaitingByQueue()` | `{ queue, depth, oldest_age_seconds }` for every queue with a waiting row, the deepest first |
| `brain.readQueueDivergence({ windowHours, ttlReasonPrefix })` | `{ divergence, ttl_cancelled }`: per name with a waiting row, the rows created and the rows completed inside the window; per name, the rows cancelled inside the window with an error starting `ttlReasonPrefix` |
| `brain.listQueueWedgeCounts()` | per queue outside the `dream-inline-` queues: live-lock active rows, waiting rows and the minutes since the latest completion |
| `brain.listPrivateQueueHealth()` | per `dream-inline-` queue: the smallest `data.source_id`, live-lock active, waiting-class (`waiting` and `delayed`) and paused rows, the minutes since the oldest waiting-class row and the oldest row's `created_at` in epoch milliseconds |
| `brain.readWedgeSignals(queue, handlerNames)` | one queue's `{ stalled, activeHealthy, waiting, waitingClaimable, lastCompleted, lastCompletedClaimable }`; the two dates are `Date`s (ISO text across the binding) |
| `brain.readOldestWaitingAge(queue)` | whole seconds since the oldest waiting row of the queue was created, or null |
| `brain.countWaitingJobs(excludeFactsAbsorb)` | the number of `waiting` rows, without the `facts-absorb` rows when `excludeFactsAbsorb`. The readiness worker probe passes `true` only on PGLite, so a Rust brain counts its `facts-absorb` jobs as a SQL Postgres brain does |
| `brain.listStuckActiveJobsByName()` | `{ name, n }` for the active rows whose lock lapsed or whose stalled counter reached 2, the most first |

Ordering and other engine differences:

- The SQL engines retain the original statements without added COLLATE clauses or SQL tie-breaks. The shared TypeScript helpers apply bytewise ordering to returned rows where implemented; they do not stabilize which tied rows SQL selects before LIMIT 5, and stalled rows retain their SQL order. The Rust store breaks ties deterministically, so tied results can differ between engines.
- A private queue's source_id is min(data->>'source_id') under the database collation on the SQL engines and the bytewise smallest value on the Rust store; these can differ.
- `readQueueHealthSignals.stalled` no longer returns `started_at`; the check uses the id, name and total only.
- Seconds are rounded half away from zero, as `EXTRACT(EPOCH FROM interval)::int` does.
- `opts.signal` of `readWedgeSignals` and `readOldestWaitingAge` cancels the statement on PGLite and PostgreSQL. A store call cannot be cancelled, so the Rust engine ignores it; the probe's own timeout still bounds the wait.
- `wedged_queue` stays PostgreSQL-only in the doctor: a Rust brain reports "no queue to check", as PGLite does, and never reaches `listQueueWedgeCounts` through the doctor.
- The live cycle lock read of `orphaned_private_queue` is the existing `readCycleLocks`, filtered in TypeScript; its acquisition time is epoch milliseconds from `acquired_at`, so it loses sub-millisecond precision. The check compares it with a 60 s skew tolerance.
