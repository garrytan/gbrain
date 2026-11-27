# The brain store: Extract bookkeeping

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

The extract steps (extract_atoms, extract_facts, synthesize_concepts) write an audit receipt page per run and add
each run's events to a 7-day rollup that doctor's `extract_health` reads (`src/core/extract/receipt-writer.ts`,
`rollup-writer.ts`; the SQL is in `src/core/engine-sql/extract-bookkeeping.ts`). The store serves the receipt write's two
page reads and the rollup upsert, in `extract_bookkeeping.rs`. The 7-day readers `readExtractRollup7d`, `listRecordedHaltReasons7d` and
`readExtractKindRollup7d` (`src/core/rust-engine/store-members/doctor-derived.ts`) read the store's row list,
`brain.listExtractRollupDays`, from `CURRENT_DATE - 7` (UTC) and aggregate it in TypeScript as the SQL does: kinds in
byte order, `SUM(cost_usd)` in single precision, and the last halt age in days.

| Key | Value | Mirrors |
| --- | --- | --- |
| `A 0x0A <kind> 0x00 <source_id> 0x00 <day YYYY-MM-DD>` | `{ kind, source_id, day, cost_usd, halt_count, eval_fail_count, eval_pass_count, round_completed_count, expected_limit_count, rollup_write_failures, halt_reasons, updated_at_us }` (JSON) | an `extract_rollup_7d` row; the key is its `PRIMARY KEY (kind, source_id, day)` |

The table has no foreign key, so a deleted source keeps its rows, as in Postgres. `cost_usd` is a `real`: the store keeps
an `f32` and adds in `f32`. The counts are `int`: an add past the 32-bit range refuses (`invalid_argument`, "integer out
of range"), and the row is unchanged.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.readExtractReceiptSlot(sourceId, slug)` | `{ type, source_path, source_uri, withheld_source_path }` of the page the slug holds in the source, live or a tombstone, or null. The store keeps no withheld origin, so `withheld_source_path` is null | `readExtractReceiptSlot` |
| `brain.readExtractReceiptSeal(sourceId, slug, safeVersion)` | `chunker_version >= safeVersion AND text_projection_revision = knowledge_revision` with SQL's three-valued AND: true, false, or null when either side is unknown; null for no page | `readExtractReceiptSeal` |
| `brain.upsertExtractRollupDay({ kind, sourceId, day, costUsd, haltCount, evalFailCount, evalPassCount, roundCompletedCount, expectedLimitCount, rollupWriteFailures, haltReason })` | nothing. Stores the row, or adds each delta to the stored one; a `haltReason` adds `haltCount` to that bucket of `halt_reasons` (none: the buckets stay). A NUL byte in a kind, source or reason, or a day not `YYYY-MM-DD`, refuses | `upsertExtractRollupDay` |
| `brain.listExtractRollupDays(since)` | the rows of days on or after `since`, in `(kind, source_id, day)` order | the rows `readExtractRollup7d`, `listRecordedHaltReasons7d` and `readExtractKindRollup7d` aggregate |

The TypeScript member refuses the pre-v141 statement (`preV141`): the store schema always has `expected_limit_count`.
