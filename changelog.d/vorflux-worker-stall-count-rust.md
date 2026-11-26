**An idle minion worker on a Rust brain now stays alive past its stall warning time, as it does on Postgres and PGLite.**

### Fixed
- A minion worker on a Rust brain that sat idle longer than `stallWarnAfterMs` (5 minutes by default) used to stop as `db_dead`, because its stall check counted waiting jobs with raw SQL the Rust engine refuses. The count is now the typed read `countWaitingJobsForNames(queue, names)`, which the Rust store answers by walking its waiting-job index one row at a time. Postgres and PGLite send the same statement as before.
