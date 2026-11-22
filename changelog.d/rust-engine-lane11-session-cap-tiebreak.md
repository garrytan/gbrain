**Every engine now keeps the same sessions when the session-state cleanup trims a burst of sessions, and the cleanup no longer hides an engine that cannot run it.**

### Fixed
- When one transaction writes more sessions than the per-client cap, the cleanup now keeps the sessions with the lowest session ids (by bytes) among those written at the same moment. Before, the database's storage order decided, so PGLite, Postgres and the Rust engine could keep different sessions, and the same brain could keep different sessions after a vacuum.
- The session-state cleanup that delta runs on a session's first call now passes on an engine's capability refusal instead of skipping the cleanup without a word. Other cleanup failures still do not block delta.

<!-- behavior-change: session_cap_tiebreak_lane11 -->
