# The brain store: the chronicle backfill and advisor reads

Part of the telemetry family ([telemetry.md](telemetry.md)); the rules in [rust/README.md](../../README.md) ("The brain
store") apply.

`chronicle_backfill` (`src/core/chronicle/backfill.ts`, `campaign.ts`) and the advisor's chronicle collector
(`src/core/advisor/collect-chronicle.ts`) read and write through the members below, beside `upsertChronicleRow`
([chronicle-ledger.md](chronicle-ledger.md)). The SQL for the PGLite and PostgreSQL engines is in
`src/core/engine-sql/chronicle-reads.ts`; the store serves the same members from `chronicle_reads.rs`, over the pages,
the timeline entries and the ledger rows (`a 0x0E`).

| Member | Returns |
| --- | --- |
| `brain.readChronicleBackfillBatch(q)` | The live pages after `afterId`, in id order, at most `pageBatch` (the SQL's `LIMIT 500`): a page whose type is in `types` or whose slug matches a `slugPatterns` entry (`LIKE`), in the source list (when not empty), else the one source, else every source, and updated on or after `since` (a date) when given. Each row has `compiled_truth` (the stored body, else the segmented truth lead), `frontmatter`, `effective_date` (ISO text), `effective_date_source`, `content_hash` and `done`: a ledger row of the page id at its content hash and `extractorVersion` that is extracted, or a pending or failed backfill row with fewer than `maxAttempts` attempts (the SQL's `5`) |
| `brain.queueChronicleCampaignRow(w)` | true when the row was queued: a new pending backfill row stamped with the campaign, or the row at the same key restarted as this campaign's (zero attempts, no lease, no principal, now). false when the old row is a pending or failed backfill row with attempts left (its stamped limit, else `defaultMaxAttempts`), a pending or failed row with attempts whose lease (`next_attempt_at`) is still ahead, or extracted content no newer generation of the page replaced. The cost, unpriced, events and judge columns of an existing row are kept. The amounts are numeric text, as the SQL engines bind them. A missing source or page refuses `source_not_found` or `page_not_found` (checked in that order) and writes nothing; the TS member throws it as the SQL foreign key does (code `23503`, `chronicle_page_state_source_id_fkey` or `chronicle_page_state_page_id_fkey`). A NUL byte refuses |
| `brain.readChronicleCampaignSpentUsd(campaignId)` | The sum of `cost_usd` over the campaign's rows; 0 for none |
| `brain.listChronicleCoverageGapPages()` | The live `meeting`, `conversation` and `calendar-event` pages updated in the last 30 days with no timeline entry that links an event page, in id order: `type`, `effective_date` (ISO text), `effective_date_source`, and `fm_date` and `fm_start` as `frontmatter->>` reads them |

The doctor and advisor rollup `readChronicleLedgerStats` is served from `brain.readChronicleLedger()`
([chronicle-ledger.md](chronicle-ledger.md)), shaped as `src/core/engine-sql/doctor-acc.ts` shapes its four statements.
