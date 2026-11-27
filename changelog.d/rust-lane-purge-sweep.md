**A Rust brain records purged page bodies and refuses to save them again, as PGLite does.**

### Changed
- purging a page on a Rust brain records the page body's tombstone, so the same body cannot be saved again in that source, as on PGLite and Postgres.
- sealing a long page into segments on a Rust brain now indexes the page's timeline only after its purged and withdrawn facts are removed, so title search no longer finds words from those facts, as on PGLite and Postgres.
- importing a page on a Rust brain now drops takes whose claims were purged from the source, and keeps their row numbers reserved, as on PGLite and Postgres.
- a Rust brain now keeps take purge tombstones and refuses to save a purged take claim again.
- a fact purge on a Rust brain still stops before it removes anything, and now its write request and counters are proven to roll back with it, so a stopped purge leaves no queued request behind.
- a fact purge dry run on a Rust brain now lists the raw data rows that still carry the claim by id, as on PGLite and Postgres. A raw data row saved before this change gets its id the next time it is saved; until then the dry run refuses to list it.
