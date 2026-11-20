**On the experimental Rust engine, the nightly purge now deletes checkpoints older than seven days, as it does on PGLite and Postgres.**

### Changed
- The purge of stale checkpoints moved from raw SQL into a typed engine member. PGLite and Postgres run the same SQL as before.
- On the Rust engine the purge keeps the same durable records the SQL engines keep, where the Rust store holds the data.

### Fixed
- On the Rust engine the purge now reads a sync delete tombstone's recorded time in the form Postgres stores it, with a time zone offset. Before, it kept such a tombstone even after its page was restored or deleted again.
- On the Rust engine a sync now extracts links and timeline entries as PGLite and Postgres do. Before, the extraction stopped on an unsupported-SQL error when it read the old slugs of renamed pages, and the sync told you to run `gbrain extract --stale` afterwards.
