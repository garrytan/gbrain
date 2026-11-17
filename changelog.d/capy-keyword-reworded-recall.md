**Keyword search finds the people behind a reworded relationship question again.**

### Fixed
- On a brain with no embedding provider, a question that names a company in words its people's pages don't use ("Who is on the payroll at Acme?") returned the company page and little else. Since v0.60.338.0 (#7135) the title step's any-word retry read page titles only, so it no longer saw the people whose dated timeline names the company. For a local caller the retry now reads titles and timelines again while at most 5,000 pages match the question's words, and titles only past that, so a date or a very common word in a question still can't pull every dated timeline into ranking. Remote MCP callers are unchanged.
- On the public one-hop relationship set (870 keyless rows), recall at 5 for reworded questions went from 0.381 to 0.573 with relational retrieval off and from 0.512 to 0.661 with it on, on both PGLite and Postgres.
- On a 1,000,000-page Postgres brain the retry adds one bounded statement, 0.03 to 0.14 s in the cases measured.

<!-- behavior-change: title_retry_reads_timelines_gst2899 -->
