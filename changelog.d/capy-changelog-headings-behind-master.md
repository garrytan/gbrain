**A pull request that is behind master's newest release no longer fails `verify`.**

### Fixed
- `check:changelog-headings` (in `bun run verify`) refused every branch whose CHANGELOG.md lacked a release heading that master has. Since pull requests carry no version and may land without containing current master, every such branch failed `verify` as soon as a release landed. The check now skips the release headings newer than the branch's own VERSION, which the merged tree carries, and still refuses a branch that dropped a heading at or below its VERSION, so a cut-off changelog is still caught.
