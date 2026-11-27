**Remote callers no longer count private pages they cannot read in pending_pages, so mention coverage no longer tells them that a private page exists.**
<!-- behavior-change: remote_coverage_private_pages -->

### Fixed
- Mention coverage (the `coverage` field of get_backlinks and the entity card, and the `mention_index` notice of entity-names and of a search that names an entity) said how many pages were not yet scanned for entity names. For a caller that may not read private pages (a remote MCP caller), that count included the private pages. A new private page raised the count by one, or turned a `complete` index `pending`, so the caller learned that the page exists. Now remote callers no longer count private pages they cannot read in pending_pages: the count is the same whether a private page exists or not. A source with a saved count above 0 gets a count of only the pages the caller may read, and that count is never saved. Local CLI callers count every live page, as before. This applies on PGLite, Postgres and the Rust engine.
- One case stays: when a private page's name changes, the index reads `pending` for every caller until the next mention pass saves it.
