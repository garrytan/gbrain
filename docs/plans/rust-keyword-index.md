# Plan: a keyword index for the Rust store

Status: plan only, for review. Nothing here is built. Base: `rust-engine/main` at
`4fe3c2e0751bf0d53af6e6603953a56eb06f84b3`. The bench harness comes from
`rust-engine/store-records-owner-ipc-v2` at `a059d000f995e26d88e5fc83ffe4c6f70f4220ff`
(`rust/crates/gbrain-store/examples/keyword_scale.rs`, `rust/bench/corpus/dbpedia.py`).

## ELI5

The Rust store answers a keyword search by reading every page and every chunk in the brain,
and it turns the text of each one into search words again on every query. That is fine for a
small brain, but on a brain with 50,000 pages it takes about 7 seconds per search. A book has an
index at the back so you do not read the whole book to find a word. This plan adds that index
to the Rust store: for each search word, a list of the chunks and pages that contain it, with
the word positions and weights. A search then reads only the lists for its own words. The
index holds exactly the words the current search code already makes, so results stay the same
as PGLite and Postgres, byte for byte. Every write updates the index in the same transaction
as the text, so the index can never be behind the data. Old stores get the index built once
when a new build opens them, and searches use the old full read until that build is done.
Title fuzzy search gets a second, smaller index of three-letter pieces of each title. A bench
gate proves every keyword search is under 100 ms at the median on the 50,000-page brain, and
the parity tests prove no result changed.

## Before → after

| | Before (`4fe3c2e075`) | After |
|---|---|---|
| Body keyword members (chunks, page count, page search, hybrid arm) | Read every page record and every chunk, build every tsvector (64 MiB cache), test `@@`, rank. About 7 s p50 at 50k pages / 200k chunks. | Read the postings of the query's lexemes only, build a small vector of just those lexemes per candidate, admit candidate pages with the same filter, rank with the same `ts_rank`. Target p50 under 100 ms, p99 under 500 ms. |
| Title members (whole, title, complete) | Read every page record, build every page vector, `@@` per page. About 400 ms p50. | Page postings (title at weight A, timeline at C) give the matching pages in page-id order, which the candidate cap already needs. |
| Fuzzy title | `trgm_similarity` against every title. About 300 ms p50. | Trigram postings give the pages that share enough trigrams to reach the threshold (a rounding-safe bound); exact `similarity` runs on those only. |
| Write path | `put_postings` keeps legacy unstemmed `T` postings for the BM25 method only. | The same `Store::write` transaction also keeps the new postings. `FlaggingWriter` (from the restricted-flag branch) stays the wrapper that every write handle goes through; the index writer composes with it. |
| Existing stores | No derived-index rebuild exists (only the format-1 to format-2 counter fold). | Store format 4 (format 3 is the compact projection job layout from `rust-engine/projection-coalesce`). Opening a format 1, 2 or 3 store starts a resumable background build; members use the scan until the build marks the index complete. |

## Why it matters

The Rust engine cannot be selected while keyword search takes seconds (row 4 of "Open before
`rust` can be selected" in `docs/designs/RUST_ENGINE.md` on the harness branch). Keyword search
is in every hybrid query, so a 7 s arm makes every search 7 s. The scan also grows linearly
with the brain, so a bigger cache does not fix it. Without the index the Rust engine stays a
small-brain engine.

## What caused this work

Core measured keyword search on a 50k-page / 200k-chunk Rust store (release build, warm, one
fresh process per member, 30 queries, p50 / p99 ms):

| Member | p50 | p99 |
|---|---|---|
| hybrid keyword arm (`search_keyword_arm`) | 7,127 | 7,447 |
| `search_keyword_chunks` | 6,968 | 7,064 |
| `count_keyword_pages` | 6,917 | 7,047 |
| `search_keyword_pages` | 6,955 | 7,197 |
| title attempts (whole and title) | 401 | 457 |
| title attempts (complete) | 385 | 432 |
| title fuzzy | 307 | 383 |

The bound is p50 under 100 ms and p99 under 500 ms. The scan meets it at 10k chunks (13 to 27
ms) and fails at 200k. The lead for the Rust engine asked for this plan; the build waits for
approval.

Baseline on this plan's base (`4fe3c2e075`), same harness and corpus, this sandbox (8 cores):

| Member | 10k chunks p50 / p99 | 200k chunks p50 / p99 | Peak RSS at 200k (MiB) |
|---|---|---|---|
| arm | 43.8 / 48.7 | 8,121 / 8,868 | 650 |
| chunks | 40.3 / 42.5 | 7,764 / 8,182 | 667 |
| pages_count | 41.3 / 47.2 | 7,649 / 7,738 | 648 |
| pages_search | 42.3 / 53.6 | 7,774 / 8,145 | 648 |
| titles | 15.9 / 16.4 | 540 / 663 | 454 |
| titles_complete | 14.1 / 19.5 | 497 / 508 | 435 |
| fuzzy | 13.2 / 19.9 | 394 / 469 | 359 |

The 10k run shared the CPU with a test gate, so it is slower than core's 13 to 27 ms. The 200k
run had the machine to itself (30 queries, fuzzy 35, last of 2 passes). It is about 11 to 35%
slower than core's numbers, the same shape: the four page and chunk keyword members are 15 to 18
times over the 500 ms p99 bound, and the title members are over the 100 ms p50 bound and near or
over the p99 bound. The 200k load took 131 s here (core: about 93 s) and the store is 824 MiB.
Peak RSS is 359 to 667 MiB against the 824 MiB store.

## Owner's words

- The Rust engine lead, 2026-11-19 (UTC): "Write the plan for a keyword inverted index in the Rust store under gstack /autoplan: postings layout in redb, the tokenizer that must match the PGLite/Postgres tsvector and ts_rank results byte-for-byte on the parity corpus, the trigram or prefix index for titles/fuzzy, write-path maintenance inside the same Store::write (keep FlaggingWriter), rebuild/migration for existing stores, the private-page filtering order, and the bench gate (p50 under 100 ms at 50k/200k, plus no parity row lost)."
- The Rust engine lead, 2026-11-19 (UTC): "Do not build yet. Report the plan as a decision, with the open choices lettered, by 6 AM PST."
- The Rust engine lead, 2026-11-19 (UTC): "Base the plan on it, and cite it in the bench gate." (the `keyword_scale` harness at `a059d000f9`)

## Facts the design rests on

Line numbers are at `4fe3c2e075`, under `rust/crates/gbrain-store/src/`.

- Every keyword, title and fuzzy member starts with `all_pages` (`pages.rs:768`), which parses
  every page record as JSON, including `compiled_truth` and `timeline`. Chunk members then call
  `read_chunks` per kept page and build each chunk vector (`keyword/filters.rs:316`, cached in a
  64 MiB `vector_cache`).
- The tokenizer already exists and is golden-tested against PGLite 0.5.16 (PG 18.6): the
  default parser (`keyword/parser.rs`), the Snowball English stemmer and stopwords
  (`keyword/stem.rs`), `to_tsvector`, `setweight`, `||`, `gbrain_fts_input`,
  `websearch_to_tsquery`, `phraseto_tsquery` (`keyword/tsearch.rs`), `ts_rank` and
  `ts_rank_cd` with normalization 0 (`keyword/rank.rs`). Fixtures:
  `tests/fixtures/{english_stem.tsv,ts_parse.json,tsearch.json}`. No new tokenizer is needed.
- `ts_rank`, `ts_rank_cd` and `ts_matches` read only the vector entries of the query's own
  lexemes (`rank.rs:58-156`, `get_docrep` at 166, binary search by lexeme). With normalization 0
  no ranker reads the document length. So a vector that holds only the query's lexemes, with
  their exact positions and weights, gives the same match and the same f32 rank as the full
  vector. The only whole-vector reads are the empty checks (`ts_rank` returns 0 for an empty
  vector, `rank.rs:139`). Two cases break the "query lexemes only" shortcut and get full
  vectors (D3): a handle-arm candidate, which is admitted without a text match
  (`page_search.rs:98-110`), and a query that can match with none of its lexemes present
  (through `!`). A member can also use more than one query: the hybrid arm has separate
  `match_query` and `rank_query` plus a phrase query (`arm.rs:57-104`).
- The page vector is not a function of the page record alone. It is the sealed form (title A +
  sealed timeline C, from `M page_search_timeline/<id>`) when the seal revision matches, else the
  trigger form (title A + timeline or segmented lead C + timeline entries with
  `created_at_us <= page.updated_at_us`, joined in id order, C) (`keyword/titles.rs:132-186`).
  The inputs are the `P` page record, the `M page_search_timeline` record, the page body lead
  (`page_body::timeline_lead`) and the `E` timeline entries.
- The chunk vector is doc comment A + qualified symbol A + chunk text B (`filters.rs:316-326`).
  A vector past the tsvector size cap is unreadable and matches nothing.
- The redb file has one table, `kv` (`redb_kv.rs:16`). Families are one-byte key tags
  (`keys.rs`). The keyword family owns the reserved tag `R`, and nothing writes it yet
  (`keys.rs:62`, `keyword.rs:12`). The store format is 2 (`format.rs:18`); `upgrade_format`
  (`lib.rs:395`) is the only open-time upgrade.
- Page hooks exist (`page_index::reindex_page`, called from `write_page_as` and `remove_page`;
  `keyword::reindex_page` is an empty stub), but they fire twice per `put_page` and do not see
  timeline entry or seal writes.
- `FlaggingWriter` is not on `4fe3c2e075`. It is on `rust-engine/restricted-flag*` (commit
  `4507a47b62`): `Store::write` wraps every write handle in `access_flag::FlaggingWriter`, which
  sees every `put` and sets the member-access flag when a page record names readers. This plan
  assumes that change lands first and composes with it.
- Private-page, deleted, archived-source, `served`, quarantine and pinned-question checks all
  run in `PageFilter::keeps` (`filters.rs:173-248`) before any chunk is read, ranked, limited or
  counted, for chunk search, page search, the hybrid arm and titles. Chunk checks
  (`visible_at(generation)`, `keeps_chunk`) run per chunk. Two members have their own,
  intentional predicates and keep them: `keyword_rare_term_pages` (`served`, generation, text
  modality, no `PageFilter`, `arm.rs:143-178`) and fuzzy (`title_fuzzy.rs:136-150`).
- Modality differs per member: `search_keyword_chunks` returns matching non-text chunks
  (`chunk_search.rs:61-68`); page search, the hybrid arm and rarity keep `modality = 'text'`.
- `keyword_rare_term_pages` counts up to `cap + 1` and its `page_ids` depend on walk order:
  `all_pages` walks `P source NUL slug` order, not page-id order.
- Fuzzy similarity is f32 (`trgm.rs:153-176`), and the threshold is a `real` parameter rounded
  to f32 (`title_fuzzy.rs:94-107`). Raw trigrams are always `[u8; 3]` (multibyte characters are
  CRC-compacted, `trgm.rs:38,75-87`).
- `P` keys hold source and slug, not the page id (`keys.rs:115-118`). The segmented lead state
  is `b 0x05 page_id` (`page_body.rs:587-590,643-652`). `KvWrite` has special primitives
  (`allocate`, `raise_counter`, `add_i64`, `counter_below`, `kv.rs:38-80`) that `OccTxn`
  overrides (`occ_kv.rs:937-1026`). `Store::write` retries an `FnMut` closure on OCC conflict
  (`lib.rs:318-367`).
- Score depends on the page: `ts_rank * phrase factor * source_factor(page)`
  (`filters.rs:298`), and the handle arm matches pages by slug basename (`page_search.rs:80`).

## Big decisions

Each decision has a recommendation (rec). The lettered choices go to the lead as one list.

### D1. Where index maintenance runs

- **D1a (rec): a write-handle wrapper.** An `IndexingWriter` beside `FlaggingWriter` in
  `Store::write` records which chunks and pages a statement touched, from the keys it puts or
  deletes: `K` chunk records, `P` page records, `M page_search_timeline/<id>`, the segmented lead
  state `b 0x05 page_id`, and `E` timeline entries. For a `P` put or delete it reads the
  preimage first, so it knows the old page id, source, slug and basename even after a hard
  delete or a rename. At the end of each statement, before the statement merges, it rebuilds the
  postings of every touched chunk and page from the statement's own view and writes the
  difference against the forward records. Any write path, present or future, updates the index,
  which is the same reason `FlaggingWriter` exists. The wrapper chain is transparent: it forwards
  `allocate`, `raise_counter`, `add_i64` and `counter_below` to the inner writer, so `OccTxn`'s
  conflict-free counters stay in force (`FlaggingWriter` does not forward them today; the build
  fixes both wrappers). A fresh touched set is made inside each OCC attempt and inside each
  bound `tx.statement`; a flush error fails that statement, and its writes and postings go
  together. `FlaggingWriter` reaches the trunk through lane 12, not this PR (see the
  Implementation plan); the chain seam takes it as `IndexingWriter(FlaggingWriter(inner))`.
- D1b: call-site hooks in `write_chunk`, `remove_chunk_record`, `page_index::reindex_page`, the
  seal and the timeline writers. Smaller, but a new write path can skip the index silently, and
  timeline, seal and lead writes need hooks that do not exist yet.

### D2. Postings layout in redb

All keys are in the `kv` table under the reserved keyword tag `R` (`keys::TRIGRAM`), with a second byte for the kind.
Numbers are big-endian, so byte order is numeric order. No new tag byte.

- **D2a (rec): one key per (term, document).**
  - `R 0x01 len(2) lexeme page_id(8) chunk_index(4)` → packed `WordEntryPos` list (u16 per
    position: 14-bit position, 2-bit weight), exactly the entry of the chunk's tsvector. Every
    vectorable modality is indexed; text-only filtering stays in the members that have it.
  - `R 0x02 len(2) lexeme page_id(8)` → the same for the page vector.
  - `R 0x03 trigram(3) page_id(8)` → nothing (presence). The trigram is the raw `[u8; 3]` from
    `trgm.rs` (CRC-compacted for multibyte characters), not its display text. Soft-deleted
    pages are included, because unscoped fuzzy reads them.
  - `R 0x04 len(4) basename page_id(8)` → nothing (the handle arm).
  - `R 0x05 page_id(8) chunk_index(4)` and `R 0x06 page_id(8)` → forward records: the exact
    posting keys this document owns (lexemes, trigrams and the basename key). Deletes use them,
    so a rename or a tokenizer change never leaves an orphan posting.
  - `R 0x00` → index state: index version, build cursor, complete flag.
  - The u16 length prefix keeps one lexeme's range apart from a longer lexeme that starts with
    it (a lexeme is at most 2,047 bytes, as in PG). Lists sort by (page, chunk), so an AND is a
    merge join and page grouping is free. Two writers on different documents never write the
    same key, so `OccKv` concurrent writers do not conflict on common words. No
    document-frequency counters (they would conflict).
- D2b: per-lexeme compressed blocks. Faster reads, but every write rewrites shared blocks and
  concurrent writers conflict on common words.

Size estimate (not measured): about 60 distinct lexemes per dbpedia chunk, so about 12 M chunk
postings at 200k chunks; at 30 to 45 bytes each in redb, about 0.4 to 0.6 GB on top of the
824 MiB store. The build measures the real number and reports it.

### D3. How a query uses the postings (the parity argument)

- **D3a (rec): sparse vectors, same functions.** Candidates come from the matcher and the
  handle arm only: walk the match tsquery tree (a lexeme is its postings, AND and phrase
  intersect bounded children, OR unions, NOT is unbounded). For each text candidate, build a
  byte-sorted `TsVector` from the union of every query the member uses (match, rank and phrase,
  negative operands included) with the stored positions and weights, then call the existing
  `ts_matches`, `ts_rank`, `ts_rank_cd` and phrase test. The functions, the f32 arithmetic and
  the tie order do not change. Two cases use the full vector, built by the existing
  `chunk_vector`/`page_vector` code: handle-arm candidates (admitted without a text match), and
  a match query whose root is unbounded (it can match through `!` alone), which uses the scan.
- D3b: store each full vector and read it per candidate. Simpler proof, but much more data per
  candidate and more storage.

The tokenizer question in the request is answered by reuse: the index stores the output of the
same `chunk_vector` and `page_vector` code the scan uses, and the existing PGLite goldens keep
pinning that code. No second tokenizer exists to drift.

### D4. Private-page filtering order

- **D4a (rec): each member keeps its own predicates in its own order.** Postings only narrow
  the set of pages that reach the member's existing admission code. For chunk search, page
  search, the hybrid arm and titles that is `PageFilter::keeps`, with the same
  `OwnerOnlySources` read once per call; it decides each candidate page once per query, before
  any of its chunks is ranked, limited or counted. A hidden page contributes nothing to a score,
  a window, a count, a cap or a title `cut`. The only thing read for a hidden page is its
  postings, which hold no text. Admission decodes the page record through a lean view that
  skips only the body text (it keeps identity, source, type, frontmatter, revisions, safety,
  dates and trust fields); the predicate code stays the one in `filters.rs`, and its validation
  order and errors stay the same. Privacy and source policy stay read-time decisions and are
  never stored in postings. Per member:

  | Member | Page admission | Chunk admission | Order before cut |
  |---|---|---|---|
  | `search_keyword_chunks` | `PageFilter::keeps` | `visible_at`, `keeps_chunk`, any modality | score, page id, chunk id |
  | `search_keyword_pages`, `count_keyword_pages` | `PageFilter::keeps`, handles | `visible_at`, text, `keeps_chunk` | as today; count to 10,001 |
  | `search_keyword_arm` | `PageFilter::keeps` | `visible_at`, text, `keeps_chunk` | as today, `limit * 3` window |
  | `keyword_rare_term_pages` | `served` only (no `PageFilter`) | `visible_at`, text, exact match | `P` key order (source, slug), then chunk order; counts to `cap + 1` |
  | title kinds | `PageFilter::keeps` | none | page id for the cap, then exact-title, rank, id |
  | fuzzy | its own source and deleted checks | none | similarity, then slug bytes |

  For rarity, candidate pages are sorted into `P` key order before the walk, so the truncated
  `page_ids` are the scan's. This plan does not change any member's privacy contract.
- D4b: rank first, then admit lazily in rank order until the window fills. It reads fewer page
  records but needs an upper bound for `source_factor` and is harder to prove. Kept only as a
  fallback if the bench shows admission is the cost.

### D5. Titles and fuzzy

- **D5a (rec): page postings for titles, trigram postings for fuzzy.** The title kinds read
  `R 0x02` (Title uses positions at weight A only, as `ts_filter(v,'{a}')`); page-id order gives
  the lowest-id cap that Whole and Complete need. Fuzzy reads `R 0x03` for the query's raw
  trigrams and counts shared trigrams `c` per page. In real numbers `c / (n1 + n2 - c) <= c / n1`,
  but the scan divides in f32 and compares with an f32 threshold, so the bound must be
  rounding-safe: admit `c >= max(1, ceil(n1 * t_low))`, where `t_low` is the threshold lowered by
  two f32 steps (correctly rounded division exceeds the real quotient by at most half a step).
  A unit test checks the bound exhaustively against `calc_sml` for every `(c, n1, n2)` with
  `n1, n2 <= 2,048`, and the review's case (`name = 'a b c d e'`, title `a`, `min = 0.200000001`)
  is a fixed regression. Above 2,048 trigrams, or when the threshold is zero, negative or not
  finite, the member uses `c >= 1` or the scan, after the same `real_param` validation. Only
  admitted pages get the exact `trgm_similarity`, the slug `LIKE` and the source and deleted
  checks, in the same order as today.
- D5b: a prefix index on titles. It cannot answer `similarity`, so it does not serve fuzzy.

### D6. Existing stores

- **D6a (rec): format 4 with a resumable build that every open checks.** Format 4 means "this
  store keeps keyword postings" (format 3 is taken by the compact projection jobs of
  `rust-engine/projection-coalesce`, which this branch merges first). A build without the index
  refuses a format-4 store
  (`FORMAT_UNKNOWN`, nothing changed). The format change and an incomplete index-state record
  are written in one transaction. A fresh store is created with a complete, empty index. Every
  open (not only `upgrade_format`) reads the index state: an unknown future index version is
  refused before any write; an incomplete index starts the builder. The builder runs on a
  background thread owned by the `Store`, in page-id batches; each batch writes its postings and
  the cursor in one transaction through the normal OCC retry, and the complete flag is set only
  in the transaction that finds no page past the cursor. It stops when the `Store` drops and
  resumes from the cursor on the next open. Writes during the build go through D1, so a page
  behind the cursor is always current and a page ahead is rebuilt by its batch. Each query reads
  the index state in its own snapshot: incomplete means the scan. `keyword-index verify` (store
  API and doctor) checks forward and reverse records both ways and compares postings with fresh
  vectors for a sample or for every document; `keyword-index rebuild` clears `R` and sets the
  state to incomplete in one transaction. The v1 counter fold stays.
- D6b: build on open in one blocking pass. Simpler, but a 50k-page brain waits on first open
  (the time is measured during the build).

### D7. Delivery

- **D7b (rec): one PR with chunk, page and trigram postings, one format, one gate.** One index
  version covers every family, so no format-4 build can exist that writes a store without
  maintaining all of it, and the all-member gate runs once on the finished tree.
- D7a: three PRs (chunk, title, fuzzy). Smaller reviews, but it needs per-family readiness,
  refusal of a newer index version by every earlier format-4 build, cross-release tests and
  partial gates.

### Not decisions (findings folded in)

These came from the review and are now part of the plan, not open choices: the multi-query
sparse vector (D3), the per-member modality and rarity rules (D4), the f32-safe fuzzy bound
(D5), the open-time index state and builder (D6), the transparent wrapper and per-attempt
tracking (D1), preimage capture and basename forward keys (D1, D2), the full-result scale check
(bench gate), the three-byte trigram key (D2) and corpus provenance (bench gate).

## Implementation plan

Files are under `rust/crates/gbrain-store/` unless named otherwise. One PR (D7b) on
`rust-engine/keyword-index`, pushed as four stacked, reviewable commits:
(1) `IndexingWriter` and the write handle chain seam in `Store::write`; (2) chunk and page
postings; (3) trigram postings with the f32-safe fuzzy bound; (4) format 4, the resumable build,
`verify` and `rebuild`.

Commit (1) does not carry `FlaggingWriter` (lead ruling, 2026-11-19 UTC, the lead's own and not
the owner's): `access_flag.rs` is created by `407f3d874f` with lane 12's member-access feature,
so carrying `4507a47b62` would carry that chain. Lane 12's chain reaches the trunk first, in
lane 2's batch. Commit (1) puts the seam in one function, `lib.rs` `write_chain`, which every
OCC attempt and every bound statement runs; when this branch rebases onto a base with
`FlaggingWriter`, the merge is one line in `write_chain`:
`IndexingWriter::new(&mut access_flag::FlaggingWriter(inner))`.

Forwarding fix for lane 12 (a note; the lead routes it): `FlaggingWriter` must forward
`allocate`, `raise_counter`, `add_i64` and `counter_below` to its inner handle, as
`IndexingWriter` does. Without it the `KvWrite` defaults turn each into a read and a put, which
loses `OccTxn`'s conflict-free counters and breaks a later `allocate` on the same key. The
store test `keyword::index_writer::tests::the_write_chain_forwards_the_special_primitives`
runs the four calls through `write_chain` against a recording inner handle; after the rebase it
covers the nested order `IndexingWriter(FlaggingWriter(inner))` with no change, and it must
pass on that base before the PR opens. It fails today if `IndexingWriter` stops forwarding
(checked: 2 of 8 tests fail with the four overrides removed).

Accepted at the gate (gate_rev 4, every item `rec`), and where each one lives in this plan:
- `r4-uc1` one PR and one final all-member gate: D7b and the commit order above.
- `r4-d1` the f32-safe fuzzy candidate bound: D5a and step 7, with the exhaustive test in step 10.
- `r4-d2` sparse vectors from the union of match, rank and phrase lexemes: D3a and step 3.
- `r4-d3` postings for every vectorable modality, text-only filtering per member: D4a and step 5.
- `r4-d4` rarity keeps cap+1, its own predicates and the scan's truncation order: D4a and step 5.
- `r4-d5` index state read on every open, fresh stores seeded complete, resumable build: D6a
  and step 8.

1. Phase 0, measure (no product code): run `examples/keyword_scale.rs` from the harness branch
   on `4fe3c2e075` at 10k and 200k chunks, and record where the time goes (`perf`) between page
   decode, chunk decode, vector build and ranking. Result: the baseline table above and a
   profile note in `rust/docs/store/keyword.md`.
2. `src/keys.rs`: add the `R` kind bytes and key builders (`chunk_posting`, `page_posting`,
   `title_trigram`, `basename`, forward and state keys). No new tag byte.
3. `src/keyword/index.rs` (new): `postings_of(vector)`, the forward record codec,
   `reindex_chunk(w, page_id, chunk_index)`, `reindex_page(w, page_id, preimage)`, the candidate
   walk over a `TsQuery` (inside `with_query_stack`), sparse-vector assembly from a set of
   queries, and `IndexState`. The walk's rule: a node is bounded when every way it can match
   needs a positive lexeme. A lexeme is bounded; AND is bounded when any child is (seed from the
   bounded children, the rest is checked by `ts_matches`); OR is bounded only when every child
   is; phrase is bounded like AND; NOT is never bounded. An unbounded root uses the scan. A
   vector over the tsvector size cap writes no postings (and its old postings are deleted), so it
   matches nothing, as in the scan.
4. `src/keyword/index_writer.rs` (new): `IndexingWriter`, a transparent `KvWrite` wrapper that
   captures `P` preimages, records touched chunk and page ids by key family and flushes at
   statement end. `src/lib.rs`: `Store::write` builds the wrapper chain (`write_chain`) inside
   each OCC attempt and each `tx.statement`. `src/access_flag.rs` forwards the special
   primitives in lane 12's change (see the note above).
5. `src/keyword/chunk_search.rs`, `page_search.rs`, `arm.rs`: when the index state is complete
   in the query snapshot, take candidates from `index.rs` and apply each member's admission row
   from D4 (lean page view in `src/pages.rs`). Rank with the sparse vector built from every
   query the member uses; handle candidates use the full vector. Keep the current sort and
   window code. `keyword_rare_term_pages` sorts candidate pages into `P` key order and keeps
   `cap + 1`, `served`, generation, text and exact match.
6. `src/keyword/titles.rs`: candidates from `R 0x02` in page-id order for Whole, Title and
   Complete. Each candidate passes `PageFilter::keeps` and the exact match first (for Title,
   `ts_matches` on `ts_filter(v, '{a}')` of the sparse vector), and only then counts toward the
   cap, as in the scan. Same exact-title order.
7. `src/keyword/title_fuzzy.rs` and `src/keyword/trgm.rs`: expose the raw trigram set; trigram
   candidates with the rounding-safe bound from D5, then the current exact path. The scoped call
   drops soft-deleted pages and the unscoped call keeps them (`title_fuzzy.rs:138,355`; follow-up
   `fuzzy-title-unscoped-deleted` stays open), so trigram postings include soft-deleted pages.
8. `src/format.rs`, `src/lib.rs`: `FORMAT_VERSION = 4`, `FORMAT_VERSIONS = [1, 2, 3, 4]`; the
   format change writes the incomplete state; every open reads the state. The format registry
   (`rust/docs/store/format.md`, from `rust-engine/store-format-registry`) gets a row 4.
   `src/keyword/index_build.rs` (new): the background builder, `verify` and `rebuild`. The
   builder walks the `I` page-id family in id order, so the cursor is a page id; each batch
   reads the page through `I` and rebuilds its page, chunk and trigram postings.
   The wrapper chain is `IndexingWriter(FlaggingWriter(inner))`; the indexer ignores the access
   flag keys, so the flag writes never mark a document as touched.
9. `src/chunks.rs`: the legacy `T` postings stay as they are for the BM25 method (not in scope).
10. Tests (Rust), `tests/keyword_index.rs` (new). Each asserts index results equal scan results
    byte for byte (ids, chunk ids, order, score bits, title `cut`, fuzzy winner and similarity,
    and errors):
    - the golden corpus and an export of the parity corpus, every member;
    - disjoint `match_query`/`rank_query`, a best-chunk change from the rank query, phrase,
      mixed NOT and NOT-only queries, handles with no query word;
    - a non-text matching chunk beside a text chunk, for chunk search, page search and the arm;
    - rarity at cap 0 and 1, several chunks per page, pages inserted in reverse slug order,
      renames, invisible generations, deleted, private and unserved pages, multi-lexeme terms;
    - private high-score and low-id pages that would fill a window, a count, a title cap or a
      `cut`;
    - fuzzy f32 boundaries (exhaustive bound test, the `0.200000001` case, NaN, infinities,
      out-of-range `real`), non-ASCII titles, trigram keys round-trip;
    - writes: put, rename across basename and source, raw `P` delete, delete and recreate, soft
      delete, restore, purge, seal, timeline insert and delete, lead flips, a rolled-back bound
      statement, an injected flush error, OCC conflicts on the same page and on disjoint pages
      sharing words, and wrapper forwarding of `allocate`/counters (check conflict keys);
    - build: format-2 fixture upgrade, crash and reopen before and after the format commit, a
      batch commit and the complete commit, writes during the build (including timeline, lead
      and seal), rebuild racing a writer, a future index version refused, a format-4 store
      refused by a format-3 build, fresh store complete;
    - `verify` finds an orphan posting and a missing posting;
    - NOT shapes: `a & !b`, `a & (!b | !c)`, `(!a | b) & c`, a phrase with a NOT, and `!a`
      alone (asserts the scan was used);
    - a chunk and a page that cross the tsvector size cap and back;
    - a page that matches Title only at weight C is not admitted or counted for the cap;
    - a soft-deleted high-similarity page, scoped and unscoped fuzzy;
    - a seeded random write and query sequence (extra, not the proof);
    - the sparse vector gives the same `ts_rank`/`ts_rank_cd` f32 bits as the full vector over
      `tests/fixtures/tsearch.json`.
11. Tests (TS): the engine-parity suite runs on the Rust arm with the index (default) and once
    in CI with `GBRAIN_RUST_KEYWORD_SCAN=1` (new variable, scan forced).
    `test/engine-parity/coverage.tsv` keeps every keyword row at `serves`, and `rust-tally.tsv`
    keeps or raises every equal count.
12. Bench gate. Timing: `keyword_scale` from `a059d000f9` (copied into this crate's
    `examples/`, unchanged except imports), cited from row 4 of "Open before `rust` can be
    selected" in `docs/designs/RUST_ENGINE.md` at `a059d000f9`, on `dbpedia.py --chunks 200000`
    (50,000 pages, 200,000 chunks): `load ... nosync`, `queries`, then
    `run <store> queries-200k.json <member> 900 2`, one fresh process per member, for
    `arm chunks pages_count pages_search titles titles_complete fuzzy`. Pass: warm p50 under
    100 ms and p99 under 500 ms for every member, every query measured (no budget-cut sample).
    Correctness: a separate untimed `keyword_scale verify` mode runs every query through the
    index and through the forced scan on the same store and compares full canonical result
    bytes; it adds scoped, private-saturation, handle, disjoint match/rank and cap-boundary
    queries, and it records per query whether the index or the scan answered (NOT-only must be
    the scan). Also reported: NOT-only fallback latency, load time with the index, build time on
    a v2 store, store size, peak RSS, a bounded durable `put_page` and concurrent-writer sample
    (separate from `nosync` load), and the 10k quick check. `cargo test` stays a debug build
    (one `should_panic` test checks a `debug_assert`).
13. Docs: `rust/docs/store/keyword.md` (keys, write path, build, verify), the `R` row in the
    `keys.rs` docs, row 4 of "Open before `rust` can be selected" with the new table, an entry
    in `docs/architecture/key-files/engines-2-continued.md` for each new module, and a bench
    provenance note in `rust/bench/corpus/` (dataset revision
    `4a9731217921bc476a0f03544f11f22ae4903fa5`, source URLs, the dataset licence and the
    DBpedia/Wikipedia upstream attribution). Generated corpus text and embeddings are never
    committed or shipped. The PostgreSQL and Snowball notices in `third-party/` stay.

Out of scope: CJK keyword search (the Rust members refuse it today), a non-English text search
configuration, the legacy BM25 `Store::search_keyword`, any change to PGLite or Postgres, any
change to a member's privacy contract, and selecting Rust as the default engine (other rows of
"Open before" stay open).

Risks:
- Write cost. A `put_page` with 4 chunks adds about 250 posting writes (estimate). The durable
  commit is 53 to 84 ms per page today (row 6); the bench reports the added time.
- Common words and OR queries still read long postings lists; the index is not sublinear in
  the worst case. NOT-only queries keep the scan. Both are reported, not hidden.
- A missed input to the page vector (a new writer of timeline, lead or seal records). The
  wrapper keys on record families, and the write tests cover each writer.
- Store size grows about 40 to 55 percent (estimate). Reported by the bench.

## Review record

- gstack /autoplan (lean run, one reviewer, eng and CEO lenses), 2026-11-19 UTC, on v1 of this
  plan: changes required, 0 Critical, 6 High, 3 Medium, 2 Low. Every finding is folded into v2
  (see "Not decisions"). The eng round was used, so v2 and v3 are not re-reviewed by gstack; the
  gate lists the unreviewed delta.
- Second model (GPT-5 through `gstack-outside-voice`, supplied plan text only, no repository
  access), on v2: approve; 1 Medium (the NOT boundedness rule) and 6 Low (title cap order,
  builder walk, oversize vectors, fuzzy soft-deleted pages, wrapper order, NOT-only proof).
  All are folded into v3. gstack marks this voice `unverified` because it had no repository
  access.
- Not done: no code was built, no test or bench of the index ran. The baseline numbers above
  are the only measurements.
- Approval, 2026-11-19 UTC: the Rust engine lead (Ember) answered the gate with "rec" for all 10
  items (D1a D2a D3a D4a D5a D6a D7b). This is Ember's ruling, not Garry's, under Garry's
  standing approval for this lane. The gate records it as `--by agent:ember`. The build is one PR
  (D7b), pushed as stacked commits: the writers first, then chunk and page postings, then
  trigram postings with the f32-safe fuzzy bound, then format 4 with the resumable build, verify
  and rebuild.
