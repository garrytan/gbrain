**Published release notes now open with one line per change and the pull request that made it.**

### Changed
- The release workflow puts a list at the top of each GitHub release: one line per change the release folds, taken from the change's changelog entry, with its pull request number. A release that never published is listed in the next one. CHANGELOG.md is unchanged.
- `bun run verify` fails when a test reads a `changelog.d` file from the repository, because the next release deletes that file and the test breaks.
- `changelog.d/README.md` says every pull request needs a changelog entry, a tests-only one included.
