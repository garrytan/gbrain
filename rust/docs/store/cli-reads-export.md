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
| `brain.listExportWithdrawals(sourceId)` | the source's withdrawals (`purged` false) and fact purge tombstones (`purged` true, `withdrawn_at` the purge time) by `visibility`, `fact_hash`, `subject` (byte order): `{ visibility, fact_hash, withdrawn_at, subject, purged }`, `withdrawn_at` an ISO string (the member makes it a `Date`) | `listExportWithdrawals` |
| `brain.readExportPageRows(ids)` | the live pages among `ids` (decimal strings), in the order given, each `{ page, tags }`: `page` as `getPage` gives it, `tags` in byte order. An id that is not an integer refuses | `readExportPageRows` |
| `brain.normalizeFenceLines(bodies, timelines)` | one `{ i, body, timeline }` per position (`i` from 1): each text split on `\n`, every line lower-cased (`lower`) with each run of `[[:space:]]` made one space, joined with `\n`; an empty text gives `null` | `normalizeFenceLines` |
| `brain.readSegmentedPageHead(pageId)` | page `pageId`'s `{ id, source_id, slug, body_storage, body_generation, body_bytes, body_lines, truth_bytes, body_flags, segmenter_version, revision }`, deleted pages included, or `null` when no page has the id. A page with no body record reads as the SQL column defaults: `inline`, generation 0, the rest `null` | `readSegmentedPageHead` |
| `brain.readBodyManifestRows(pageId, generation)` | the published manifest rows (no staging id) of generation `generation`, or of the page's live generation when `generation` is `null` (none when the page is missing), in `seq` order: `{ seq, occurrence_id, region, sha256 (hex), byte_start, byte_len, line_start, line_count, static_proj_bytes, static_proj_lines, outline_count, has_facts, has_date, generation }`. `outline_count` is the outline's length, `has_facts` whether facts_slots is non-empty, `has_date` whether `date_min` is set | `readBodyManifestRows` |
| `brain.readBodyManifestMeta(pageId, occurrenceIds, generation)` | `{ occurrence_id, entry_state, protected_regions }` of each published manifest row (no staging id) of generation `generation` whose occurrence id is in `occurrenceIds`, in `seq` order (Postgres sets none); none for an empty list or a missing page | `readBodyManifestMeta` |
| `brain.readBodyManifestOutline(pageId, occurrenceIds, generation)` | `{ occurrence_id, facts_slots, outline }` of the same rows as `readBodyManifestMeta`, in `seq` order (Postgres sets none); none for an empty list or a missing page | `readBodyManifestOutline` |
| `brain.listForcedCutSeqs(pageId, generation)` | the `seq` of each published row of the generation with `cut_kind = 'forced'`, in `seq` order; none for a missing page | `listForcedCutSeqs` |
| `brain.readManifestSeqAt(pageId, generation, byteOffset)` | the `seq` of the published row of the generation that starts last at or before `byteOffset` (ties: the higher `seq`), or `null` | `readManifestSeqAt` |
| `brain.readSegmentedVersionBodyBytes(pageId, generation)` | `body_bytes` of the newest (highest id) segmented version of the page with `body_generation = generation` and a recorded size, or `null` | `readSegmentedVersionBodyBytes` |
| `brain.listAccessPolicySourceIds()` | The sources, archived ones too, that hold access state ([access_rules.md](access_rules.md)), by id in byte order: the rulebooks an export of every source carries | `listAccessPolicySourceIds` |

## What the store does not keep

- **A statement timeout.** `setLocalStatementTimeout(ms)` does nothing on the Rust engine: the store has no statement
  timeout. It refuses an `ms` that is not a non-negative integer, and refuses on a transaction that has ended, as the
  other transaction members do. It runs only in TypeScript and has no store method.
