**Sync lists open imports in number order past sequence 9, and the projection queue is walked in one byte order of slug on every database, with an index so Postgres does not scan the queue.**

### Fixed
- The sync fence-trend read listed open imports in text order, so sequence 10 came before 9. It now orders by the sequence number.
- The projection queue walk sorted slugs by the database's collation, so PGLite and a Postgres brain with an `en_US` collation visited jobs in different orders. Every queue read now sorts with `COLLATE "C"`.
- The shared projection-window text casts its `ord` column to a number, as the engine copy already did.

### Changed
- Migration v326 builds `idx_page_projection_jobs_slug_c` on `page_projection_jobs (source_incarnation, slug COLLATE "C")`, online on Postgres. Without it the byte-order walk made Postgres read and sort the whole queue: on 300,000 queued jobs the window read took 129.9 ms, against 69.4 ms with the index and 70.4 ms before the byte-order sort.
