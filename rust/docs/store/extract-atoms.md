# extract_atoms: the phase's reads, release and state-store gate

Code: `src/core/rust-engine/store-members/extract-atoms.ts`, `rust/crates/gbrain-store/src/link_queries/atom_discovery.rs`
and `release_partial_atom_dispositions` in `rust/crates/gbrain-store/src/persistence/op_checkpoint.rs`, through napi
methods in `families/cli_reads_doctor_search.rs` and `families/op_checkpoint.rs`. The reference is
`src/core/engine-sql/extract-atoms-reads.ts`.

## Members

| Member | State |
|---|---|
| `listExtractablePages(query)` | served |
| `listAtomSourceHashes(sourceId, hashes)` | served |
| `listSourcePageAtomTitles(sourceId, sourceSlug)` | served |
| `releasePartialAtomDispositions(sourceId, maxInputChars)` | served |
| `listTombstonedTranscripts(sourceId, hashes)` | served: no rows |
| `assertAtomStateStore()` | refused by name (`raw_sql`), before any work |

`listExtractablePages` keeps the backlog count's predicate (`link_queries/atom_backlog.rs`) for one source and also
skips a page whose current content has a completed or held `managed-atoms` checkpoint (the store keeps op
checkpoints). It returns the newest pages first (`updated_at` descending), at most `limit`, only of `affectedSlugs`
when the run names them. The statement's `extract_atoms_page_state` exclusion finds nothing: the store keeps no page
state.

`releasePartialAtomDispositions` deletes the source's `managed-atoms` checkpoints whose `partial` is below the cap; a
checkpoint with no `partial` stays, and a `partial` that is not an integer fails as the SQL cast fails. The two state
updates of the statement clear nothing, as the store keeps no state rows.

`listTombstonedTranscripts` returns no rows without a store call: the store keeps no transcript state, and the gate
refuses every run that could write one.

`assertAtomStateStore` refuses with "the store keeps no extract_atoms page or transcript state". The phase asks it
after discovery, only when there is work, and before the first model call (a dry run calls the model too), so a Rust
brain spends nothing on a run it could not record. With no work the phase reports `no_work` as on PGLite. The stop is
RUST_ENGINE.md row X-1, until the store adds the state records.
