**On an experimental Rust brain, a serve or worker now starts the commit notifier: it claims the host lease and lists the brain's sources. PGLite and Postgres brains send the same SQL as before.**

### Changed
- The notifier's host lease and its source list are typed engine calls: `claimNotifierLease`, `readNotifierLease`, `holdsNotifierLease` (the check before each start), `releaseNotifierLease` (a clean stop) and `listNotifierHostSourceRows`. Postgres and PGLite send the same SQL text as before, byte for byte, from `src/core/engine-sql/notifier.ts`.
- On a Rust brain the lease is one record per host, with the same fence rules as Postgres: the first claim wins, a renewal keeps the fence, and a takeover after expiry bumps it. A release expires only the caller's own lease. Each lease change is one store write. A host id with a NUL byte is refused.
- The notifier's other reads and writes still refuse on a Rust brain. The notifier logs each refusal once and keeps running. Search freshness still reports no source on a Rust brain.
- On a Rust brain with waiting jobs and no worker, the readiness fix now says the job supervisor keeps a worker running "for this brain", not "for this Postgres brain". PGLite and Postgres text is unchanged.

### Added
- Caller tests on all three engines for the backup coverage check and the readiness worker and sync probes, and one that pins the worker fix text on each engine.
