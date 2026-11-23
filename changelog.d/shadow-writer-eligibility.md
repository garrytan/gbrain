**The Rust engine swap check can now tell how many machines write your brain: while shadow mode runs, gbrain records which processes and database connections write it.**

### Added
- `engine_writer_observations`, `engine_writer_sessions` and `engine_writer_coverage_gaps` (schema migration): empty unless Rust engine shadow mode is on. Each writing gbrain process notes itself (host id, connection name, command kind, version, first and last write) at most every 10 minutes after a committed write.
- On a Postgres brain, `gbrain engine shadow start --yes` adds one statement-level trigger to every brain table that records each writing connection, at most every 10 minutes per connection; it never fails a write and waits at most 50 ms on its own tables (an error becomes a gap row). `gbrain engine shadow stop` removes them, including any a killed start or crashed stop left. PGLite brains are not hooked.
- The shadow status document's `eligibility` fields for the swap check: `writer_hosts_7d` and `unknown_writer_paths` (filled only when the caller passes the open brain; `gbrain engine shadow status` never opens the database), `team_brain` and `preview_target` (a release addon target: linux-x64-glibc or darwin-arm64). A failed read leaves the writer fields out and adds `eligibility_evidence` with the error code only.

### Changed
- `gbrain engine shadow start --plan` now lists these writes; plan hashes from before this change no longer match, so confirm the new plan.
- `gbrain engine shadow stop` exits 1 when it could not remove the writer hooks (the database was unreachable), and says to run it again.

<!-- behavior-change: engine_writer_observations_s5 -->
