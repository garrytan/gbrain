**The experimental Rust engine's store now answers keyword search, title search, fuzzy title lookup and chunk reads the way PGLite does, but nothing selects it yet; PGLite and Postgres brains are unchanged.**

### Added
- The Rust engine serves `searchKeyword`, `searchKeywordChunks`, `countKeywordPages`, `searchKeywordPages`, `searchTitles` and `findByTitleFuzzy`, so it now reports the `keyword_search` capability. The store carries its own copy of PostgreSQL's English text search (word splitting, stemming, stop words, `websearch_to_tsquery`, `ts_rank` and `ts_rank_cd`) and returns PGLite's scores and order. Search hides the same pages PGLite hides. With `excludePrivate`, `searchKeyword` also hides pages that belong to an owner-only source, and a page that came from an owner-only page stays hidden after that page is deleted for good. `rust/docs/store/keyword.md` lists what each member accepts and refuses.
- The Rust engine serves the chunk reads `getChunkPage`, `getChunkWindows`, `countChunklessPagesWithContent` and `listChunklessPagesWithContent`, including for pages stored in segments (`rust/docs/store/chunk_queries.md`).
- A put that would store a chunk or a page whose search vector is too large for PostgreSQL's limit is refused with PostgreSQL's own "string is too long for tsvector" message and stores nothing, and a repeated `putPage` is refused when the page no longer fits.
- A search query with more than 131,072 items is refused with `invalid_argument`, where PGLite runs out of stack on a few thousand. Searches reuse the vectors they have already built, so a repeated query is much faster than the first (about 20 ms against about 350 ms on a 4,000-chunk test brain).

### Changed
- Keyword search on the Rust engine ranks with the ported `ts_rank`, not BM25, so its scores and order match PGLite's. A search with an offset, a `where` filter or an ISO date window is served instead of refused. A Chinese, Japanese or Korean query, a text search language other than English, `requireSafeChunks`, `minTrust`, `suppressFlagged`, a date that is not an ISO date, and `excludePrivate` on any search but `searchKeyword` still refuse `engine_capability_missing` and write nothing.
- The Rust engine's documentation in `docs/ENGINES.md`, `rust/README.md` and the design notes now says which search and chunk members are served. The parity suite's opt-in Rust arm now has a how-to in `docs/TESTING.md`.

### For contributors
- The PostgreSQL and Snowball sources the search port is built from are credited under `third-party/`, and the checked generators that rebuild its tables and its PostgreSQL 18.6 goldens are in `rust/scripts/`. Reviewers leave the generated golden files out of their diffs.
