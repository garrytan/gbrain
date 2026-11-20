**On the experimental Rust engine, the nightly purge now deletes checkpoints older than seven days, as it does on PGLite and Postgres.**

### Changed
- The purge of stale checkpoints moved from raw SQL into a typed engine member. PGLite and Postgres run the same SQL as before.
- On the Rust engine the purge keeps the same durable records the SQL engines keep, where the Rust store holds the data.

### Fixed
- On the Rust engine the purge now reads a sync delete tombstone's recorded time in the form Postgres stores it, with a time zone offset. Before, it kept such a tombstone even after its page was restored or deleted again.
- On the Rust engine a sync of a changed file now keeps the commit's change reason with the page's old version, as PGLite and Postgres do. Version history reads show it, and a reason a purge removed stays removed.
