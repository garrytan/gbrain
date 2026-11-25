**On the Rust engine, the journal sweep and intent redaction of a page purge now run there.**

### Added
- On the Rust engine, a page purge's journal statements (the requests of a slug, the sweep for requests that carry a purged claim, and the redaction of a request's intent, error text and reserved bytes) now run from the store with the rows PGLite and Postgres give. The purge itself (`delete_page --purge`) still stops on the Rust engine at its remaining raw SQL steps.

### Changed
- Seven more page purge statements now go through typed engine members on every engine (engine-sql/page-purge-journal.ts) instead of raw SQL. The journal sweep's two reads keep their preparation deadline. The list of a slug's requests now orders by the numeric sequence on every engine; it ordered by the sequence's text before, which differed once sequences passed one digit.
