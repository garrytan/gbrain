**The experimental Rust engine's store now serves vector search, embeddings, link and graph reads, takes, salience, stats and the ingest log the way PGLite does, but nothing selects it yet; PGLite and Postgres brains are unchanged.**

### Added
- The Rust engine serves `searchVector` and `searchTakesVector` (an exact scan over the stored vectors, scored as pgvector scores them) and the embedding members, and `upsertChunks` and `sealChunks` store the vector a chunk carries. It reports the `vector_search`, `embeddings`, `links`, `graph`, `takes`, `salience` and `ingest_log` capabilities (`rust/docs/store/vectors.md`, `embeddings.md`).
- The Rust engine serves the link reads, alias and slug members, the take members, salience, `getStats`, `getHealth`, the ingest log, the extraction reads and the page-listing reads (`rust/docs/store/`). A caller that asks for `excludePrivate` gets the pages PGLite hides, including a page of an owner-only source.

### Changed
- A chunk that carries an image vector, and a brain whose config names a vector column other than `embedding`, still refuse with `engine_capability_missing`; the store keeps one vector column.
