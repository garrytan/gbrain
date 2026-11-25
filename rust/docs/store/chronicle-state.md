# The brain store: the write-time chronicle decision reads

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

The write-time chronicle decision (`recordChronicleDecision` in `src/core/chronicle/ledger.ts`) writes its row with
`upsertChronicleRow` ([chronicle-ledger.md](chronicle-ledger.md)) and reads through the members below. The SQL for the
PGLite and PostgreSQL engines is in `src/core/engine-sql/chronicle-ledger.ts` (`CHRONICLE_STATE_SQL`); the store serves
the same members from `chronicle_state.rs`, over the ledger rows (`a 0x0E`) and the judge reservations (`a 0x0F`).

| Member | Returns |
| --- | --- |
| `brain.readChronicleRow(key)` | The ledger row at `(sourceId, pageId, contentHash, extractorVersion)` with every column, or null. `decided_at` and `updated_at` are ISO text; the TS member turns them and `next_attempt_at` into `Date`, as the SQL engines answer them |
| `brain.hasPendingAutoChronicleRow(sourceId, pageId, extractorVersion)` | Whether a row of the page at that extractor version is `pending`, `auto` and not `no_extract`, at any content hash (the row `add_link` carries to the revision it publishes) |
| `brain.hasExtractedEvents(sourceId, pageId)` | Whether any row of the page is `extracted` |
| `brain.countRecentChronicleReservations()` | The judge reservations taken in the last 24 hours (`chronicleDailyRemaining` subtracts it from the daily limit) |
| `brain.readPageTruthLead(pageId)` | The page's stored `truth_lead` (a segmented page's body prefix), or null for a page with none or no page |
| `brain.insertConfigIfAbsent(key, value)` | true when the key had no value and `value` was stored; false when a value stays. The TS member answers nothing, as the SQL `ON CONFLICT DO NOTHING` does |

The TS member `upsertChronicleRow` calls `brain.upsertChronicleRowChecked(row)`; the store's `brain.upsertChronicleRow(row)` is the same checked upsert. Both run behind the SQL
engines' foreign keys. A row whose source is missing refuses `source_not_found` and one whose page is missing refuses
`page_not_found` (checked in that order, as the `source_id` and `page_id` references are), and nothing is written. A
soft-deleted page keeps its `pages` row, so its decision is recorded. The check and the upsert run under one writer: the
bound transaction when the brain is in one, else a transaction the call opens. An update keeps the row's
`event_slugs`, `event_hashes`, `cost_attempts` and judge-window columns and clears the campaign stamp
(`campaign_id`, `attempt_cap_usd`, `max_attempts`, `pricing_policy`, `campaign_max_usd`), as the SQL `DO UPDATE` does.

A page delete removes the page's ledger rows and a source delete removes the source's (`cascade.rs`), as the
`ON DELETE CASCADE` references do. The judge reservations stay after either delete on every engine:
`chronicle_judge_reservations` has no reference to a page or source. On this engine no writer takes a reservation yet
(`reserveChronicleSlot` and `pruneChronicleReservations` stay `executeRaw` statements, which a Rust brain refuses), so
`countRecentChronicleReservations` answers 0 there.
