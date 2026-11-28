# The brain store: Extraction state

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

Extraction state is what the link extractor and the frontmatter sweep keep about a page: when its
links were last extracted, and the revision at which attendance extraction was blocked. In PGLite
these are three columns of `pages`; here they are one record under the page id, written only by the
methods below. The key tag is the reserved `e`. It took no format number; the store is at format 7 now ([format.md](format.md)).

| Key | Value | Mirrors |
| --- | --- | --- |
| `e page_id` | `{ links_extracted_at_us?, links_attendance_blocked_revision?, links_attendance_blocked_at_us? }` (JSON) | `pages.links_extracted_at`, `pages.links_attendance_blocked_revision`, `pages.links_attendance_blocked_at`; no record is all three `NULL` |

A page is stale when it has no stamp, when `versionTs` is newer than its stamp, or when it was
updated after its stamp. Deleted (`deleted_at`) and quarantined (frontmatter has a `quarantine`
key) pages are never stale, nor are pages of a guest source. A page deleted for good loses its
record (`cascade::remove_page_rows`), so a page created again at the same slug starts unstamped. A
deleted source (`cascade::remove_source_rows`) loses the record of any page still in it; core
removes those pages first, so this normally finds nothing. `extract_atoms_page_state`, the table
Postgres cascades there, has no records in this engine.
`getPage` returns none of these columns, as in PGLite, so the family's `page_columns` hook adds
nothing.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countStalePagesForExtraction({ sourceId?, versionTs?, attendance?, held?, wantedProducers? }?)` | the number of stale pages. `attendance: 'exclude'` drops pages blocked at their current revision, `'blocked'` keeps only those | `countStalePagesForExtraction` |
| `brain.listStalePagesForExtraction({ batchSize, afterPageId?, ...the options above })` | `StalePageRow`s by id after `afterPageId`, at most `batchSize`; `updated_at` and `updated_at_iso` are ISO strings and the TypeScript member makes `updated_at` a `Date` (`rowToStalePage`) | `listStalePagesForExtraction` |
| `brain.readExtractionLagCounts({ sourceId?, versionTs, attendance, held?, guests?, wantedProducers? })` | `{ total, stale, attendance_blocked, held }` from one snapshot: `total` counts the live, unquarantined pages of the source, guest sources included; `stale` counts the stale pages outside guest sources (inside them too with `guests: false`), without the attendance-blocked ones when `attendance`; `attendance_blocked` counts those (0 without `attendance`); `held` is 0. The TypeScript member ignores `timeoutMs`, which bounds a database statement | `readExtractionLagCounts` |
| `brain.markPagesExtractedBatch(refs, defaultExtractedAt)` | the number of pages stamped. A ref matches its exact slug in its source, deleted pages included; a page named twice counts once and keeps the first stamp. A stamp clears the attendance marker and leaves `updated_at` alone | `markPagesExtractedBatch` |
| `brain.markPagesAttendanceBlocked(refs)` | the number of live pages whose revision equals the ref's revision (any case); each gets the marker at that revision and now | `markPagesAttendanceBlocked` |
| `brain.countStaleFrontmatterKeyPages({ sourceIds })` | `{ source_id, n }[]` by source id: live pages whose frontmatter has a parser-reserved key (`slug`, `tags`, `title`, `type`) | `countStaleFrontmatterKeyPages` |
| `brain.listStaleFrontmatterKeyPages({ sourceId, afterId, limit })` | `{ id, slug, keys }[]` by id, `keys` sorted | `listStaleFrontmatterKeyPages` |
| `brain.stripStaleFrontmatterKeys({ sourceId, ids })` | the number of pages changed. Removes the reserved keys, gives the page a new knowledge revision and clears its text projection revision; `updated_at` and chunks stay | `stripStaleFrontmatterKeys` |
| `brain.readPageComparisonColumns(refs)` | `{ source_id, slug, links_extracted_at, links_attendance_blocked_revision, embedding_signature }` for each `{ slug, source_id }` ref that names a page (deleted pages included; a ref with no page has no row). `links_extracted_at` is microseconds since the epoch as text; an unset column is null. Read only. Not a BrainEngine member: only the shadow write comparison calls it, to read the three stored columns no typed read returns | none (a plain `SELECT` of the three columns) |

Where this engine differs from PGLite:

- No page is ever held and no wanted link exists: the `links_extract_failure` records and the
  `wanted_links` rows have no writer here. `held: 'exclude'` and `wantedProducers` change nothing
  and `held: 'only'` matches nothing, as in PGLite while those tables are empty.
- A guest source is one whose config says `guest: true` or `"true"`. There is no `guest_sources`
  table, so a source listed only there is not excluded.
- Inputs Postgres would refuse are refused `invalid_argument` with Postgres's message: a timestamp
  `env::parse_iso` does not read (`versionTs`, `extractedAt`, `defaultExtractedAt`), a revision
  that is not a UUID and a negative `batchSize` or `limit`. Postgres casts more timestamp
  spellings than this engine reads.

`crates/gbrain-store/tests/extraction.rs` covers what the parity cases in
`test/engine-parity/extraction.test.ts` cannot show: state across a reopen, the hard-delete
cascade, guest sources (in the stale predicate and the lag counts) and the refused inputs.
