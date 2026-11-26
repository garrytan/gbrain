# keyword: keyword search, keyword paging and title trigrams

Code: `rust/crates/gbrain-store/src/keyword.rs` and its `keyword/` modules, the napi methods in
`rust/crates/gbrain-napi/src/families/keyword.rs` and the members in
`src/core/rust-engine/store-members/keyword.ts`. The references are `src/core/engine-sql/pages.ts`
(`findByTitleFuzzy`), `src/core/search/keyword-statement.ts` with `src/core/engine-sql/keyword-pages.ts`
(`searchKeyword`, `countKeywordPages`, `searchKeywordPages`), `src/core/search/title-statement.ts` with
`src/core/engine-sql/titles.ts` (`searchTitles`) and the `searchKeywordChunks` statement in `pglite-engine.ts` and
`postgres-engine.ts`.

## Members

| Member | State |
|---|---|
| `findByTitleFuzzy(name, dirPrefix?, minSimilarity?, sourceId?)` | served (`keyword/title_fuzzy.rs`) |
| `findFuzzyEntityCandidates(sourceId, title, fragment)` | served (`keyword/entity_fuzzy.rs`): live, unretired pages of the source whose lowercased title passes `%` against `title` or whose slug contains `fragment` (`ILIKE`), scored by the greater of `similarity(lower(title), title)` and `similarity(slug, fragment)`, best score then slug bytes, at most five |
| `searchKeyword(query, opts?)` | served (`keyword/arm.rs`), with the hybrid keyword arm's options; CJK in `keyword/cjk.rs` |
| `searchKeywordChunks(query, opts?)` | served (`keyword/chunk_search.rs`); CJK in `keyword/cjk.rs` |
| `countKeywordPages(query, opts?)` | served (`keyword/page_search.rs`) |
| `searchKeywordPages(query, opts, page)` | served (`keyword/page_search.rs`) |
| `searchTitles(query, opts?)` | served (`keyword/titles.rs`), the hybrid title arm |

The building blocks are stable and shared with other families: the pg_trgm scorer (`keyword/trgm.rs`), the `english`
text search port (`keyword/tsearch.rs`, `keyword/parser.rs`, `keyword/stem.rs`) and the `ts_rank` / `ts_rank_cd`
rankers (`keyword/rank.rs`). Their signatures are listed in the `keyword.rs` header.

### Refusals (`engine_capability_missing`)

Every keyword member except `findByTitleFuzzy` refuses:

- a text search configuration other than `english` (`getFtsLanguage()`): the keyword index holds English postings.
  The query-time readers in other families (the saved-facts match, `wordLexemes`, the facts keyword arms) also
  serve `german` (`keyword/stem_german.rs`); a configuration without a Snowball port refuses everywhere;
- a date bound (`afterDate`, `beforeDate`) that is not an ISO date or date-time
  (`YYYY-M-D[( |T|t)H:MM[:SS[.f…]][Z|z|±HH[:MM]]]`) or that is outside the calendar. A fraction of any length rounds
  to the nearest microsecond, a tie to the even one, as Postgres's `rint` does, and may carry into the next second.
  Postgres reads more shapes (`Jan 5 2026`); those refuse rather than guess;
- a `where` that is not an object of non-empty lists of strings, numbers and booleans: the SQL engines read only the
  normalized form and fail on anything else;
- an offset, page limit or page offset that is not a whole number of 0 or more, a non-finite `after.score` and a
  non-integer `after.page_id`: Postgres rejects them as a `bigint`;
- any option the member does not know.

`searchKeywordChunks` applies `type`, `types`, `where` and `exclude_slugs` like the page members, as both SQL
engines do.

### Visibility

`excludePrivate`, `requireSafeChunks`, `minTrust` and `suppressFlagged` are served by every keyword member except
`findByTitleFuzzy`, as `buildVisibilityClause` (`src/core/search/sql-ranking.ts`) adds them, before any rank, limit
or count. The policy is part of every statement of a member (the matching and rare-term arms, the handles retry and
the fallback arms), so a hidden page never takes a result slot and a limit counts only visible pages:

- `excludePrivate`: the TS member sends the store page policy (`storePagePolicy`), and the page filter drops a page
  `facts/privacy.rs` `page_hidden` hides (`privatePagesFilterForCaller('p')`). A caller whose record holds only a
  reader identity and a private-readable grant is served with both (the `callerReaders` opt-in); any other caller
  whose policy differs (folder grants, lineage, an owner read) refuses.
- `requireSafeChunks`, which an `excludePrivate` read asks for unless it says otherwise (`requireSafeChunks ??
  excludePrivate`, `requiresSafeChunks`): the page filter drops a page whose `chunker_version` is short of
  `SAFE_FENCE_CHUNKER_VERSION` or not recorded (`safeChunksFilter('p')`).
- `searchTitles` applies the policy to every attempt of its title statement. A safe-chunk `searchTitles` runs every
  attempt as the `title` kind, as `buildSearchTitlesStatement` makes the statement title-only and uncapped (every row
  is a `title` match, as `title-statement.ts` renders it): no attempt matches a page on its timeline and none is cut, so
  a page whose only match is its timeline is not returned, and a page limit and the page count read only visible
  pages. A hybrid search with `excludePrivate` therefore reaches its title arm without a refusal.
- `minTrust` (`trustFloorSql('p')`): the page filter drops a page whose stamped trust tier (`PageRecord::trust_tier`,
  `unknown` when none) ranks below the floor. An empty floor keeps every tier; a name that is no tier refuses.
- `suppressFlagged` (`activationSuppressedSql('pages', 'p')`): the page filter drops a page at or below
  `agent_written` that holds a `flag` write-gate receipt in an activation reason family
  (`trust::activation_suppressed`).

The page policy carries a third setting, `ownerOnly`, read from the same canonical text: the owner-only rule of
`accessAllowedSql` (`src/core/access/owner-only.ts`), which hides a page from every caller but the owner. `lineage` (a
brain at schema v320 or above, which is how the store reports itself) hides a page held in an owner-only source
(`sources.config` with `owner_only` true, or kind `imessage`) and a concept or question with a `concept-provenance`
input page in one; `closed` (a call outside an engine scope, or a brain below v320) hides every page while the brain
holds an owner-only source. A text that holds neither form refuses. `entityPrivacy: false` does not drop it. Under `lineage`
a page named in `owner_only_marks` is hidden too, and under either form a mark keeps the guard on after the last
owner-only source is gone. `remove_page` writes the marks the SQL delete trigger writes (v322): when the page being
deleted is itself owner-only lineage (strict form), it marks that page and each concept or question that names it as a
`concept-provenance` `synthesized_from` input, so a derivative stays hidden after its owner-only input is deleted for
good, even when the source is later flipped off. The marks live under `M owner_only_mark/<table>/<row id>`; a page delete
also marks the page's takes and timeline rows and every row derived from them through `derivation_inputs`. Removing
only the provenance link, or turning the owner-only flag off with nothing deleted, records no mark, as in SQL. A page
whose recorded inputs reach an owner-only row, transitively, is hidden too ([facts.md, "Derivation inputs"](facts.md#derivation-inputs-generationsderivation_inputsrs)). The
engine serves no source delete yet, so a page is deleted by `deletePage`, `deletePages` or `purgeDeletedPages` here.

`ownerOnlyMarkTriggers` (doctor's `owner_only_marks_triggers`, `owner_only_marks.rs` `owner_only_mark_state`) reads the
state the SQL member reads from the triggers, the marks and the catalog. No trigger is ever missing: the store marks in
code on every delete path, so `ensure` has nothing to create. It never writes the SQL `*` marks (`unguarded`, a delete
trigger was missing; `row_security`, a delete by a login whose reads row-level security limits), so `closed` and
`rowSecurity` are false. `held` is true while the brain holds an owner-only source or a mark; SQL's held flag also
stays set after the last owner-only source is turned off with nothing deleted, which no doctor message prints. The
store has no database logins and no row-level security, so no login reads lineage closed (`closedLogins`) or cannot
add marks (`deniedLogins`), and its marks need no held flag a data copy could drop (`unflagged` is false). `role` is
`postgres`, the role PGLite reports, which only the fix line of a missing trigger prints.

The safe-chunks rule keeps a page only when its recorded `chunker_version` is at least the safe fence chunker (4), as
SQL's `chunker_version >= 4`: a page with no recorded version is dropped too (the comparison is NULL). The store stamps
4 when `sealChunks` seals a page's chunks (a put's own chunks are not certified and never stamp 4) and -1 when a later `upsertChunks` changes them (`chunk_queries.md`).

The origin checks of the policy follow slug aliases and rename history as PGLite does (`facts/privacy.rs` reads them
through `aliases.rs`), so an origin that a rename moved still reaches its page.
`keywordRareTermPages` takes no options; PGLite's rare-term statement applies no privacy filter, so neither does the store.

Ignored, as in the SQL statements: the vector, reranking, recency and reporting options (`onVectorPoolMeta`,
`cjkKeyword`, `embeddingColumn`, `recencyBoost`, `tokenBudget`, `reranker`, `relationalRetrieval` and the rest of
`NOT_READ` in the TS member), `keywordTimeoutCache` (a statement-timeout cache), `countKeywordPages`'s `timeoutMs`
(only a statement timeout), `searchKeywordChunks`'s `keywordPhrase` (its statement ranks without the phrase factor)
and the paging members' `opts.limit` / `opts.offset` (the `page` window wins). On a CJK query `searchKeyword` and
`searchKeywordChunks` read `orFallback` and `cjkKeyword` (see "CJK queries") and ignore `orFill`, `rankQuery`,
`keywordPhrase` and `onKeywordIncomplete`, as PGLite's CJK branch does.
`searchKeyword` reads `orFallback`, `orFill`, `rankQuery`, `keywordPhrase` and `onKeywordIncomplete` as the hybrid
keyword arm does; `searchTitles` reads `onKeywordIncomplete`. `searchTitles` answers nothing for `language` or
`symbolKind`, as the SQL engines do.

## Keys

The family owns the `R` tag and reads pages, chunks, segment views and sources through their families' readers. Each
chunk-grain member and the title arm scan the live pages, or read the keyword index (below) when it serves.

`R 0x00` is the keyword index state (`keys::keyword_index_state`, JSON `version`, `complete`, `cursor`). While it
exists, every
`Store::write` handle tracks what a write touches (`keyword/index_writer.rs`, `IndexingWriter`, the outer wrapper of the
write handle chain in `lib.rs` `write_chain`): `K` chunk records mark the chunk; `P` page records mark the page, with
the record stored before the statement's first write of the key; `M page_search_timeline/<id>`, `b 0x05 page_id` and
`E page_id ...` mark the page. Other keys mark nothing. The flush at the end of each OCC attempt or bound statement
resolves the touched set and rebuilds each touched document's postings through the inner handle
(`keyword/index.rs` `reindex_chunk`, `reindex_page`). The wrapper forwards `allocate`, `raise_counter`, `add_i64` and
`counter_below`, and so must every wrapper inside it.

The postings (`keyword/index.rs`, numbers big-endian, `len` two bytes):

| Key | Value |
|---|---|
| `R 0x01 len lexeme page_id chunk_index` | the chunk vector's positions for the lexeme, two bytes each |
| `R 0x02 len lexeme page_id` | the same for the page vector (`titles.rs`) |
| `R 0x03 len trigram page_id` | empty: one raw pg_trgm trigram of the page's title (`trgm.rs`, CRC-compacted for multibyte characters), soft-deleted pages included |
| `R 0x04 len basename page_id` | empty: the page's slug basename, for the handle arm (a basename over 65,535 bytes has none) |
| `R 0x05 page_id chunk_index`, `R 0x06 page_id` | the forward record: the postings the document owns, `kind(1) len(2) text` each |

The postings are the output of the same `chunk_vector` and page vector code the scan reads, so the store has one
tokenizer. A vector past the tsvector size cap has no postings and matches nothing, as in the scan. A reindex deletes
the postings the forward record lists and the new vector lacks, and writes only the entries that changed.

The postings serve a read when the state in its snapshot is complete and of `INDEX_VERSION`, and
`GBRAIN_RUST_KEYWORD_SCAN=1` is not set. A member reads the postings of every lexeme of its match, rank and phrase
queries, takes the candidates from the match query's tree (an AND or phrase intersects its bounded sides, an OR unions
two bounded sides; a NOT, a stop word or an OR with an unbounded side has no bound and the member scans), and gives
each candidate a sparse vector of those lexemes. `ts_matches`, `ts_rank` and `ts_rank_cd` read only the query's
lexemes, so the sparse vector gives the full vector's answer and score bits. `keyword/walk.rs` reads the candidate
pages, applies each member's page and chunk predicates before it reads a chunk, and reads every chunk of a handle page
with its full vector. `keyword_rare_term_pages` visits the pages in `P` key order, as its cap counts in that order;
the other members sort their own results with total tie-breaks.

### Build, verify and rebuild

Store format 4 means the store keeps the postings (`format.rs`). A fresh store is created with a complete, empty
index. The upgrade from formats 1 to 3 deletes every `R` record and writes an incomplete state with cursor 0 in its
own transaction, so a crash leaves the old store or the new one. Every open reads the state
(`keyword/index_build.rs` `open_index`): a state of a newer `INDEX_VERSION` refuses the open with `format_unknown`
before any write; a missing state or an older version is reset the same way; an incomplete state starts the build.

The build runs on a background thread the `Store` owns (`Builder`; off with `OpenOptions::keyword_index_builder`).
Each batch (`build_batch`, 256 pages) reads the next page ids from the `I` family past the cursor, rebuilds each
page's page, trigram and basename postings and its chunks' postings, and writes the new cursor in the same
transaction through `Store::write` and its OCC retry. Only the batch that finds no page past its last one marks the
state complete. Writes during the build keep the documents they touch current, so a page behind the cursor is
current and a page ahead is rebuilt by its batch. Dropping the `Store` stops the thread after its current batch
(waiting up to 30 s); the next open resumes from the cursor. Until the state is complete, every member scans.

| Store API | What it does |
|---|---|
| `keyword_index_state()` | the state (`None` when the store keeps none) |
| `keyword_index_build_step(max_pages)` | runs one batch in its own transaction, for callers that step the build |
| `keyword_index_verify(max_pages)` | rebuilds the expected records of the first `max_pages` pages (all when `None`) and counts the `missing` and `changed` ones; `orphan` counts stored records no page's rebuild has, only after a walk of every page |
| `keyword_index_rebuild()` | deletes every `R` record and writes an incomplete state in one transaction, then starts the build |

The binding and `gbrain doctor` do not expose `verify` or `rebuild` yet.

`Store::open_dir_read_only(dir)` opens an existing brain only to read, for checks such as `keyword_index_verify`
that must not change the store they check. It opens the record file through redb's read-only database
(`redb_kv.rs` `RedbReadOnlyKv`), which takes no write lock, runs no recovery and commits nothing on close: a plain
open commits redb's allocator state when it closes, so it changes bytes of `records.redb` even when nothing was
written. The builder does not run. Every write is refused with `read_only_transaction`, and so is an open that
would have to write: no records yet, a format before 5 (the upgrade) or an index state to reset. `store_io` names
a missing record file or one not closed cleanly (redb repairs only on a writable open); `store_locked` means a
writable handle has the brain open. Pinned by `tests/read_only.rs` (the record file and `FORMAT` keep every byte
across a keyword search and `keyword_index_verify`) and the format-1 case in `tests/lifecycle.rs`.

### Scale

Measured with `keyword_scale` (`crates/gbrain-store/examples/keyword_scale.rs`) on the bake-off corpus at 50,000
pages and 200,000 chunks (`rust/bench/corpus/dbpedia.py --chunks 200000`; where the text comes from and its licence
are in `rust/bench/corpus/PROVENANCE.md`). A release build, the store opened with `Store::open_dir`, one fresh
process per member, 30 queries per member (35 for `fuzzy`), every query measured, pass 2 of 2. With 30 queries the
p99 is the slowest query. "Scan" is the same member with the index forced off (`GBRAIN_RUST_KEYWORD_SCAN=1`).

| Member | p50 ms, index (scan) | p99 ms, index (scan) | Peak RSS MiB, index (scan) |
|---|---|---|---|
| `arm` | 5.4 (8,121) | 203 (8,868) | 405 (650) |
| `chunks` | 5.8 (7,764) | 157 (8,182) | 396 (667) |
| `pages_count` | 6.2 (7,649) | 127 (7,738) | 361 (648) |
| `pages_search` | 5.8 (7,774) | 162 (8,145) | 402 (648) |
| `titles` | 0.1 (540) | 2.5 (663) | 24 (454) |
| `titles_complete` | 0.1 (497) | 2.2 (508) | 23 (435) |
| `fuzzy` | 3.4 (393) | 10.8 (469) | 30 (359) |

The first query after open takes 45 to 58 ms on the four body members. Every
member is under 100 ms at p50 and 500 ms at p99.

- Build from a format 2 store: 196 batches of 256 pages in 505 s. The build is bound by the durable commit of each
  batch (the thread uses about 8% of a CPU), and it peaks at 1.04 GiB RSS.
- Size: the file is 2.23 GB after the build. Compacted, it is 1.37 GB; the same brain before the index compacts to
  0.86 GB, so the index adds 0.51 GB compacted. The postings (`R` keys and values) are 222 MB in 7,195,328 records. The
  build leaves about 0.86 GB of free pages in the file.
- `keyword_index_verify(None)` (`index-check`) takes 21 s and reads 1.0 GiB RSS: 7,195,327 postings expected, 0
  missing, 0 changed, 0 orphan.

NOT-only queries (`-word`) have no candidate bound, so they scan, and they are not faster with the index. At this
size `keyword_scale not-only` gives a p50 of 10.3 s for `arm`, 10.2 s for `chunks`, 9.9 s for `pages_search` and 2.3 s
for `pages_count`.

Writes keep the index current in the same transaction. `keyword_scale writes` on a copy of the 200,000-chunk store:
200 durable `put_page` calls took a p50 of 208 ms (p99 318 ms). Body queries while a writer ran had a p50 of 8.5 ms,
against 6.7 ms alone; title queries were 0.20 ms in both cases. The index check after those writes found 0 missing,
0 changed and 0 orphan postings. The store has no way to run without the index, so there is no baseline for the put
cost without postings.

`verify` at this size (512 cases on the bench corpus, 544 with the private-page fixtures on a copy) found 0 mismatches
between the indexed and the forced-scan result bytes for every member.

To rerun: the header of `keyword_scale.rs` lists every mode and the full recipe (`load ... nosync`, `queries`,
`build`, `run <store> <queries> <member> 900 2` once per member, `index-check`, `verify`, `sizes`). `index-check`,
`sizes` and `verify` without `fixtures` open the store read-only, so the file keeps every byte. `verify` is the
untimed correctness mode: it runs each query through the index and through the forced scan on the same store and
compares the full result bytes, and `writes` times durable `put_page` calls and queries during writes.

## The vector cache

The store keeps no `search_vector`, so each member rebuilds a chunk's or a page's vector from its text. Rebuilt
vectors go into a process-wide cache (`keyword/vector_cache.rs`):

- The key is the exact input: the text search configuration (`english`), the vector kind (chunk, sealed page vector,
  trigger page vector), and every text the vector is built from, each with its byte length. A vector is a pure function
  of its key, so a hit is always the vector a rebuild gives. No write clears the cache; it is safe for a store bound to a
  transaction and across stores in one process.
- The bound is `VECTOR_CACHE_BYTES`, 64 MiB of keys and vectors (an estimate of their heap size). The cache keeps two
  generations: a hit in the older one moves to the newer one; when the newer one holds half the bound, the older one is
  dropped. An entry larger than half the bound is not cached. A rebuild that fails (a vector over the size limit) is not
  cached.
- Timing (release build, 2,000 pages, 4,000 chunks of about 150 words, `searchKeywordChunks`, limit 20): before the
  cache, every query took 365-390 ms, of which reading pages and chunks was about 10 ms and `to_tsvector` the rest.
  With the cache, the first query takes about 340 ms (it fills the cache) and later queries take 16-22 ms. The cache
  holds about 19 MB for these 4,000 chunks.

## Query size and recursion depth

PostgreSQL walks a tsquery recursively and calls `check_stack_depth()`, so a query of enough operands fails with
`stack depth limit exceeded` (54001). The port's parser cleanup, `@@` executor, `ts_rank_cd` cover search and the
facts OR builder recurse the same way, once per item, and the stack of the thread that calls them is not ours to size.

- A query with more than 1,024 items runs those walks on a scoped thread with a 256 MiB stack (address space is reserved,
  not committed). Smaller queries run in place. A search starts that thread once for its whole walk over the
  candidates (the page search, each title attempt, the facts keyword arm), not once per candidate, and a walk that is
  already on the deep thread runs in place.
- A query is refused with `invalid_argument` ("stack depth limit exceeded: a tsquery holds at most 131072 items") when
  the parser holds more than 131,072 items, counted before stopword cleanup. Repeated stopwords count, because a
  stopword placeholder carries no lexeme bytes and so never reaches the `MAXSTRPOS` check ("value is too big in
  tsquery"). The bound is at the parser, so every keyword member (chunk, page, title and facts arms) has it.
- `searchTitlesAttempts` ORs the texts of one attempt (`tsquery_or_all`, the left fold of `||`). The same item bound holds
  for the whole chain, counting an operator per join of two nonempty queries (a text that parses to nothing, such as a
  stopword, adds neither an item nor an operator, as `||` skips it): an attempt whose texts add up past 131,072 items is
  refused with the same error, and one of exactly 131,072 is answered. The check runs while the texts parse, so the
  work stays linear in the texts. The chain is laid out once rather than copied at each `||`. The boundary is a Rust
  unit test (`keyword/titles.rs`): PGLite runs out of stack long before it.
- PGLite 0.5.16 answers a query like `quokka the ` x 20,000 (about 80,000 items) through `@@`, and runs out of its 2 MB
  stack for the whole `searchKeyword` statement at a few thousand repeats, where it returns an empty result with no
  error (the limit is not a fixed number: 4,000 repeats failed and 4,500 passed in one run). The Rust engine answers
  every query up to the bound and throws past it. A test of the thrown error cannot be a parity case, because the
  expected-divergence rows cover only an answer that differs from PGLite's, never a thrown error. The parity case
  (`test/engine-parity/search-deep-query.test.ts`) uses 1,000 repeats (2,000 operands), under both limits: on macOS arm64
  PGLite already returns the empty result at 3,000 repeats.

## A chunk whose vector does not fit

`content_chunks`' `chunk_search_vector_trigger` builds the weighted vector (doc comment and qualified symbol name at A,
text at B) before the row is stored, and `to_tsvector` / `||` raise "string is too long for tsvector (N bytes, max
1048575 bytes)" (54000) past the cap. The error aborts the whole `upsertChunks` / `sealChunks` statement. The store
builds the same vector in `chunks::write_chunk` (`keyword::check_chunk_vector`, which also warms the vector cache)
and refuses the write with the same message, in the same transaction, so no chunk of the batch is stored.

A store written before that check may hold such a chunk, which SQL can never hold. Every member that reads chunk
vectors (`searchKeyword` arms, chunk-grain and page-grain search, the page count and the rare-term arm) treats it as
matching nothing (`filters::readable_chunk_vector`) rather than failing the search that passes over it. There is no
SQL behavior to compare that read with, so it is covered by Rust unit tests only.

## A page whose vector does not fit

`pages`' `trg_pages_search_vector` (`BEFORE INSERT OR UPDATE OF title, timeline`) builds the page vector before the row is
stored, and the same \"string is too long for tsvector\" error aborts the `putPage`. The title is unbounded (the timeline
and the entries are cut to 65,536 and 32,768 characters), so a title of about 100,000 distinct tokens is enough. The store
builds the trigger-form vector in `pages::write_page` whenever the page is new or its title or timeline changed, and in
`pages::write_page_setting_vector` on every call (`keyword::check_page_vector`, which also warms the vector cache). The
second form is for the statements that SET `title` and `timeline` whatever their values (`putPage`, the body refresh, the body flip): the trigger fires with unchanged values too, and the vector can have grown since (a timeline entry
added, a lead published), so a repeated `putPage` is refused when the page no longer fits. The flip stores its body state (with the
incoming `timeline_lead`) before it writes the page, so the check reads the lead the flip publishes and not the one it
replaces: a flip to a short lead is accepted whatever the old lead was, and one whose title and lead overflow is
refused whole. Every write path that sets
them refuses with the same message and stores nothing, with or without chunking (`index: false`). A seal that sends a search timeline
(`pages::record_search_timeline`, from `upsertChunks` with `seal` and from the segmented seal) builds the sealed-form
vector (`keyword::check_sealed_page_vector`) and refuses the same way, since `pageSearchVectorSql` builds it in the
seal's statement.

A store written before those checks may hold a page SQL can never hold. `searchTitles` treats its vector as matching
nothing (`titles::readable_page_vector`, which skips only the size error) rather than failing every search in its
scope. The refusal is a parity case (`test/engine-parity/page-vector-overflow.test.ts`; the arm's `putPage` always writes
with `index: false`); the chunking path, the repeated `putPage` that no longer fits and the stored page are Rust unit tests in
`keyword/titles.rs` (before #9779 the SQL engines refused a title of about 8 KB in the btree `idx_pages_source_title_lower`;
the hash index `idx_pages_title_lower_hash` that replaced it holds a title of any length).

## The page filter

`keyword/filters.rs` models `keywordFilters` and the live clause of `buildVisibilityClause`: a page is kept when it is
not soft-deleted, its text projection is served (`text_projection_revision` equals `knowledge_revision` or the
activation sentinel `…0153`), it has no `quarantine` or `pinned_question` frontmatter key, it passes `type`, `types`,
`exclude_slugs`, the source list, the hard-exclude prefixes and every `where` entry, its date (`effective_date`, else
`updated_at`) is inside the bounds, and its source exists and is not archived. A chunk is kept when it is visible at
the page's segment generation and passes `detail: 'low'` (`chunk_source = 'compiled_truth'`), `language` and
`symbolKind` (the chunk metadata). The paging members also keep only `modality = 'text'` chunks.

The TS member resolves every default before the call: `resolveHardExcludes` (with `GBRAIN_SEARCH_EXCLUDE`), the boost
arms of `buildSourceFactorCase` (none for `detail: 'high'`, else the valid prefixes longest first), the slug handles
(`slugHandles(query, true)`), `collapseWebsearchDashRuns` for the chunk query, `clampSearchLimit` with its warning,
and the `where` containment forms (the value, plus the number or boolean a string spells).

## Scores

A chunk's vector is `setweight(doc_comment, A) || setweight(symbol_name_qualified, A) || setweight(chunk_text, B)`,
each through `gbrain_fts_input`. The score is the `double precision` product, left to right, of the f32 `ts_rank`, the
phrase factor (2 when `keywordPhrase` and the `phraseto_tsquery` matches) and the source factor (1 for an
auto-extracted unverified page). A handle page (its slug basename is a handle) scores `(1 + rank × phrase) × factor`
and matches even without a text match. Pages take their best chunk (highest score, then the lower chunk id) and sort by
score descending, then page id; chunks sort by score, page id and chunk id. `countKeywordPages` stops at 10,001.

## searchKeyword (the hybrid keyword arm)

Hybrid's keyword arm (`search/hybrid/arms.ts`) calls `searchKeyword` with `keywordTimeoutCache`, and with
`orFallback`, `orFill`, `rankQuery` and `keywordPhrase` when the caller sets them. The TS member runs PGLite's
orchestration (`keywordArmRows`: the strict statement, the identifier probe, the slug handles, the OR retry ranked by
term rarity with `rankOrFallbackByRarity`) and the store answers each statement:

- `searchKeywordArm(match, rank, options)`: chunks matching `websearch_to_tsquery(match)`, scored with
  `ts_rank(vector, websearch_to_tsquery(rank))` × phrase factor × source factor, the best chunk per page, the
  `innerLimit` (`min(limit × 3, cap × 3)`) inner window, then `offset` and `limit`.
  `websearch_to_tsquery` separates words on ASCII whitespace and on the non-ASCII characters of PGLite's
  `[[:space:]]` class (U+0085, U+2000-U+200A except U+2007, U+2028, U+2029, U+205F, U+3000), as the repository's
  PGLite (0.4.3) does; PostgreSQL 18 reads only ASCII whitespace there, so the goldens taken from PGLite 0.5.16
  (PostgreSQL 18.6) hold none of these characters.
- `keywordRareTermPages(terms, cap)`: per term, the pages holding it, up to `RARE_TERM_CHUNK_CAP` chunks.
- the slug handles go through `searchKeywordPages` with `handlesOnly`.

The search and query ops check the `where` filter once more on their finished rows (`keepFrontmatterMatches`), since
some arms add pages outside the filtered statements. `filterPageIdsByFrontmatter(ids, where)` (`keyword/frontmatter_ids.rs`)
answers that check: the ids, ascending, whose page frontmatter holds every key, by the same `frontmatter_holds` rule as
the keyword and vector filters. Like the SQL (`SELECT p.id FROM pages p WHERE p.id = ANY($1)` plus the containment
clauses), it reads every page row, a soft-deleted one included.

The core BM25 member (`store-members/search.ts`) is gone; its napi method and `Store::search_keyword` stay, unused.

## CJK queries

A query with a CJK character (`hasCJK`) skips text search, as in both SQL engines. The match terms are
`cjkMatchTerms(query)`: the whitespace-split terms, deduplicated, each with a trailing Korean particle stripped. A term
whose lower and upper case differ matches with ILIKE, any other with LIKE (`likeClauses`). The TS member sends the
terms with their operator; the store does not split the query.

- `searchKeyword` and `searchKeywordChunks` call `searchKeywordCjk(query, options, run)` (`keyword/cjk.rs`), the port
  of `src/core/search/cjk-keyword-sql.ts` as `engine-sql/cjk-search.ts` runs it on PGLite. A chunk matches when it
  holds every term (strict). Its score is, in `double precision`, the sum of the non-overlapping occurrences of each
  term (`REPLACE` is case-sensitive, so an ILIKE match of another case counts 0), plus the occurrences of the raw query
  when there are two or more terms, plus `1 / position` of the raw query (1-based in characters, through a `real`, 0
  when absent), times the source factor. Rows sort by score, then page id, then chunk id; `searchKeyword` keeps the
  best text chunk per page from the first `innerLimit` rows, then applies `offset` and `limit`. `searchKeywordChunks`
  keeps every chunk, image chunks included.
- `orFallback` with two or more raw terms (`splitCJKQueryTerms`, before the particle strip): when the strict rows are
  fewer than `limit`, every chunk holding any term ranks by `1000 × matched terms + score`.
- `cjkKeyword` is the bounded arm. When the brain holds more than `pgliteCappedChunks` (50,000) chunks, the store scores
  only the first `candidateCap` (2,000) strict candidates, then partial ones for the OR fallback, and the member reports
  `onMeta` with `capped` and, when a stage filled the cap, `incomplete: 'candidate_budget'`. PGLite compares
  `pg_class.reltuples`, an estimate; the store compares its exact chunk count. PGLite takes candidates in heap order;
  the store takes them by ascending chunk id, the order of a freshly written heap. Postgres bounds the same arm by a
  statement deadline instead, so the arms are not compared in the parity suite.
- `countKeywordPages` and `searchKeywordPages` send `cjkTerms`: a page matches when one of its text chunks holds every
  term, scored by the sum of the term occurrences times the source factor (`buildKeywordMatch`'s CJK arm). The slug
  handles do not apply, and `handlesOnly` matches nothing.
- `searchTitles` runs its usual statements on a CJK query, as both SQL engines do.

ILIKE folds case with `pg_lower`, the store's port of the C.UTF-8 collation PGLite uses. A Postgres database with
another collation (`en_US.utf8`) can fold some non-ASCII letters differently; ASCII folds the same everywhere.

## searchTitles (the hybrid title arm)

The TS member runs `engine-sql/titles.ts`: the strict attempt over the whole page vector; when more pages match than
`titleWholeVectorCandidates()` (5,000), `onKeywordIncomplete('candidate_budget')` and the title-only attempt leads; with
no strict rows past the offset, the any-word retry (`buildOrFallbackWebsearchQuery`) ranked per word by rarity
(`rankByRarity`, at most `RARITY_MAX_TERMS` words and no offset), with rows that hold every identifier token first and
the rest tagged `keyword_relaxed`. Every attempt ORs in the given-name variants (`titleNameVariants`). The store runs a
list of attempts over one read (`searchTitlesAttempts`); the rows sort by exact title (`lower(btrim(title, ' "''' ||
chr(160)))` against `normalizeAlias(query)`), then `ts_rank_cd(vector, q) × source factor`, then page id.
Each row carries one representative chunk: a text chunk of the page's live body, as `title-statement.ts` reads it
with `chunkGenerationFilter` (a staged chunk, a chunk of a retired occurrence that a deferred retire left, and an
inline chunk left on a segmented page are never shown), compiled truth first (only compiled truth for `detail` low),
then the lowest chunk index. A page with no such chunk gives `chunk_id` 0 and an empty `chunk_text`.

The page vector is not stored; `keyword/titles.rs` rebuilds the one PGLite last wrote:

- Sealed form, when the page's last seal sent its sanitized timeline (`pages::search_timeline`) and that seal is current
  (its revision equals `text_projection_revision`): title at weight A, `left(sanitized timeline, 65536)` at C.
- Trigger form otherwise: title at A, `left(timeline, 65536)` at C and the page's timeline entries created no later
  than its `updated_at` (`summary || ' ' || detail` by id, `left(…, 32768)`) at C. A page whose revision is not sealed
  is not served at all (the page filter), so this form serves a page sealed without text (the store's own
  indexing `putPage`), an activation page, and a sealed page written again since its seal: every write that sets the
  title or timeline deletes the seal's record (`pages::forget_search_timeline`), as PGLite's trigger rewrites the
  vector then, also for a `putPage` of unchanged input, which keeps the revision and the seal.
- A NULL timeline (a segmented page) reads `timeline_lead` in the trigger form, as the trigger's
  `coalesce(timeline, timeline_lead, '')` does: the lead the page's last flip published (`page_body::timeline_lead`),
  NULL for a shell no flip has published.
- A sealed segmented page takes the sealed form: PGLite's `sealSegmentedPage` writes the title plus
  `sanitizeRemoteBody` of the lead with withdrawals and purges overlaid. Only TypeScript computes that text, so the
  family that seals segmented pages records it with `pages::record_search_timeline` (page_body's
  `sealSegmentedPage`), so a sealed segmented page is searchable by its title and lead.


- `stale` on `searchKeywordChunks`, `searchKeyword` and `searchTitles` follows PGLite: true when the newest timeline
  entry is newer than `updated_at`. Postgres always returns `stale: false`. This is the SQL engines' shared dialect
  rule (`staleProbe`), not a follow-up.
- `searchKeywordChunks` lets image chunks match, as both SQL engines do; the paging members keep text chunks only.
- `where` compares a JSON number with a number through f64, where Postgres compares `numeric` exactly; numbers past
  2^53 can match differently.
- `message_id` is blank when it is only `[[:space:]]` as PGLite reads it (U+0085, U+2003 and U+3000 count; U+00A0 does not), as the SQL trims it.
- Lexemes of 2047 bytes or more are dropped from the vector, as in PG (`MAXSTRLEN`).
- `searchTitles` trigger form: PGLite's trigger reads the timeline entries that exist when the page row is written;
  the store approximates that with the entries created no later than `updated_at`. A NULL timeline reads the lead
  the page's last flip published.
- `findByTitleFuzzy` without a `sourceId` reads soft-deleted pages too, as the SQL does (follow-up
  `fuzzy-title-unscoped-deleted`). PGLite types `$minSimilarity` as `real`; Postgres may bind it as `float8`, which
  would compare in f64 (not verified).
- `findByTitleFuzzy` through the index reads only the pages whose titles share at least `min_shared(n1, min)` of the
  name's `n1` trigrams (`R 0x03`), then runs the same exact score, `%`, LIKE and source checks. The score is
  `c / (n1 + n2 - c)` divided in f32, at most `c / n1` in real numbers; the bound uses `min` lowered by two f32
  steps, so a rounded score equal to `min` is never lost. A unit test checks the bound against `calc_sml` for every
  `(c, n1)` with `n1 <= 2,048` at its hardest `n2`, and every `n2` for small and large `n1`. Above 2,048 name
  trigrams any shared trigram admits; a `min` of zero, below zero or not finite scans.
- `findByTitleFuzzy`'s `dirPrefix` is a LIKE pattern (`sql_like`): `%`, `_` and `\\` escapes as PostgreSQL reads them. The
  matcher is iterative with one backtrack point (the last `%`), so its work is bounded by the text length times the
  pattern length; a prefix of many `%` groups answers at once (`title-fuzzy-like-bound.test.ts`).

## Follow-ups

- `keyword-lexeme-index`: done. The store keeps a persisted positional lexeme index (above) and the members read it
  once it is complete; a member scans only while the index is incomplete, when `GBRAIN_RUST_KEYWORD_SCAN=1` is set,
  for a query with no candidate bound (a NOT-only query), or for the CJK substring members, which match chunk text and which the lexeme index cannot narrow (`keyword/cjk.rs`). A scan, and a cold vector cache after a start or after the
  text outgrows the 64 MiB cache, still rebuilds every vector it reads.
- `fuzzy-title-unscoped-deleted`: the SQL unscoped arm returns soft-deleted pages.
