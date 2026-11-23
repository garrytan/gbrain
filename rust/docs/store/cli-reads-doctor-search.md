# The brain store: doctor search-and-knowledge reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that `gbrain doctor` checks ran through `executeRaw`, which a Rust brain refuses with
`raw_sql`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-search.ts`; the text is pinned by
`test/doctor-search-sql.test.ts`). The store answers from the records each statement read
(`crates/gbrain-store/src/cli_reads/doctor_search.rs`) and has no keys of its own. The TypeScript side is
`src/core/rust-engine/store-members/doctor-search.ts`. The cross-engine cases are in
`test/engine-parity/doctor-search.test.ts`; the store's own are in `crates/gbrain-store/tests/cli_reads_doctor_search.rs`.

Each member's Rust answer is one of: served (read from the records), empty-no-writer (the store has no writer for the
table the SQL reads, so the answer is what an empty table gives), or refused (the typed capability refusal).

| JS | Resolves | Rust answer | Doctor check |
| --- | --- | --- | --- |
| `listOrphanedAliasCounts()` | per source, the `slug_aliases` rows whose canonical page row is absent and the `page_aliases` rows whose page row is absent; sources with none are not listed | served | `dangling_aliases` |
| `readSoftDeletedAliasCounts()` | `{slug_redirects, page_aliases}`: alias rows whose page is soft-deleted | served | `dangling_aliases` |
| `listPageTypePairs()` | the distinct `(source_id, type)` of live typed pages, by source then type | served | `type_proliferation` |
| `listTruncatedMarkdownBodies()` | `{slug, body_len, raw_len}` per `raw_data` row whose `content` is over 1000 characters with an H2 or deeper heading and whose page body is under 30% of it; at most 101 rows (the check lists 100 and reads one more to know the list was capped) | served | `markdown_body_completeness` |
| `countSegmentedMarkdownBodies()` | segmented pages with such a raw `content` (the length comparison above passes a segmented page by, as its body is NULL) | served | `markdown_body_completeness` |
| `listRecentPageBodies(sourceIds)` | `{compiled_truth, timeline}` of the 1000 newest live pages (by id, newest first), in the sources when given | served | `link_resolution_opportunity` |
| `countSegmentedRecentPages(sourceIds)` | how many of those 1000 pages are segmented | served | `link_resolution_opportunity` |
| `countPagesHiddenByPrefix(pattern, sourceIds)` | live pages with a chunk, served by search (sealed text, source not archived, no `quarantine` or `pinned_question` key), whose slug matches the escaped `LIKE` pattern, in the sources when given | served | `hidden_by_search_policy` |
| `listGitImageHoldCounts(sourceIds)` | per source in the list, the `images` count of its current incarnation's `sync-hold-summary` checkpoint (`completed_keys[0].images`); sources with none, or a count of 0, are not listed | empty-no-writer | `image_embedding_coverage` (and the held-files check) |
| `readProjectionBacklog(scope)` | the projection queue's jobs in a read scope (`sourceId`, `sourceIds`, private-page policy, trust floor, flagged filter) by class: `pending` (text, the Markdown, code and segmented pages) with `failed` (job reason `rebuild_failed`), `sealable` and `reimport` images with `ocr_required` (`chunker_version < 0`), `protected` and `archived`; the age of the oldest job that needs work; the store clock as `YYYY-MM-DD HH:MM:SS.fff+00` | served (an empty queue on a fresh brain; `sealable_with_visual` is always 0, `failed` is 0 until a drain writes that reason) | `text_projection_readiness`, the upgrade notice, the resident's projection status, `gbrain projections drain --dry-run` |
| `countAtomExtractionBacklog(query)` | the live pages awaiting atom extraction: `sourceId` (or the whole brain), `types`, a compiled truth of at least `minChars` characters, a content hash, no `markdown-greenfield` import or `dream_generated` mark, not a source page holding a `raw` pointer, not a page of `connectorExclusion.pageTypes` in a source of one of its `sourceKinds`, and no live unmanaged atom of the same source whose `source_hash` is the first 16 characters of the page's content hash | served (the held and tombstoned dispositions are not read: the store has no writer of `managed-atoms` checkpoints or `extract_atoms_page_state` rows, so no page is ever excluded by them) | `extract_atoms_backlog`, the extract-atoms drain, `gbrain dream`, the autopilot dispatch |

## How each read follows the SQL

- An alias row is "orphaned" when its page row is absent (a hard delete), "soft-deleted" when the page row is present
  with `deleted_at` set. The store reads the alias keys (`alias_row_targets` in `crates/gbrain-store/src/aliases.rs`)
  and looks each target page up by `(source, slug)`.
- Order is bytewise, as PGLite's C.UTF-8 collation orders it. A Postgres database with another collation can order the
  `listPageTypePairs` rows differently for mixed-case or non-ASCII types.
- The truncated-body read joins every `raw_data` row of a page, so a page with two matching raw rows lists twice, as
  the SQL does. A page whose `compiled_truth` is NULL (segmented) never passes the length comparison. Soft-deleted pages
  are listed, as the SQL has no `deleted_at` test there.
- The recent-pages sample takes the newest 1000 live pages first and scopes by source inside the same window, as the SQL
  does (`ORDER BY id DESC LIMIT 1000` after the source filter).
- `countPagesHiddenByPrefix` takes one pattern. The check used to count every prefix in one statement; it now makes one
  call per prefix (the answers are the same, the round trips are not). `served` is the store's own test of the text
  projection seal (`link_queries/retrieval_coverage.rs`). The `LIKE` pattern is `crate::facts::like`, with `\` as
  the escape.
- `listGitImageHoldCounts` reads the checkpoint in the housekeeping key space (`d 0x02 <op> 0x00 <source id>:<incarnation>`),
  where this store keeps every `op_checkpoints` row. Nothing writes the `sync-hold-summary` op on a Rust brain yet, so
  the answer is empty (as a PGLite brain with no held images answers), and a summary of an earlier incarnation of a
  source is never counted. When a writer for that op lands, this read serves its rows with no change.
- `readProjectionBacklog` walks the queue (`d 0x04 <incarnation> 0x00 <slug>`), joins each job to its source by
  incarnation and to the live page at the slug, and keeps the pages `pageReadFilter(..., live = false)` keeps: the scope
  but not the live test, so an archived source's job counts as `archived` and a quarantined page still counts
  (`link_queries/projection_backlog.rs`; the readiness reads in `retrieval_coverage.rs` apply the live test and share
  the scope code). A non-empty `sourceIds` wins over `sourceId`; an empty one is ignored. An image is `sealable` when its
  chunker version is at or after the safe-chunk fence and it has exactly one current chunk, at index 0, `image_asset`,
  modality `image`, shorter than 65536 characters and equal to the body's first 65536 characters (or the title when
  that is empty); any other live image is `reimport`. The store keeps no image vector, so `sealable_with_visual` is 0.
  The Rust writer queues only reason `canonical_change`, so `failed` is 0 until a drain writes `rebuild_failed`.
- `countAtomExtractionBacklog` scans the pages once (`link_queries/atom_backlog.rs`) and builds the set of (source, `source_hash`)
  of the live, unmanaged atoms, so each page costs a lookup. A segmented page has a NULL body and never reaches the length
  floor, as `octet_length(NULL) >= n` is not true. `maxInputChars` is accepted and unused: it only bounds partial dispositions the
  store never records. The connector lists arrive as arguments (the TypeScript caller owns them), so the store holds no list of
  connector kinds.
