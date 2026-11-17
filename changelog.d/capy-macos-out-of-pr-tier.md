**Pull-request pushes no longer wait for a macOS runner, and a master push that reuses a passed full run skips its macOS security check.**

### Changed
- `.github/workflows/test.yml`: the macos-26 cell of `security-regressions` is left out of a pull request's cheap tier and of a master push that reuses a passed full run of its exact tree. The full-ci dispatch, a master push that runs in full, the merge queue and the nightly Test schedule still run it.
- `.github/workflows/native-locks.yml`: a pull request runs no darwin-arm64 or darwin-x64 cell (and no darwin-x64 heartbeat finalize); every other event runs them as before.
- Why: macOS runners are scarce. In the busiest hours of 2026-11-16 to 11-17 macOS jobs waited a median of 4 to 9 minutes and up to 35 minutes before starting, and pull-request pushes started about half of the roughly 1,380 macOS jobs a day. A macOS-only break now shows up at the full-ci run before landing rather than on the first push. docs/ci-event-parity.md, "macOS runners", says so.
