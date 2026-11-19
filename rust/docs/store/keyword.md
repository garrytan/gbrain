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
| `searchKeyword(query, opts?)` | served (`keyword/arm.rs`), with the hybrid keyword arm's options |
| `searchKeywordChunks(query, opts?)` | served (`keyword/chunk_search.rs`) |
| `countKeywordPages(query, opts?)` | served (`keyword/page_search.rs`) |
| `searchKeywordPages(query, opts, page)` | served (`keyword/page_search.rs`) |
| `searchTitles(query, opts?)` | served (`keyword/titles.rs`), the hybrid title arm |

The building blocks are stable and shared with other families: the pg_trgm scorer (`keyword/trgm.rs`), the `english`
text search port (`keyword/tsearch.rs`, `keyword/parser.rs`, `keyword/stem.rs`) and the `ts_rank` / `ts_rank_cd`
rankers (`keyword/rank.rs`). Their signatures are listed in the `keyword.rs` header.

### Refusals (`engine_capability_missing`)

Every keyword member except `findByTitleFuzzy` refuses:

- a CJK query (`hasCJK`): the SQL engines take a separate CJK path (follow-up `keyword-cjk`);
- a text search configuration other than `english` (`getFtsLanguage()`);
- truthy `requireSafeChunks`, `minTrust` or `suppressFlagged`: the store does not record trust tiers or flags, and a
  safe-chunks rule stands alone only with `excludePrivate` (see below);
- truthy `excludePrivate` on `searchKeywordChunks`, `countKeywordPages` and `searchKeywordPages` (`searchKeyword`
  and `searchTitles` serve it, see below; `searchVector` serves it, `vectors.md`);
- a date bound (`afterDate`, `beforeDate`) that is not an ISO date or date-time
  (`YYYY-M-D[( |T)H:MM[:SS[.ffffff]][Z|±HH[:MM]]]`), that is outside the calendar, or that has more than six fraction
  digits. Postgres reads more shapes (`Jan 5 2026`); those refuse rather than guess;
- a `where` that is not an object of non-empty lists of strings, numbers and booleans: the SQL engines read only the
  normalized form and fail on anything else;
- an offset, page limit or page offset that is not a whole number of 0 or more, a non-finite `after.score` and a
  non-integer `after.page_id`: Postgres rejects them as a `bigint`;
- any option the member does not know.

### `excludePrivate` (`searchKeyword` and `searchTitles`)

`searchKeyword` and `searchTitles` serve truthy `excludePrivate` with the page policy PGLite adds in `buildVisibilityClause`
(`privatePagesFilterForCaller('p')`), judged by `page_hidden` in `facts/privacy.rs`. The member sends the policy only
when the caller in context renders the same text as the store's no-caller policy (`private-provenance.ts`
`storePagePolicy`); any other caller refuses. The policy is part of every statement of the member (the matching and
rare-term arms, the handles retry and the fallback arms), so a hidden page never takes a result slot and a limit counts
only visible pages. A `requireSafeChunks` beside it is read as PGLite reads it (`requireSafeChunks ?? excludePrivate`).

`searchTitles` applies the same policy to every attempt of its title statement. When the safe-chunks rule is on, the
statement matches titles only (every row is a `title` match, as `title-statement.ts` renders it), so a page whose
only match is its timeline is not returned, and a page limit and the page count read only visible pages. A hybrid
search with `excludePrivate` therefore reaches its title arm without a refusal.

The policy carries a third setting, `ownerOnly`, read from the same no-caller text: the owner-only rule of
`accessAllowedSql` (`src/core/access/owner-only.ts`), which hides a page from every caller but the owner. `lineage` (a
brain at schema v320 or above, which is how the store reports itself) hides a page held in an owner-only source
(`sources.config` with `owner_only` true, or kind `imessage`) and a concept or question with a `concept-provenance`
input page in one; `closed` (a call outside an engine scope, or a brain below v320) hides every page while the brain
holds an owner-only source. A text that holds neither form refuses. `entityPrivacy: false` does not drop it. Under `lineage`
a page named in `owner_only_marks` is hidden too, and under either form a mark keeps the guard on after the last
owner-only source is gone. `remove_page` writes the marks the SQL delete trigger writes (v322): when the page being
deleted is itself owner-only lineage (strict form), it marks that page and each concept or question that names it as a
`concept-provenance` `synthesized_from` input, so a derivative stays hidden after its owner-only input is deleted for
good, even when the source is later flipped off. The marks live under `M owner_only_mark/pages/<page id>`. Removing
only the provenance link, or turning the owner-only flag off with nothing deleted, records no mark, as in SQL. The
store keeps no `derivation_inputs`, so a page that only that table ties to an owner-only row is not hidden by it. The
engine serves no source delete, `deletePages` or `purgeDeletedPages` yet (they refuse with `engine_capability_missing`),
so `deletePage` is the one path that deletes an owner-only page here.

The safe-chunks rule keeps a page only when its recorded `chunker_version` is at least the safe fence chunker (4), as
SQL's `chunker_version >= 4`: a page with no recorded version is dropped too (the comparison is NULL). The store stamps
4 when `sealChunks` seals a page's chunks (a put's own chunks are not certified and never stamp 4) and -1 when a later `upsertChunks` changes them (`chunk_queries.md`).

The origin checks of the policy follow slug aliases and rename history as PGLite does (`facts/privacy.rs` reads them
through `aliases.rs`), so an origin that a rename moved still reaches its page.
`keywordRareTermPages` takes no options; PGLite's rare-term statement applies no privacy filter, so neither does the store.

`searchKeywordChunks` also refuses `type`, a non-empty `types`, a non-empty `where` and a non-empty `exclude_slugs`:
Postgres applies them and PGLite ignores them (follow-up `pglite-keyword-chunks-page-filters`).

Ignored, as in the SQL statements: the vector, reranking, recency and reporting options (`onVectorPoolMeta`,
`cjkKeyword`, `embeddingColumn`, `recencyBoost`, `tokenBudget`, `reranker`, `relationalRetrieval` and the rest of
`NOT_READ` in the TS member), `keywordTimeoutCache` (a statement-timeout cache), `countKeywordPages`'s `timeoutMs`
(only a statement timeout) and the paging members' `opts.limit` / `opts.offset` (the `page` window wins).
`searchKeyword` reads `orFallback`, `orFill`, `rankQuery`, `keywordPhrase` and `onKeywordIncomplete` as the hybrid
keyword arm does; `searchTitles` reads `onKeywordIncomplete`. `searchTitles` answers nothing for `language` or
`symbolKind`, as the SQL engines do.

## Keys

None written. The family owns the `R` tag and reads pages, chunks, segment views and sources through their families'
readers. Every member is a full scan of the live pages (follow-up `keyword-lexeme-index`).

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
  not committed). Smaller queries run in place.
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
- `keywordRareTermPages(terms, cap)`: per term, the pages holding it, up to `RARE_TERM_CHUNK_CAP` chunks.
- the slug handles go through `searchKeywordPages` with `handlesOnly`.

The core BM25 member (`store-members/search.ts`) is gone; its napi method and `Store::search_keyword` stay, unused.

## searchTitles (the hybrid title arm)

The TS member runs `engine-sql/titles.ts`: the strict attempt over the whole page vector; when more pages match than
`titleWholeVectorCandidates()` (5,000), `onKeywordIncomplete('candidate_budget')` and the title-only attempt leads; with
no strict rows past the offset, the any-word retry (`buildOrFallbackWebsearchQuery`) ranked per word by rarity
(`rankByRarity`, at most `RARITY_MAX_TERMS` words and no offset), with rows that hold every identifier token first and
the rest tagged `keyword_relaxed`. Every attempt ORs in the given-name variants (`titleNameVariants`). The store runs a
list of attempts over one read (`searchTitlesAttempts`); the rows sort by exact title (`lower(btrim(title, ' "''' ||
chr(160)))` against `normalizeAlias(query)`), then `ts_rank_cd(vector, q) × source factor`, then page id.

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


- `searchKeywordChunks` page filters: Postgres applies `type`, `types`, `where` and `exclude_slugs`; PGLite drops
  them. The store applies them, but the member refuses them until the engines agree (follow-up
  `pglite-keyword-chunks-page-filters`). No production code calls `searchKeywordChunks`.
- `stale` on `searchKeywordChunks`, `searchKeyword` and `searchTitles` follows PGLite: true when the newest timeline
  entry is newer than `updated_at`. Postgres always returns `stale: false`. This is the SQL engines' shared dialect
  rule (`staleProbe`), not a follow-up.
- `searchKeywordChunks` lets image chunks match, as both SQL engines do; the paging members keep text chunks only.
- `where` compares a JSON number with a number through f64, where Postgres compares `numeric` exactly; numbers past
  2^53 can match differently.
- `message_id` is blank when it is only ASCII `[[:space:]]`, as the SQL trims it; other Unicode spaces count as text.
- Lexemes of 2047 bytes or more are dropped from the vector, as in PG (`MAXSTRLEN`).
- `searchTitles` trigger form: PGLite's trigger reads the timeline entries that exist when the page row is written;
  the store approximates that with the entries created no later than `updated_at`. A NULL timeline reads the lead
  the page's last flip published.
- `searchTitles` refuses CJK queries like the other keyword members; the SQL title statement has no CJK path of its
  own, so this is conservative (follow-up `keyword-cjk`).
- `findByTitleFuzzy` without a `sourceId` reads soft-deleted pages too, as the SQL does (follow-up
  `fuzzy-title-unscoped-deleted`). PGLite types `$minSimilarity` as `real`; Postgres may bind it as `float8`, which
  would compare in f64 (not verified).
- `findByTitleFuzzy`'s `dirPrefix` is a LIKE pattern (`sql_like`): `%`, `_` and `\\` escapes as PostgreSQL reads them. The
  matcher is iterative with one backtrack point (the last `%`), so its work is bounded by the text length times the
  pattern length; a prefix of many `%` groups answers at once (`title-fuzzy-like-bound.test.ts`).

## Follow-ups

- `keyword-lexeme-index`: every member still scans every live page and its chunks (about 8-10 ms per 4,000 chunks),
  and the first query after a start, or after the text outgrows the 64 MiB cache, rebuilds every vector. Add a stored
  positional lexeme index when the scan or a cold cache becomes the bottleneck for the brains the store serves.
- `keyword-cjk`: serve CJK queries (the SQL engines' bigram path).
- `pglite-keyword-chunks-page-filters`: PGLite's `searchKeywordChunks` drops `type`, `types`, `where` and
  `exclude_slugs`, which Postgres applies; no production caller. A PGLite behavior change, so it waits until after
  1x parity. Then the member serves the four filters with a parity case.
- `fuzzy-title-unscoped-deleted`: the SQL unscoped arm returns soft-deleted pages.
- Serve `excludePrivate` on the other keyword members (`searchKeywordChunks`, `countKeywordPages`,
  `searchKeywordPages`) and the trust options once the store records them.
