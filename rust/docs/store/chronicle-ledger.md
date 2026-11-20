# The brain store: the chronicle ledger

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

The store keeps the decision rows (`chronicle_page_state`) and the judge reservations (`chronicle_judge_reservations`)
of the chronicle (`src/core/chronicle/ledger.ts`, `ledger-stats.ts`). The SQL for the PGLite and PostgreSQL engines is in
`src/core/engine-sql/collate-store-reads.ts` (`CHRONICLE_LEDGER_SQL`); the store serves the same members
(`chronicle_ledger.rs`, keys `a 0x0E` for the rows, `a 0x0F` for the reservations and `a 0x10` for their id sequence).

| Member | Returns |
| --- | --- |
| `brain.upsertChronicleRow(w)` | true when the row was written. A row is keyed by `(sourceId, pageId, contentHash, extractorVersion)`; a repeat replaces its decision columns and stamps it now. false when an automatic decision meets a pending or failed backfill row, or when the old row is extracted and no other generation of the page was extracted after it. `state` is `pending`, `skipped`, `extracted` or `failed` and `trigger` is `auto` or `backfill`, otherwise it refuses, as does a NUL byte |
| `brain.reserveChronicleJudgeSlot(limit, key)` | true when fewer than `limit` reservations were taken in the last 24 hours and one was recorded now; false otherwise. The store's one write transaction stands for the SQL statements' advisory lock |
| `brain.readChronicleLedger()` | `{ counts, reasons, calls, principals }` over the automatic rows. `counts` are pending (any age) and extracted, failed and skipped over the last 7 days, with the known spend, the unpriced calls and the incomplete records. `reasons` are `{ state, reason, n }` for skipped and failed rows, by count then byte of reason. `calls` counts the 24-hour reservations. `principals` are the five busiest, by calls then byte of principal (`kind:id`, `unattributed` for a missing kind) |

A row written here keeps the default cost (none), unpriced (false) and attempts (0), and its `next_attempt_at` is kept as
the text given. Not served: the campaign, retry and result writers of the ledger and `pruneChronicleReservations`
(`executeRaw` statements, which a Rust brain refuses).
