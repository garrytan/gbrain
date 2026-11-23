**The Rust engine swap check can now tell how many machines write your brain: while shadow mode runs, each writing gbrain process notes itself in a new table.**

### Added
- `engine_writer_observations` (schema migration): one row per writing process while Rust engine shadow mode is on (host id, connection name, command kind, version, first and last write), refreshed at most every 10 minutes after a committed write. A brain without a shadow keeps it empty and gains no write.
- The shadow status document's `eligibility` fields for the swap check: `writer_hosts_7d` and `unknown_writer_paths` (filled only when the caller passes the open brain; `gbrain engine shadow status` never opens the database), `team_brain` and `preview_target` (a release addon target: linux-x64-glibc or darwin-arm64). A failed read leaves the writer fields out and adds `eligibility_evidence` with the error code only.

### Changed
- `gbrain engine shadow start --plan` now lists the observation write; plan hashes from before this change no longer match, so confirm the new plan.

<!-- behavior-change: engine_writer_observations_s5 -->
