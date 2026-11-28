**Shadow mode now reaches and keeps a valid coverage watermark when the brain is only used through short serve sessions, such as MCP stdio sessions that last 10 to 20 seconds.**

### Fixed
- Every session that owned the shadow store started with an invalid watermark, and the full reconcile pass that proves it again ran only a minute after start, so a session shorter than that never ended valid and the swap check's clean-reconcile count never grew. A session that closed during a pass also recorded a failed pass, which reset that count.
- The first reconcile check now runs 5 seconds after a serving process starts. A full pass saves its progress after every interval; a session that closes during a pass records no pass, and the next session with the same continuity, seed and evidence epoch finishes it. Only a finished full pass is recorded and counted.
- A serving process that closes with everything handed over and applied seals the follower. The next session carries the watermark on only when the follower files are unchanged and, on Postgres, the writer evidence of every other connection, the coverage gaps and the writer hooks are exactly as they were at the seal. Any doubt, read failure or timeout leaves the watermark invalid until a full pass, as before. On PGLite only the file checks apply.
- Eight named persistence-journal members (`declarePersistence` and the journal's counter, completion, effect and lock members) no longer invalidate the whole watermark: they publish the tables their statements write. `onCheckout`, a pool listener that sends no statement, is ignored. Every other member the write map does not cover still invalidates it.

<!-- behavior-change: shadow_short_session_watermark -->
