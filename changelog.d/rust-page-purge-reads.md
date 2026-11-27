**On the Rust engine, the reads a page purge makes before it deletes (a page's claims, its link streams, its queued purges, its stored versions) and the tombstone commands `gbrain pages purges list` and `gbrain pages unpurge` now work.**

### Added
- On the Rust engine, `gbrain pages purges list` and `gbrain pages unpurge <slug>` answer as on PGLite and Postgres, and the reads that prepare a page purge (the facts filed on or extracted from the page, its takes, the belief streams of its links, the queued purges behind it, its versions and what a delete cascades) now run there. The purge itself (`delete_page --purge`) still stops on the Rust engine at its later raw SQL steps.

### Changed
- Seventeen page purge statements now go through typed engine members on every engine (engine-sql/page-purge.ts) instead of raw SQL, with the SQL text unchanged. Statements that had no order of their own now list in a fixed order on every engine.
