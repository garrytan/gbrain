**The atom extraction step of `gbrain dream` now runs on a Rust brain, as it does on Postgres and PGLite.**

### Fixed
- On a Rust brain the extract_atoms phase refused as soon as it had work, because the Rust store kept no record of which pages and transcripts it had already settled. The store now keeps those records (store format 17), so the phase extracts atoms, records completed, failed, tombstoned and cut items, and skips them on the next run. Three failures of the same transcript tombstone it, and a deleted or restored page is offered again, as on Postgres.
- The `extract_atoms_backlog` doctor check on a Rust brain no longer counts a page the phase already settled.

### Changed
- A Rust brain opened by this build moves to store format 17. Older builds refuse it with `format_unknown` and change nothing; upgrade gbrain to open it again. Postgres and PGLite send the same statements as before and are not affected.

### Known gap
- On a Rust brain with a session corpus directory configured (`dream.synthesize.session_corpus_dir`), the phase now refuses by name before any model call instead of skipping every corpus file without a word. Brain pages still extract on a Rust brain without a session corpus, and Postgres and PGLite are not affected. This lasts until the session corpus lookups work on the Rust store.
