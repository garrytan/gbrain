**On the experimental Rust engine, a vector search with source boosts reads only the pages that can rank, so its slowest searches get much faster. Results are the same.**

### Changed
- A Rust vector search used to bound every page with the largest source boost, so with boosts on (the default) it could read thousands of pages that could never reach the results. Each page now keeps a small rank key (its slug and whether it is an unverified extraction stub) in the store's keyed index, kept current by every page write in the same transaction, and the search bounds each page by its own boost. A page without a rank key is bounded as before. Rows, scores, tie order and filters are unchanged. PGLite and Postgres are unchanged.
- The Rust store moves to format 10. A brain opened by this build rebuilds its keyed index once, in one transaction; a failed rebuild leaves the brain as it was. An older Rust build refuses a format-10 brain instead of leaving its rank keys stale.
