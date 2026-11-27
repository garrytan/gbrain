**On the Rust engine, the deletes and reads a page purge makes in its sweep (proposals, held writes, gate receipts, facts, file records, timeline receipts, segment storage, slug stores and change reasons) now run there.**

### Added
- On the Rust engine, the review queue, review proposal and decide proposal deletes of a fact purge, and the trust proposal, held write, gate receipt, fact, file, segment and slug-store deletes of a page purge, now run from the store with the counts and rows PGLite and Postgres give. The purge itself (`delete_page --purge`) still stops on the Rust engine at its remaining raw SQL steps (the query cache, the journal redaction and the generation ledger).

### Changed
- Eleven more page purge statements now go through typed engine members on every engine (engine-sql/page-purge-sweep.ts) instead of raw SQL, with the SQL text unchanged. Statements that had no order of their own now list in a fixed order on every engine, and a purge receipt on a brain with no secret store reports 0 for both secret store counts.
