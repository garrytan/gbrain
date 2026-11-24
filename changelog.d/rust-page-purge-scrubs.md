**On the Rust engine, a page purge's eval candidate scrub now runs there, and the retrieval, name and cache scrubs answer as an empty store.**

### Added
- On the Rust engine, the scrub of a purged page's name from the eval candidates that cover its source now runs from the store, with the counts PGLite and Postgres give. The retrieval event, rating, weight, volunteer log, gazetteer and query cache scrubs answer zero rows, because the Rust store keeps none of them. The purge itself (`delete_page --purge`) still stops on the Rust engine at its remaining raw SQL steps.

### Changed
- Three more page purge statements now go through typed engine members on every engine (engine-sql/purge-stores.ts) instead of raw SQL: the retrieval and eval candidate scrub, the name store scrub and the query cache clear. The statements are the same text as before.
