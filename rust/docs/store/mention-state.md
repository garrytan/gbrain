# The brain store: the mention pass and its reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements of the mention pass (`src/core/mentions/pass.ts`), the entity gazetteer
(`src/core/by-mention.ts` buildGazetteer), the full extract walk's watermark snapshot and the by-mention rebuild
(`src/commands/extract.ts`), `gbrain extract mentions --explain` (`src/commands/extract-mentions-explain.ts`), the
segmented page projection check (`src/core/persistence/searchable.ts`) and the derive pass's conditional store
(`src/core/page-body/segment-derive.ts` storeRuns). PGLite and Postgres run the same SQL as before
(`src/core/engine-sql/mention-pass.ts`, `mention-reads.ts`, `segment-derive-store.ts`; the text is pinned byte for byte
by `test/engine-sql-caller-raw-sql-pins.test.ts`). The TypeScript side is
`src/core/rust-engine/store-members/mention-pass.ts`; the store side is `crates/gbrain-store/src/mention_state.rs`,
`cli_reads/mention_reads.rs` and `page_body.rs` (`store_segment_derivations_if_live`).

## Records

The store keeps the pass's three tables (migration v206) under the `META` family:

| Key | Holds | SQL table |
| --- | --- | --- |
| `M mention_status \0 source` | `{ generation, state, pending, counted_at_us, last_pass_at_us, policy_fingerprint, error, updated_at_us }` | `mention_index_status` |
| `M mention_page \0 <page id, 20 digits>` | `{ source_id, mention_revision, mention_version, mention_generation, mentions_scanned_at_us, alias_revision, alias_version, aliases_refreshed_at_us }` | `page_mention_state` |
| `M mention_entry \0 source \0 name_norm \0 target_slug \0 0\|1` | empty | `mention_gazetteer_entries` |

A hard page delete removes the page's state record and a source delete removes the source's status, entries and page
state (`cascade.rs`), as the SQL foreign keys cascade. A page purge (`deletePages`, `purgeDeletedPages`) also deletes the
entries whose target is a purged slug in its source (`scrub_purged_entries`, `scrubPurgedNameStores`); a soft delete keeps
them. A purge verification probe of `mention_gazetteer_entries` searches the saved entries (`purge_probe_rows`), and a page purge receipt's `slug_key` probe counts the entries targeting the slug (`count_for_target`). A status write refuses a state outside
`complete|pending|disabled|failed` and a missing source with the constraint errors Postgres raises.

## Semantics

- Due: a page with no state, or whose `mention_revision` is not its `knowledge_revision`, or whose `mention_version` is
  not the requested version, is due for the pass (`DUE_PREDICATE`); the alias test is the same on `alias_revision` and
  `alias_version`. `countPagesDueForMentions`, `readMentionLastPass` and `readRankCoverage` read these records.
- The two advisory locks (`lockMentionSources`, `lockMentionEntries`) take nothing: a store write transaction holds the
  store's one writer. `FOR SHARE` reads are plain reads for the same reason.
- `listMentionCandidatePages` joins the title, body and timeline with two newlines (`E'\n\n'`) and matches the
  lowered `title body timeline` LIKE each pattern (`\` escapes), always keeping segmented pages.
- Rows the SQL returns in no defined order (`DISTINCT`, unordered joins) come back by page id or in key order; every
  caller treats them as sets or sorts them.
- `storeSegmentDerivationsIfLive` upserts its rows as `done` derivations only while the page is live, segmented and
  at the given body generation, in one write; otherwise it writes nothing and returns 0.
- `readSegmentedPageSealed` answers `text_projection_revision = knowledge_revision`, null while the page has no
  projection revision.

Store tests: `crates/gbrain-store/tests/mention_state.rs`.
