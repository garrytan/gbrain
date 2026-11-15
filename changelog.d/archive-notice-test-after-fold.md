**The upgrade-notice test for the conversation archive keeps passing after a release folds its changelog entry (#9437).**

### Fixed
- `test/upgrade-transcript-archive-notice.test.ts` no longer reads the `changelog.d` fragment that every release deletes, so the full test suite passes on a release commit again. Tests only; no behavior change.
