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
or count:

- `excludePrivate`: the TS member sends the store page policy (`storePagePolicy`), and the page filter drops a page
  `facts/privacy.rs` `page_hidden` hides (`privatePagesFilterForCaller('p')`). A caller whose member pages, grants or
  lineage widen the policy refuses.
- `requireSafeChunks`, which an `excludePrivate` read asks for unless it says otherwise (`requiresSafeChunks`): the
  page filter drops a page whose `chunker_version` is short of `SAFE_FENCE_CHUNKER_VERSION` or not recorded
  (`safeChunksFilter('p')`).
- A safe-chunk `searchTitles` runs every attempt as the `title` kind, as `buildSearchTitlesStatement` makes the
  statement title-only and uncapped: no attempt matches a page on its timeline and none is cut.
- `minTrust` (`trustFloorSql('p')`): the page filter drops a page whose stamped trust tier (`PageRecord::trust_tier`,
  `unknown` when none) ranks below the floor. An empty floor keeps every tier; a name that is no tier refuses.
- `suppressFlagged` (`activationSuppressedSql('pages', 'p')`): the page filter drops a page at or below
  `agent_written` that holds a `flag` write-gate receipt in an activation reason family
  (`trust::activation_suppressed`).

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

## Follow-ups

- `keyword-lexeme-index`: every member still scans every live page and its chunks (about 8-10 ms per 4,000 chunks),
  and the first query after a start, or after the text outgrows the 64 MiB cache, rebuilds every vector. Add a stored
  positional lexeme index when the scan or a cold cache becomes the bottleneck for the brains the store serves.
- `keyword-cjk`: serve CJK queries (the SQL engines' bigram path).
- `fuzzy-title-unscoped-deleted`: the SQL unscoped arm returns soft-deleted pages.
