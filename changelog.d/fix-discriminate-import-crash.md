**The discrimination helper no longer reports a test file that fails to import as a test that discriminates.**

### Fixed
- `scripts/check-test-discriminates.sh` and `bun run audit:contributors` read bun's `N fail` summary, which also counts an unhandled error between tests. When a fix adds a new module and its test imports it, reverting the fix removes the module; the test file then fails to import (`0 pass / 1 fail / 1 error`, no test run) and both tools reported it as discriminating. They now count only tests that ran and failed (`(fail)` lines), so that run is a vacuous failure (exit 3 / `vacuous_failure`), and the helper says an unresolved import is the usual cause.
