**New brains suggest one useful thing in their first sessions, and a second agent session on the same brain is told nothing is broken.**

### Added
- For the first 3 sessions within 14 days of `gbrain setup claude-code` or `gbrain setup codex` on a new personal brain, the session-start context tells the agent to offer one thing it found in the brain, citing the page, then one more import. A session counts only after the hook wrote the context that held it; Claude Code and Codex at once each get their own session.
- `gbrain onboarding status|off` and the MCP tools `onboarding_status` and `onboarding_off` (the install's owner only; `onboarding_owner_only` otherwise) say why it shows and turn it off, read back from the store. `setup --no-suggestion` turns it off at install, and `setup --json` reports a `suggestion` marker next to `history`.
- The company brain instruction block tells the agent to name the readers of a team decision with `readable_by`.

### Fixed
- A second agent session on a PGLite brain another session's server holds gets a `gbrain_status` answer that names the owner's PID and start time, carries `expected: true` and says nothing needs fixing.
- `gbrain onboarding --help` prints its help without a brain.

<!-- behavior-change: first_session_suggestion -->
<!-- behavior-change: lock_held_concurrent_expected -->
