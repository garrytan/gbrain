**The experimental Rust engine now stores and serves config, sources, tags, pages, versions, chunks, keyword search, links, graph and timeline from a brain directory, but nothing selects it yet; PGLite and Postgres brains are unchanged.**

### Added
- Opening a Rust engine now opens the brain directory through the addon, and closing it closes the store. A second engine on the same directory refuses `rust_store_locked`, and a directory the store cannot read refuses `rust_store_unreadable` with a reason (`format_unknown`, `store_corrupt` or `store_io`). `gbrain errors <code>` explains each.
- The Rust engine serves these members on that store with the results PGLite gives: config, sources, tags, pages (including soft delete and restore), page versions, chunks, links, graph traversal and timeline. It reports the `config`, `sources`, `tags` and `schema` capabilities, the ones it now serves completely.
- Keyword search runs on the store with BM25. Its scores and tie order are not the same as PGLite's. It hides the pages PGLite hides, including soft-deleted pages, archived sources, and pages marked with the `quarantine` or `pinned_question` frontmatter key. `docs/ENGINES.md` says what matches and what does not.
- An opt-in Rust arm in the engine parity suite: run it with `GBRAIN_TEST_RUST_ARM=1` after `bun run rust:build`. A case that reaches a member the Rust engine still refuses must stop on that refusal. Every other case must match PGLite unless `test/rust-expected-divergence.tsv` says why not. Without the flag the suite runs as before.

### Changed
- When the Rust engine cannot keep an option or an input, it refuses `engine_capability_missing` and writes nothing instead of dropping it: a chunk that carries a vector (vectors are refused with that typed code for now and arrive in a later release; until then a Rust brain has no vector search), a read of unsealed chunks or embeddings, a keyword search with an offset, `where` or a date window.
- `transaction`, `transactionDirect`, `lockPageKeys` and the belief ledger still refuse on the Rust engine. `docs/ENGINES.md` says why.
