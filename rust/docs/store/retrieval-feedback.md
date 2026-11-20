# The brain store: retrieval feedback

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

The store keeps the five tables of use-attributed retrieval feedback (migration v207): `retrieval_events`,
`retrieval_event_pages`, `retrieval_event_links`, `retrieval_feedback` and `retrieval_weights`. The SQL for the PGLite and
PostgreSQL engines is in `src/core/engine-sql/collate-store-reads.ts` (`RETRIEVAL_FEEDBACK_SQL`); the store serves the same
members (`retrieval_feedback.rs`, keys `a 0x04` to `a 0x08`).

| Member | Returns |
| --- | --- |
| `brain.insertRetrievalEvents(events)` | null. Each event is `{ id, client_id, op, pages, links }`. A repeated id keeps its row. A page is kept when its page row exists (a soft-deleted page counts); a link when its target and both ends of its edge key (the text before the first `\|` and after the last) are page rows. A repeated page or link keeps its row. An `op` outside `query`, `search`, `think`, `synthesize`, `recall` refuses with `constraint_violation` |
| `brain.readRetrievalEvent(id)` | `{ id, client_id, op, created_at, pages, links }` or null. Pages come by rank; links by source id, edge key and target in byte order (`COLLATE "C"`) |
| `brain.applyRetrievalRatings(args)` | one row per stored rating of the batch: `{ kind, source_id, key, rating, weight_before, weight_after, newly_applied }`. `args` is `{ eventId, clientId, signal, alpha, targets }`. A target whose page (or both link ends) is missing is skipped. A rating is stored once per `(event, signal, element)`; only a newly stored one moves the weight, by `alpha` toward `(rating - 1) / 4`, from half the learned deviation when the page's content hash changed. A missing event, or a rating outside 1 to 5, refuses with `constraint_violation` |
| `brain.readFeedbackStatus()` | `{ counts, lowest, highest }`: the counts, the last rating time and the top client's share of the week's explicit ratings; the ten lowest and the ten highest page weights, ties by source id and key in byte order |

Weights are `REAL`: the store computes them as `f32`, as Postgres does, and returns the shortest decimal that reads back
as the `f32` (a rating of 1 from neutral at alpha 0.6 stores `0.19999999` on both).

Not served: the weight reads of `readWeights` and `currentPageHashes`, the recent-rating count, the retention prune, the
weight reset and the purge scrub (`src/core/feedback/store.ts`): they are `executeRaw` statements, which a Rust brain
refuses. A page delete on the Rust store does not touch these records (the SQL engines scrub purged slugs); the store does not serve source delete yet, which cascades to the weights on the SQL engines.
