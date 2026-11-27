# extract_atoms: the phase's reads, writes and ledgers

Code: `src/core/rust-engine/store-members/extract-atoms.ts`; the store side is `rust/crates/gbrain-store/src/atom_state.rs`
(the ledgers), `link_queries/atom_discovery.rs` (discovery, idempotency and atom-title reads), `link_queries/atom_backlog.rs`
(the backlog count), `release_partial_atom_dispositions` in `persistence/op_checkpoint.rs` and the transcript-key reads in
`generations.rs`, through napi methods in `families/cli_reads_doctor_search.rs`, `families/op_checkpoint.rs` and
`families/generations.rs`. The references are `src/core/engine-sql/extract-atoms-reads.ts` and
`src/core/engine-sql/extract-atoms-state.ts`.

## The ledgers (store format 17)

The store keeps `extract_atoms_page_state` and `extract_atoms_transcript_state` under the two-byte family `~a`:

- `~a 0x01 <page id BE8> <source incarnation> 0x00 <content hash>`: one page row, keyed as the table's primary key with
  the page id first, so a page's rows are one prefix.
- `~a 0x02 <source id> 0x00 <file path> 0x00 <content hash>`: one transcript row.

Each value holds `fail_count`, `tombstoned`, `partial_input_chars` (absent for NULL) and `updated_at`. A key part with a
NUL is refused (`invalid_argument`), as Postgres text refuses it.

The page table's constraints are kept: a page deleted for good drops its rows (`cascade::remove_page_rows`), and a page
write that changes `deleted_at` or `source_id` drops them (`gbrain_clear_atom_page_state`, run from `pages::store_page`).
A generation bump drops the rows of the page's other contents (`recordAtomGenerationBump`). A deleted source's pages go
first; any row of its incarnation still left is dropped with the source. The transcript table has no foreign key, so its
rows outlive a deleted source, as in Postgres.

## Members

| Member | State |
|---|---|
| `listExtractablePages(query)` | served |
| `listAtomSourceHashes(sourceId, hashes)` | served |
| `listSourcePageAtomTitles(sourceId, sourceSlug)` | served |
| `releasePartialAtomDispositions(sourceId, maxInputChars)` | served |
| `listTombstonedTranscripts(sourceId, hashes)` | served |
| `assertAtomStateStore()` | served: passes |
| `readAtomPageIdentity(sourceId, slug, contentHash)` | served |
| `writeAtomPageState(pin, failIncrement, tombstone)` | served |
| `recordAtomPagePartial(pin, maxInputChars)` | served |
| `recordAtomTranscriptPartial`, `stampAtomTranscriptTombstone`, `strikeAtomTranscript` | served |
| `listLiveTranscriptGenerations(sourceId, kind, keyPrefix)` | served; a prefix with a LIKE wildcard or escape is refused |
| `moveGenerationLocator(id, locator)` | served |
| `readLivePageSourcePath(sourceId, slug)`, `readLiveGenerationLocator(sourceId, kind, ownerKey)` | served |
| `listConversationPageFrontmatter(sourceId)` | served |

`listExtractablePages` keeps the backlog count's predicate for one source, skips a page whose current content has a
completed or held `managed-atoms` checkpoint, and skips a page whose ledger row for its current content is tombstoned or
partial. It returns the newest pages first (`updated_at` descending), at most `limit`, only of `affectedSlugs` when the
run names them. The backlog count applies the same two disposition exclusions, with a partial cap counted only when it
is at or above `maxInputChars`.

A page ledger write is pinned to the page discovery read: the page id, the source's incarnation, the source, the slug,
the content hash and the knowledge revision must still match on a live page, or the write stores nothing and answers
null (`writeAtomPageState`) or false (`recordAtomPagePartial`); an incarnation or revision that is not a UUID fails as
the SQL cast fails.

`releasePartialAtomDispositions` deletes the source's `managed-atoms` checkpoints whose `partial` is below the cap and
clears the partial cap below it on the source's page rows (of its current incarnation) and transcript rows. A
`partial` that is not an integer fails as the SQL cast fails.

`transferLegacyAtomPageState` (the managed reconcile path, `persistence/reconcile-prepare.ts`) still runs through
`executeRaw`; that path is under the `managed_persistence` hold on a Rust brain. The shadow seed does not copy the two
tables (`seed/not_copied.rs`: atom extraction checks every page and transcript again).
