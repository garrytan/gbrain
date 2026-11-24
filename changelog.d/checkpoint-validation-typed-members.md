**The sync checkpoint's validation reads now run on a Rust brain through typed engine members.**

### Changed
- The checks that decide whether a managed sync checkpoint or pass stamp may commit (the blocking receipt, the open pass work and the `sync status` list of blocking receipts) are now engine members served on PGLite, Postgres and the Rust engine instead of raw SQL. The SQL and the `checkpoint_validation_timeout` refusal on PGLite and Postgres are unchanged.
