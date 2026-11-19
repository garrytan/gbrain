# The brain store: export reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements `gbrain export` ran through `executeRaw` (`src/commands/export.ts`,
`src/core/export-snapshot.ts`, the segmented-body reads of `src/core/page-body/read-range.ts` and the folder-rule read
of `src/core/access/policy-transfer.ts`). PGLite and Postgres run the same SQL as before, now in
`src/core/engine-sql/export-reads.ts` and `transaction-settings.ts`. The store answers from its records
(`crates/gbrain-store/src/cli_reads/export.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/cli-reads-export.ts`.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.listExportPageKeys({ afterId, sourceId, type, slugPrefix })` | the next 256 live pages after page id `afterId` (a decimal string), by id, within the source, type and slug prefix (`null`: any): `{ id, segmented, slug, source_id, source_path, source_path_bytes, raw_count, bytes }`. `slug` and `source_path` keep their first 4,097 characters; `bytes` is the body (a segmented page's `body_bytes`), frontmatter jsonb text, title, slug, source path, raw rows and tags in bytes, `null` when an inline body column is `null` | `listExportPageKeys` |
| `brain.readExportWithdrawalLedgerBytes(sourceId)` | the source's withdrawal ledger in bytes: for each withdrawal, the jsonb text of `{ visibility, fact_hash, withdrawn_at, subject }` (keys in jsonb order, the time as `2026-01-03T00:00:00+00:00` in UTC) plus 1, then plus 2 | `readExportWithdrawalLedgerBytes` |
| `brain.listExportWithdrawals(sourceId)` | the source's withdrawals by `visibility`, `fact_hash`, `subject` (byte order): `{ visibility, fact_hash, withdrawn_at, subject, purged }`, `withdrawn_at` an ISO string (the member makes it a `Date`), `purged` always `false` | `listExportWithdrawals` |
| `brain.readExportPageRows(ids)` | the live pages among `ids` (decimal strings), in the order given, each `{ page, tags }`: `page` as `getPage` gives it, `tags` in byte order. An id that is not an integer refuses | `readExportPageRows` |

## What the store does not keep

- **A statement timeout.** `setLocalStatementTimeout(ms)` does nothing on the Rust engine: the store has no statement
  timeout. It refuses an `ms` that is not a non-negative integer, and refuses on a transaction that has ended, as the
  other transaction members do. It runs only in TypeScript and has no store method.
- **Purge tombstones.** The store keeps no `fact_purges` rows, so `listExportWithdrawals` lists withdrawals only, each
  with `purged` false: what Postgres gives for a brain that never purged a fact.
