# keyword: keyword search, keyword paging and title trigrams

Code: `rust/crates/gbrain-store/src/keyword.rs` and its `keyword/` modules, the napi methods in
`rust/crates/gbrain-napi/src/families/keyword.rs` and the members in
`src/core/rust-engine/store-members/keyword.ts`. The references are `src/core/engine-sql/pages.ts`
(`findByTitleFuzzy`), `src/core/search/keyword-statement.ts` with `src/core/engine-sql/keyword-pages.ts`
(`countKeywordPages`, `searchKeywordPages`) and the `searchKeywordChunks` statement in `pglite-engine.ts` and
`postgres-engine.ts`.

## Members

| Member | State |
|---|---|
| `findByTitleFuzzy(name, dirPrefix?, minSimilarity?, sourceId?)` | served (`keyword/title_fuzzy.rs`) |
| `searchKeywordChunks(query, opts?)` | served (`keyword/chunk_search.rs`) |
| `countKeywordPages(query, opts?)` | served (`keyword/page_search.rs`) |
| `searchKeywordPages(query, opts, page)` | served (`keyword/page_search.rs`) |
| `searchTitles(query, opts?)` | not built; refuses with `engine_capability_missing` |

The building blocks are stable and shared with other families: the pg_trgm scorer (`keyword/trgm.rs`), the `english`
text search port (`keyword/tsearch.rs`, `keyword/parser.rs`, `keyword/stem.rs`) and the `ts_rank` / `ts_rank_cd`
rankers (`keyword/rank.rs`). Their signatures are listed in the `keyword.rs` header.

### Refusals (`engine_capability_missing`)

All three keyword members refuse:

- a CJK query (`hasCJK`): the SQL engines take a separate CJK path (follow-up `keyword-cjk`);
- a text search configuration other than `english` (`getFtsLanguage()`);
- truthy `excludePrivate`, `requireSafeChunks`, `minTrust` or `suppressFlagged`: the store does not record privacy,
  chunk safety, trust tiers or flags;
- a date bound (`afterDate`, `beforeDate`) that is not an ISO date or date-time
  (`YYYY-M-D[( |T)H:MM[:SS[.ffffff]][Z|±HH[:MM]]]`), that is outside the calendar, or that has more than six fraction
  digits. Postgres reads more shapes (`Jan 5 2026`); those refuse rather than guess;
- a `where` that is not an object of non-empty lists of strings, numbers and booleans: the SQL engines read only the
  normalized form and fail on anything else;
- an offset, page limit or page offset that is not a whole number of 0 or more, a non-finite `after.score` and a
  non-integer `after.page_id`: Postgres rejects them as a `bigint`;
- any option the member does not know.

`searchKeywordChunks` also refuses `type`, a non-empty `types`, a non-empty `where` and a non-empty `exclude_slugs`:
Postgres applies them and PGLite ignores them (follow-up `keyword-chunks-page-filters`).

Ignored, as in the SQL statements: the hybrid, vector, reranking, recency and reporting options (`onVectorPoolMeta`,
`cjkKeyword`, `orFallback`, `rankQuery`, `embeddingColumn`, `recencyBoost`, `tokenBudget`, `reranker`,
`relationalRetrieval` and the rest of `NOT_READ` in the TS member), `countKeywordPages`'s `timeoutMs` (only a
statement timeout) and the paging members' `opts.limit` / `opts.offset` (the `page` window wins).

## Keys

None written. The family owns the `R` tag and reads pages, chunks, segment views and sources through their families'
readers. Every member is a full scan of the live pages (follow-up `keyword-lexeme-index`).

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

## Known differences

- `searchKeywordChunks` follows PGLite: no page filters (they refuse), `stale` computed from the newest timeline entry
  against `updated_at`. Postgres applies the page filters and always returns `stale: false`
  (follow-up `keyword-chunks-page-filters`).
- `searchKeywordChunks` lets image chunks match, as both SQL engines do; the paging members keep text chunks only.
- `where` compares a JSON number with a number through f64, where Postgres compares `numeric` exactly; numbers past
  2^53 can match differently.
- `message_id` is blank when it is only ASCII `[[:space:]]`, as the SQL trims it; other Unicode spaces count as text.
- Lexemes of 2047 bytes or more are dropped from the vector, as in PG (`MAXSTRLEN`).
- `findByTitleFuzzy` without a `sourceId` reads soft-deleted pages too, as the SQL does (follow-up
  `fuzzy-title-unscoped-deleted`). PGLite types `$minSimilarity` as `real`; Postgres may bind it as `float8`, which
  would compare in f64 (not verified).

## Follow-ups

- `keyword-lexeme-index`: every member scans every live page and recomputes `to_tsvector` per chunk per query. Add a
  positional lexeme index (or cache the chunk vectors) when the brains it serves outgrow a scan.
- `keyword-cjk`: serve CJK queries (the SQL engines' bigram path).
- `keyword-chunks-page-filters`: settle which engine is right for `searchKeywordChunks` page filters and `stale`.
- `fuzzy-title-unscoped-deleted`: the SQL unscoped arm returns soft-deleted pages.
- Serve the refused privacy and trust options once the store records them.
