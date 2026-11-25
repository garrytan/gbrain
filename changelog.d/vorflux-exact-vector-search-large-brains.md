**Postgres brains can turn on an exact vector scan, so meaning-based search stops losing good matches as a brain grows.**

### Added
- `gbrain config set search.vector_exact_max_chunks 150000` makes hybrid search on a Postgres brain with at most 150,000 chunks check every eligible chunk instead of asking the HNSW index, then rank the results the same way. At 50,000 pages the index kept about 68% of an exact scan's search quality (nDCG@5 35.0 against 51.3), and raising `ef_search` did not close the gap.
- It is off by default (`0`). The exact scan is slower. It took about 570 ms at 150,000 chunks against under 10 ms for the index, and about 2.5 times slower whole searches at 50,000 pages. A scan that runs past 2 s, or a brain whose chunk count is unknown or above the setting, uses the index as before. Filters, private pages and deleted pages are applied inside the scan, so no result breaks its filter.
- `gbrain doctor`'s vector plan check reports the setting and says when it covers the brain. PGLite and the Rust engine do not change.
