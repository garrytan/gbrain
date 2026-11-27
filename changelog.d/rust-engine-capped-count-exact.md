**Search now reports the same count of waiting pages that could affect a query on PGLite, Postgres and the Rust engine, whatever order the pages were written in.**

<!-- behavior-change: search_coverage_exact_capped_count -->

### Fixed
- When 1000 or more pages in a search's scope were still waiting for indexing, search counted how many of them could affect the query among an unordered first 1000 pages. The same pages could give different counts depending on the order they were written in, and PGLite and Postgres could disagree (for example 2 and 4 when the right answer was 5). Each count (waiting pages, pages that could affect the query, and waiting images among them) is now the exact number of matches in scope, stopped at 1000, so every engine gives the same answer. A count that takes longer than 2 seconds reports as unknown instead of holding the search.
- The Rust engine served search on such a brain by refusing the capped count; it now returns the same count as Postgres.

### Changed
- A new migration (v340) adds a trigram index over the title and slug of the pages waiting for indexing, so Postgres finds the few pages a query word matches without testing every waiting page. Postgres builds it concurrently; the index is empty once indexing catches up.
