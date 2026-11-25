**A Rust brain answers reads that name a source, and refuses an unscoped remote read that can see nothing, like PGLite and Postgres.**

### Changed
- The "is this source live" check that every read naming a source runs (get_page, search, query, list_pages, recall) now reads the source row through a typed engine call. On a Rust brain those reads used to stop on a raw SQL refusal.
- The `sources_not_readable` check of an unscoped remote read is a typed engine call, `readSourcesNotReadable`, on all three engines. PGLite and Postgres send the same statement as before. On a Rust brain the check used to fail silently, so a remote recall or query that could see nothing answered empty instead of naming the problem.
- Tests: `test/engine-parity/source-scope-reads.test.ts` checks both through the MCP dispatcher on every engine arm, and fails a Rust case that caught a refusal on the way.
