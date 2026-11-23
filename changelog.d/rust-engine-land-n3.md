**The alias, export, belief-coverage, jobs-health, trust-tier and withdrawal-discovery reads now sit behind engine members, and the queue-health reads run on the opt-in Rust engine.**

### Changed
- The read queries behind alias lookup, the export commands, the belief coverage report, the search-vector reindex count, queue and job health, trust-tier version lookups and withdrawal discovery now live in `src/core/engine-sql/` and are called through new `BrainEngine` members on PGLite, Postgres and the opt-in Rust engine. The callers call the members instead of running the SQL themselves. PGLite and Postgres brains return the same rows as before; the callers moved to the members and the SQL text did not change.
- On the Rust engine the eight queue-health members work. The other new members are held on the Rust engine until its store wiring lands, and they refuse there instead of guessing.
- No write, schema, sync caller, access-token or member-binding read changed. The reads that carry a visibility filter, and the rest of the dynamic-SQL reads, stay where they are until a later slice.
