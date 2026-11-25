# The brain store: the chronicle ledger

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

The store keeps the decision rows (`chronicle_page_state`) and the judge reservations (`chronicle_judge_reservations`)
of the chronicle (`src/core/chronicle/ledger.ts`, `ledger-stats.ts`). The SQL for the PGLite and PostgreSQL engines is in
`src/core/engine-sql/collate-store-reads.ts` (`CHRONICLE_LEDGER_SQL`); the store serves the same members
(`chronicle_ledger.rs`, keys `a 0x0E` for the rows, `a 0x0F` for the reservations and `a 0x10` for their id sequence).

| Member | Returns |
| --- | --- |
| `brain.upsertChronicleRow(w)` | true when the row was written. A row is keyed by `(sourceId, pageId, contentHash, extractorVersion)`; a repeat replaces its decision columns and stamps it now. false when an automatic decision meets a pending or failed backfill row, or when the old row is extracted and no other generation of the page was extracted after it. `state` is `pending`, `skipped`, `extracted` or `failed` and `trigger` is `auto` or `backfill`, otherwise it refuses, as does a NUL byte. The row's source and page must exist (the SQL foreign keys, chronicle-state.md): a missing one refuses `source_not_found` or `page_not_found` and nothing is written |
| `brain.reserveChronicleJudgeSlot(limit, key)` | true when fewer than `limit` reservations were taken in the last 24 hours and one was recorded now; false otherwise. The store's one write transaction stands for the SQL statements' advisory lock |
| `brain.pruneChronicleReservations()` | the number of reservations taken more than 48 hours ago that it deleted, in one write transaction (`reserved_at < now() - interval '48 hours'`); the id sequence keeps its value |
| `brain.readChronicleLedger()` | `{ counts, reasons, calls, principals }` over the automatic rows. `counts` are pending (any age) and extracted, failed and skipped over the last 7 days, with the known spend, the unpriced calls and the incomplete records. `reasons` are `{ state, reason, n }` for skipped and failed rows, by count then byte of reason. `calls` counts the 24-hour reservations. `principals` are the five busiest, by calls then byte of principal (`kind:id`, `unattributed` for a missing kind) |
| `brain.hasChronicleSkipDecision(sourceId, pageId, contentHash, extractorVersion, reason)` | true when the row of that page revision is `skipped` with that reason (`engine-sql/chronicle-events.ts`), false otherwise |

A row written by `upsertChronicleRow` keeps the default cost (none), unpriced (false) and attempts (0), and its
`next_attempt_at` is kept as the text given.

## Executor

`brain.chronicleExecutor(op, args)` serves `chronicleStore()` (`src/core/engine-sql/chronicle-executor.ts`), the
statements the chronicle executor, its campaigns and the event publication ran through `executeRaw`
(`chronicle_ledger/executor.rs`). `op` names the statement and `args` are its arguments in the TypeScript method's
order. Each answers what the statement answers on PGLite:

- the row writes (`queueCampaignRow`, `failExhaustedCampaignRows`, `supersedeStaleRows`, `claim`, `setNextAttempt`,
  `addAttemptCost`, `finish`, `addAttempt`) change the `a 0x0E` row in one write transaction with the statement's
  guards; `claim` writes the lease as ISO text `now + leaseMs` and consumes a campaign attempt;
- the reads (`campaignSpentUsd`, `discoveryPages`, `candidates`, `latestJudged`, `inputFailures`, `eventProducers`) read
  the rows and the pages, in the statement's order where it has one and key order otherwise;
- the event reads (`liveEventSlugs`, `liveEventHashes`, `livePageId`, `eventDiscriminators`, `eventTimelineEntry`) read
  the pages and the timeline (`->>` text as Postgres gives it), and `deleteEventTimeline` removes the timeline rows the
  event page projected and recomputes each depth page's latest entry.

A comparison of `next_attempt_at` with now parses the stored text. A row's `cost_usd` reads as a number, where the SQL
engines read the numeric column as text; callers read it through `Number`.
