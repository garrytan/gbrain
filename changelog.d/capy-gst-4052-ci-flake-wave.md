**Three intermittent test failures are fixed at their cause, and the crash robot now records what the page and its facts rows looked like when it reports a facts-fence drift.**

### Fixed
- The zombie-process test in the upgrade-restart supervisor suite no longer fails with ENOENT on `/proc/<pid>/stat`: its background child now stays alive until the holder shell has exec'd `sleep`, so the shell can never reap it first.
- The supervisor configuration test for a worker resumed by the startup timeout signal no longer loses the signal on a slow machine. The worker now registers its SIGTERM handler before it loads the readiness module, and the test uses the production kill grace.
- The sync drain claims test for the live stall line no longer loses its parked step to the owner's lease renewal. The parked preparer now enters the step on its claim-phase clock, as a real preparer does. The `consumer:preparing` fault point now carries that clock.

### Changed
- When the crash robot reports a facts fence that disagrees with its facts rows, the report now says whether the stored page body holds each claim, the revision the read and the stored page carry, the facts rows' ids and row numbers, which page versions held the claim, and the last write requests on the page (#7651).
