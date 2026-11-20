# The brain store: doctor-derived reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that doctor checks, the repair scans and the purge ran through `executeRaw` (second set, after
[cli-reads-doctor.md](cli-reads-doctor.md)). PGLite and Postgres run the same SQL as before
(`src/core/engine-sql/doctor-derived.ts`; the text is pinned by `test/doctor-derived-sql.test.ts`). The store answers from the records
each statement read (`crates/gbrain-store/src/cli_reads/doctor_derived.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/doctor-derived.ts`.

A doctor-derived member answers one of three ways on the Rust engine:

1. Served from the store's records (the table below).
2. Empty, with no store call, because the store keeps no writer for a relation the statement reads. No Rust brain ever holds a
   row there, so the empty answer is the one PGLite gives a brain that never wrote one. The relations: `belief_events`,
   `page_extraction_state`, `derived_generations`, `derived_generation_items`, `derived_generation_activations`,
   `extract_rollup_7d`. Members: `listRecordedTombstones`, `listAmbiguousExtractionInputs`,
   `countLedgerCoveredAtomRetirements`, `listLiveGenerationRetirements`,
   `listHeldGenerations`, `listPendingGenerationMembers`, `listOrphanGenerationCandidates`, `readExtractRollup7d`,
   `listRecordedHaltReasons7d`. If a Rust writer for one of these relations lands, its member must move to the first kind in the
   same change.
3. Refused with `engine_capability_missing` (the member is not in `STORE_MEMBERS`). `TODOS.md`, "Rust engine lane 14 follow-ups",
   lists each one with what it needs. `listBudgetLimitedRows` and `readBudgetHoldAge` (the `page_embedding_budget` reads) refuse
   by name: this store keeps no page embedding ledger, and an empty answer would tell doctor `partial_embedding` and
   `gbrain embed --stale` that no large page waits for approval without reading anything.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countSafeIndexPending(sourceIds?)` | `{ rebuildable, kept }` of live pages in unarchived sources chunked below the safe-chunk fence | `countSafeIndexPending` |
| `brain.countPagesByTypeAndOwner(sourceIds?)` | `{ src, type, own, n }` per source, type and writer ownership, `n` as text | `countPagesByTypeAndOwner` |
| `brain.listImageAssetFiles()` | the first 1000 `image/*` file rows by file id, with source root and page source path | `listImageAssetFiles` |
| `brain.listRestorableAtomRetirements(sourceIds)` | per source: restorable re-extraction retirements, origins, oldest and newest `retired_at`, hold end | `listRestorableAtomRetirements` |
| `brain.listTimelineHistoryBatch(sourceIds, afterId)` | the next 200 live inline pages after `afterId` that hold an own timeline row | `listTimelineHistoryBatch` |
| `brain.readPageCompiledTruths(ids)` | `{ id, body }` of the named pages (deleted ones too), by id | `readPageCompiledTruths` |
| `brain.listAtomFenceCandidates({ sourceIds, atomId, after, limit })` | live world atoms whose live origin page is unread or names a facts or takes fence | `listAtomFenceCandidates` |

## How each read follows the SQL

- `countSafeIndexPending`: a page counts when it is live, its source exists and is not archived (`s.archived IS NOT TRUE`), and its
  chunker version is below `SAFE_FENCE_CHUNKER_VERSION`. A record with no version counts as below it, as `safeChunksFilter` does.
  `rebuildable` is `page_kind = 'markdown'` or a code page with a `file` frontmatter key or a source path.
- `countPagesByTypeAndOwner`: live pages grouped by source, stored type and `WRITER_OWNED_PAGE_SQL`. The SQL orders by source
  only; the store orders by source, type, owner, so a caller must not depend on the order inside a source.
- `listImageAssetFiles`: `files` rows by file id whose mime type starts `image/`; the source root is `sources.local_path` of the
  file's source (null when the source row is gone) and the page source path is the file's page's `source_path`, soft-deleted pages
  included. `metadata` comes back as the JSON the store keeps (key order is Postgres jsonb order).
- `listRestorableAtomRetirements`: the store's `restorable_atoms` rule (the same one the purge hold uses) over the pages of the
  named sources. The store keeps no generation ledger, so no retirement is ledger-covered and every restorable one is listed.
  `oldest` and `newest` are the min and max of the `retired_at` text by bytes. `hold_until` is the oldest `deleted_at` of the
  group plus 30 days, whole seconds, UTC.
- `listTimelineHistoryBatch`: an inline page is one with stored text (a segmented page has NULL `compiled_truth` and `timeline`).
  An own row is a timeline entry with no event page.
- `listAtomFenceCandidates`: the origin page is the live page of the atom's source whose slug is the atom's `source_slug`. `text`
  joins the atom's title, compiled truth and `source_quote` with newlines, skipping the NULL ones (`concat_ws`). The statement
  deadline (`timeoutMs`) has no effect: the store answers from one snapshot.
- `readPageCompiledTruths`: `body` is null for a segmented page.

`crates/gbrain-store/tests/cli_reads_doctor_derived.rs` covers each read; `test/engine-parity/doctor-derived.test.ts` compares the
engines.
