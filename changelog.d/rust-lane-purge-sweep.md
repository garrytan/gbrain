**A Rust brain records purged page bodies and refuses to save them again, as PGLite does.**

### Changed
- purging a page on a Rust brain records the page body's tombstone, so the same body cannot be saved again in that source, as on PGLite and Postgres.
