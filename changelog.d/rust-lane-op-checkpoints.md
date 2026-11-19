**On the experimental Rust engine, a long-running operation that stops midway now resumes where it stopped, as it does on PGLite and Postgres.**

### Changed
- The checkpoint writes of resumable operations (record, append, clear) moved from raw SQL into four typed engine members. PGLite and Postgres run the same SQL as before.
- The Rust store now keeps each operation's finished keys, so a rerun skips them.
- On the Rust engine, the nightly purge of checkpoints older than seven days does not run yet: a checkpoint that no run clears stays.
