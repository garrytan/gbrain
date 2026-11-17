**Search results on Postgres brains now mark a page stale when it has a timeline entry newer than the page, the same as on PGLite.**

<!-- behavior-change: postgres_search_stale_parity -->

### Fixed
- Behavior change: the `stale` field of a search result (for example in `gbrain search --json`) was always false on Postgres, while PGLite set it to true when a page had a timeline entry created after the page was last updated. Postgres now uses the same rule in the keyword, keyword-chunk, title and vector search arms, so Postgres users can now see `stale: true` where they saw false before. Result order and ranking do not change. The check runs once per returned row, through the existing timeline index; on a 3,000-page test brain it added about 0.2 ms to a 20-row search.
- A restricted Postgres read role now needs `SELECT` on `timeline_entries` to search, because the `stale` check reads it. The read-role recipe in `docs/ENGINES.md` now grants it. A role set up from the old recipe gets a permission error from search until you run `GRANT SELECT ON timeline_entries TO <reader-role>;`.
- A new test runs the same three pages (no timeline, an older timeline entry, a newer one) through both engines and requires the same `stale` value from every search arm.
