**On the experimental Rust engine, the nightly purge now deletes checkpoints older than seven days, as it does on PGLite and Postgres.**

### Changed
- The purge of stale checkpoints moved from raw SQL into a typed engine member. PGLite and Postgres run the same SQL as before.
- On the Rust engine the purge keeps the same durable records the SQL engines keep, where the Rust store holds the data.
