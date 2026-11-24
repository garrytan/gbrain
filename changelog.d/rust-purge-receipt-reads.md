**On the Rust engine, the page purge's receipt now checks that the query cache exists and reads the derivation sweep state without stopping.**

### Added
- On the Rust engine, the receipt's check that a relation exists answers true for the tables and views a brain keeps (the query cache among them) and false for any other name, and the derivation sweep state answers none, because the store records no sweep. The purge itself (`delete_page --purge`) still stops on the Rust engine at its remaining raw SQL and receipt reads.

### Changed
- Two more page purge reads now go through typed engine members on every engine (engine-sql/purge-receipt.ts) instead of raw SQL: whether a relation exists and the state of a request's derivation sweep. The statements are the same text as before.
