**On a Rust brain, the sweep that finishes forgetting a fact for good now runs.**

### Added
- After a fact is forgotten for good, a follow-up sweep walks the stored derived results of the source, deletes the ones that still hold the forgotten claim, checks again until nothing is left, and then deletes its own record. That sweep ran only on Postgres and PGLite. The Rust engine now runs it too, in the same batches and the same order, so a recorded sweep on a Rust brain goes from pending to finished instead of staying pending for good.
- Postgres and PGLite send exactly the SQL they sent before (a test now pins every statement). The Rust engine has no statement time limit and no write lock to wait on, so its sweep never reports "stalled" or "waiting on a lock".

### Changed
- `--status --continue` on a Rust brain still stops before it writes anything, now on the next missing piece of its receipt, named with its owner and due date.
