# The brain store: doctor health reads

Part of the store contract in [rust/README.md](../../README.md) ("The brain store"): the rules there apply to every method here.

These are the statements that the calibration checks (`contextual_retrieval_coverage`, `abandoned_threads`,
`grade_confidence_drift`), the remote doctor report (`chronicle_projection_health`), the catalog checks
(`pages_upsert_arbiter`, the timeline dedup index, `brainstorm_health`) and the request-index readers ran through
`executeRaw`. PGLite and Postgres run the same SQL as before (`src/core/engine-sql/doctor-health.ts`). The TypeScript side is
`src/core/rust-engine/store-members/doctor-health.ts`; the store side is `crates/gbrain-store/src/cli_reads/doctor_health.rs`,
which has no keys of its own. `test/engine-parity/doctor-health.test.ts` compares the engines.

A member answers one of three ways on the Rust engine:

1. Served from the store's records (the table below).
2. Answered from the store's key layout, because the SQL statement reads the catalog and the key layout holds what it checks for:
   - `readPagesUpsertArbiter`: `{ tablePresent: true, arbiterPresent: true, duplicateGroups: 0 }`. A page record is keyed by
     (source, slug) (`keys::page`), `store_page` writes that one key, `createSegmentedPageShell` refuses a taken pair with the
     `pages_source_slug_key` error, and `rename_page` refuses a taken slug and deletes the old key. The unit test
     `pages::tests::a_source_and_slug_hold_one_page_record` pins it.
   - `readTimelineDedupIndex`: present, with the definition the SQL engines print for the v138 index
     (`page_id, date, md5(summary), source`), the columns of the store's `timeline_dedup` key.
   - `readRetrievalTrackingColumn`: true. The store records page retrievals (`page_ops/retrievals.rs`, `bumpPageRetrievals`).
   - `readRequestIndexStates`: every named index valid, built and not building. See "Request lookups" below.
3. `countAppliedGradeVerdicts` answers 0 with no store call: the store keeps no `take_grade_cache`, and its only writer
   (`src/core/cycle/grade-takes.ts`) runs raw SQL, which the engine refuses. If a Rust writer for it lands, the member must move to
   the first kind in the same change.

| JS | Resolves | Mirrors |
| --- | --- | --- |
| `brain.countContextualRetrievalCoverage(markdownChunkerVersion, sourceIds?)` | `{ chunker_drift, unsealed, unsealed_code, mode_null }` of live pages | `countContextualRetrievalCoverage` |
| `brain.countAbandonedThreads(sourceIds?)` | old high-conviction takes nobody revisited | `countAbandonedThreads` |
| `brain.countOrphanedEventProjections(sourceIds?)` | timeline projections of soft-deleted event pages | `countOrphanedEventProjections` |

## How each read follows the SQL

- `countContextualRetrievalCoverage`: live pages of the named sources. `chunker_drift` counts markdown pages below
  `markdownChunkerVersion`; `unsealed` counts pages of every kind below `SAFE_FENCE_CHUNKER_VERSION` (`unsealed_code` the code
  pages among them). A record with no chunker version is below both, as `countSafeIndexPending` reads it. `mode_null` counts
  markdown pages, extract receipts aside, with no contextual-retrieval stamp (the store writes none for the `none` tier, as
  PGLite leaves the column NULL).
- `countAbandonedThreads`: active takes with no resolution and no successor, weight 0.7 or more, and a `since_date` before
  `now() - 12 months`. The weight compares as Postgres compares `real >= 0.7`: the single-precision value widened to double, so a
  stored 0.7 is below it. A seven-character `since_date` (`YYYY-MM`) reads as its 1st. A date Postgres cannot cast fails the read
  with the Postgres message. Twelve months back keeps the time of day and clamps the day to the end of the month, in UTC.
  `sourceIds` keeps takes whose page (soft-deleted ones included) is in those sources.
- `countOrphanedEventProjections`: timeline rows with an event page that exists and is soft-deleted; `sourceIds` keeps those whose
  event page is in those sources.

## Request lookups

The SQL engines keep online-built indexes on `persistence_requests` (the checkpoint pair, the slug intent, the request id, the
foreground-committed, replay id and slug-sequence indexes), and doctor `persistence_request_indexes`, the checkpoint timeout hint,
the page purge and the failed-writes preview read their state. The store has no request indexes: it finds a request by a full scan
of `keys::REQUEST` (`persistence.rs` `all_requests`). An index the store does not have cannot be missing or left INVALID by an
interrupted build, and the statement timeout (57014) that a broken index causes on a large request table cannot happen: the store
runs no SQL statement. So `readRequestIndexStates` answers every named index valid, doctor `persistence_request_indexes` prints
what a healthy PGLite brain prints, and `gbrain repair request-indexes` plans and applies nothing.

The full scan is still a speed loss against an indexed table on a brain with a large request journal. Doctor's "valid" does not
record it: row 20 of "Open before `rust` can be selected" in `docs/designs/RUST_ENGINE.md` does, until a request index in the
store fixes it.
