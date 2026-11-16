**A release's list of changes shows each change's headline alone, even when its changelog entry continues on the headline's line.**

### Fixed
- `scripts/changelog-entry.sh --pr-list` cuts each fragment's first bold line at its closing `**`. Before, a fragment whose body text followed the headline on the same line put that whole paragraph, with a stray `**`, into the release notes.

### For contributors
- `test/release-workflow.test.ts` covers a fragment with body text after its headline.
