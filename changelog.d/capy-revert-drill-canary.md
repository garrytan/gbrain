**Adds a placeholder test used to time a revert.**

### Added
- `test/revert-drill-canary.test.ts`: one always-passing test. It lands only to be reverted, so the time from deciding a landing is bad to a merged revert can be measured before PRs land without containing current master.
