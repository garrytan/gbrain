**Local pre-merge checks now run each end-to-end test file in its own process, so files that pass alone no longer fail together.**

### Changed
- `.gstack/pregate.json` sets `serial_patterns` to `**/*.serial.test.*` (the default, kept) and `test/e2e/**/*.test.ts`, so gstack's local test lane starts a fresh `bun test` process for every selected end-to-end file instead of running them in one process with the unit tests. End-to-end files share one test database and process-wide state, and running them together made files fail that pass on their own. Each selected end-to-end file adds about 0.2 to 1 second of process start-up to a local run. CI, the remote gate and machines with fewer than 8 cores, where the local lane is handed to the remote gate, are unchanged.
