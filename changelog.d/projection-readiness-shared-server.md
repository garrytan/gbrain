**On Postgres, search now reuses its "are all pages indexed" answer while other databases on the same server are busy, and never reuses an answer while a page write is still uncommitted.**

### Fixed
- The search readiness check on Postgres stopped reusing its answer whenever any transaction anywhere on the server held a transaction id: another brain's database, a job queue update or a hosted platform's own tables. Each search then ran the readiness probe again. The check now turns reuse off only while another session holds a write lock on this brain's `pages` table, or while the caller's own transaction has written.
- The old check could also reuse an answer that missed a page write another session had not yet committed, when that write was the newest transaction on the server: after the commit, search kept saying every page was indexed. That write now turns reuse off, so the answer after the commit is read again. PGLite runs the same check, where only its own transaction can be writing. The Rust engine is unchanged.

### Added
- Postgres tests for which open transactions turn reuse off, and a parity case that holds a transaction open in another database while the probe reuses its answer.
- A parity case on all three engines for a drain holder that holds a live lease with no progress for the stall window: the resident notifier reads it as stalled.
