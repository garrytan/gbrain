# The brain store: the chronicle-backfill page batch

Part of the generations family ([generations.md](generations.md)); the rules in [rust/README.md](../../README.md) ("The
brain store") apply.

`chronicle-backfill` (`src/core/chronicle/backfill.ts`) scans pages through the member below. The SQL for the PGLite
and PostgreSQL engines is in `src/core/engine-sql/chronicle-reads.ts`; the store serves it from `chronicle_reads.rs`,
over the page records.

| Member | Returns |
| --- | --- |
| `brain.readChronicleBackfillBatch(q)` | The live pages after `afterId`, in id order, at most `pageBatch` (the SQL's `LIMIT 500`): a page whose type is in `types` or whose slug matches a `slugPattern` (`LIKE`), in `sourceIds` (when not empty) or else `sourceId` (when set), updated on or after `since` (a date, midnight UTC) when set. Each row is `{ id, source_id, slug, type, compiled_truth, frontmatter, effective_date, effective_date_source, content_hash, done }`; `compiled_truth` falls back to the truth lead, `effective_date` is ISO text. `done` reads the ledger row at the page's content hash and extractor version (`chronicle_ledger.rs`, [chronicle-ledger.md](chronicle-ledger.md)): true when it is extracted, or a pending or failed backfill row with fewer than `maxAttempts` attempts. |

A real backfill queue (`--yes`) writes the ledger through `upsertChronicleRow` ([chronicle-ledger.md](chronicle-ledger.md)).
